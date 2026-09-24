# 저장 스크립트 자가 수리 — 실패하면 AI 가 고쳐 이어 가고, 검증 통과한 코드만 저장한다
import json

import httpx
import pytest
import respx

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import (
    BuyerAgent,
    numeric_overlap_options,
    resolve_choice,
    snapshot_problem,
)
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.repair import FileScriptSource, RepairOutcome, ScriptHistory, ScriptRepairer
from samba_agent.repair.agent import check_candidate, hardcoded_amounts, parse_output
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


class FakeRepairer:
    """수리 결과를 정해 두고 호출 인자를 기록한다."""

    def __init__(self, outcome: RepairOutcome) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, object]] = []

    def repair(self, **kw: object) -> RepairOutcome:
        self.calls.append(kw)
        return self.outcome


@pytest.fixture(autouse=True)
def bridge_mock():
    """모든 시험에서 브릿지를 가로챈다. 진행 보고(progress)는 늘 성공."""
    with respx.mock:
        respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
        yield


@pytest.fixture()
def buyer(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    spec = reg['buyer.musinsa']
    agent = BuyerAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: None,  # type: ignore[arg-type,return-value]
    )
    agent._dry_run = False
    agent.reset_repairs()
    scripts = tmp_path / 'site-scripts.json'
    scripts.write_text(
        json.dumps(
            [
                {
                    'name': 'x_snap',
                    'host': 'x.com',
                    'description': 'd',
                    'params': ['sku'],
                    'code': 'return 1',
                }
            ]
        ),
        encoding='utf-8',
    )
    agent.script_source = FileScriptSource(scripts)
    agent.script_history = ScriptHistory(tmp_path / 'hist')
    return agent


def ok_check(o: dict[str, object]) -> str | None:
    return None if o.get('cost') else '원가 없음'


def test_passing_script_never_calls_ai(buyer) -> None:
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('{"cost": 100}'))
    fake = FakeRepairer(RepairOutcome('gave_up', 'x'))
    buyer.repairer = fake
    assert buyer.script_json('x_snap', {'sku': '1'}, goal='g', check=ok_check) == {'cost': 100}
    assert fake.calls == []


def test_failed_check_is_repaired_saved_and_backed_up(buyer, tmp_path) -> None:
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('{"cost": 0}'))
    save = respx.post(f'{URL}/tool/save_script').mock(return_value=page('updated: x_snap'))
    fake = FakeRepairer(RepairOutcome('fixed', 'ok', {'cost': 777}, 'return {cost:777}', 2))
    buyer.repairer = fake
    out = buyer.script_json('x_snap', {'sku': '1'}, goal='g', check=ok_check)
    assert out == {'cost': 777}
    # AI 에게 원본 코드와 실패 사유가 넘어간다
    assert fake.calls[0]['current']['code'] == 'return 1'  # type: ignore[index]
    assert fake.calls[0]['problem'] == '원가 없음'
    # 원래 설명·인자 설명을 지킨 채 새 코드로 저장한다
    body = json.loads(save.calls[0].request.content)['args']
    assert body['code'] == 'return {cost:777}'
    assert body['description'] == 'd' and body['params'] == ['sku']
    # 교체 전 원본은 이력 폴더에
    files = sorted(p.name for p in (tmp_path / 'hist' / 'x_snap').iterdir())
    assert any(f.endswith('-before.js') for f in files)
    assert any(f.endswith('-after.js') for f in files)


def test_exception_is_repaired(buyer) -> None:
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('Error: boom'))
    respx.post(f'{URL}/tool/save_script').mock(return_value=page('updated: x_snap'))
    buyer.repairer = FakeRepairer(RepairOutcome('fixed', 'ok', {'cost': 5}, 'return 5', 1))
    assert buyer.script_json('x_snap', {}, goal='g', check=ok_check) == {'cost': 5}


def test_genuine_keeps_original_result(buyer) -> None:
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('{"cost": 0}'))
    save = respx.post(f'{URL}/tool/save_script')
    buyer.repairer = FakeRepairer(RepairOutcome('genuine', '옵션 실제 품절'))
    assert buyer.script_json('x_snap', {}, goal='g', check=ok_check) == {'cost': 0}
    assert not save.called
    assert any('스크립트 문제 아님' in e.detail for e in buyer.evidence)


def test_gave_up_reraises_original_failure(buyer) -> None:
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('Error: boom'))
    buyer.repairer = FakeRepairer(RepairOutcome('gave_up', 'x'))
    with pytest.raises(AgentFailure):
        buyer.script_json('x_snap', {}, goal='g', check=ok_check)


def test_captcha_is_not_repaired(buyer) -> None:
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('needs_user: captcha'))
    fake = FakeRepairer(RepairOutcome('fixed', 'ok', {'cost': 5}, 'return 5', 1))
    buyer.repairer = fake
    with pytest.raises(AgentFailure) as e:
        buyer.script_json('x_snap', {}, goal='g', check=ok_check)
    assert e.value.fail_reason is FailReason.CAPTCHA
    assert fake.calls == []


def test_one_repair_attempt_per_script_per_job(buyer) -> None:
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('{"cost": 0}'))
    fake = FakeRepairer(RepairOutcome('gave_up', 'x'))
    buyer.repairer = fake
    buyer.script_json('x_snap', {}, goal='g', check=ok_check)
    buyer.script_json('x_snap', {}, goal='g', check=ok_check)
    assert len(fake.calls) == 1
    buyer.reset_repairs()
    buyer.script_json('x_snap', {}, goal='g', check=ok_check)
    assert len(fake.calls) == 2


def test_snapshot_problem_checks_option_and_cost() -> None:
    check = snapshot_problem('EU 그린 EU 44 · KR 285')
    assert (
        check({'options': ['285'], 'cost': 1000, 'methods': ['무신사머니'], 'selected': '285'})
        is None
    )
    # 주문서에 실제로 담긴 옵션을 안 돌려주면 수리 대상(실기: 110 주문에 105 가 담김)
    assert 'selected' in (
        check({'options': ['285'], 'cost': 1000, 'methods': ['무신사머니']}) or ''
    )
    strict = snapshot_problem('블랙 110', lambda sel: '110' in sel)
    assert '다르다' in (
        strict(
            {
                'options': ['105', '110'],
                'cost': 1,
                'methods': ['무신사머니'],
                'selected': 'BLK0 · 105',
            }
        )
        or ''
    )
    # 사이즈 숫자가 하나도 안 겹치면 스크립트가 엉뚱한 목록을 읽은 것 — 수리 대상
    assert '맞는 선택지가 없다' in (
        check(
            {'options': ['270', '275'], 'cost': 1000, 'methods': ['무신사머니'], 'selected': '270'}
        )
        or ''
    )
    assert '원가' in (
        check({'options': ['285'], 'cost': 0, 'methods': ['무신사머니'], 'selected': '285'}) or ''
    )
    assert check({'already_ordered': True}) is None
    # 숫자 없는 옵션(색·S)은 표기 차이를 하네스 AI 매칭이 맡는다 — 빈 목록만 수리 대상
    color = snapshot_problem('상아색 S')
    assert (
        color(
            {
                'options': ['IVORY / S'],
                'cost': 1000,
                'methods': ['무신사머니'],
                'selected': 'IVORY / S',
            }
        )
        is None
    )
    assert color({'options': [], 'cost': 1000, 'methods': ['무신사머니'], 'selected': 'IVORY / S'})

    # 결제수단을 안 읽으면 수리 대상(실기: 29CM 주문서의 무신사머니·무신사페이를 [] 로 읽음)
    assert 'methods' in (check({'options': ['285'], 'cost': 1000, 'selected': '285'}) or '')


def test_numeric_overlap_and_choice_resolution() -> None:
    opts = ['712(59.6cm)', '714(57.7cm)', '718(56.8cm)', '734(61.5cm)']
    wanted = '레오파드 색상 7 1/8（56.8cm） 미국 버전 포장 미포함'
    assert numeric_overlap_options(opts, wanted) == ['718(56.8cm)']
    # 230 주문에 220 을 고르는 사고 — 숫자가 안 겹치면 AI 후보에서 빠진다
    assert numeric_overlap_options(['220', '225'], '230') == []
    assert numeric_overlap_options(['S [품절]', 'M'], '상아색 S') == ['M']
    assert resolve_choice('BLACK, ONE', ['BLACK / ONE', 'WHITE / ONE']) == 'BLACK / ONE'
    assert resolve_choice('없음', ['BLACK / ONE']) is None


def test_candidate_guard_blocks_payment_and_long_or_hardcoded_code() -> None:
    assert check_candidate("await page.clickText('결제하기')")
    assert check_candidate("location='https://money.musinsapayments.com'")
    assert check_candidate('x'.ljust(8001, 'x'))
    assert check_candidate('const no="213152056133"')
    assert check_candidate("await page.clickText('구매하기'); return {}") is None


def test_parse_output_strips_page_dialogs() -> None:
    parsed, problem = parse_output('page dialog: "옵션을 선택해 주세요"\n{"a": 1}')
    assert parsed == {'a': 1} and problem == ''
    assert parse_output('Error: x')[0] is None


def test_repairer_loop_uses_only_validated_code(monkeypatch) -> None:
    """가짜 모델: 틀린 코드 → FAIL, 고친 코드 → PASS. PASS 한 코드와 결과만 나온다."""
    import claude_agent_sdk

    captured: dict[str, object] = {}
    real_server = claude_agent_sdk.create_sdk_mcp_server

    def spy_server(name, version='1.0.0', tools=None):
        captured['tools'] = {t.name: t for t in tools or []}
        return real_server(name, version, tools)

    monkeypatch.setattr(claude_agent_sdk, 'create_sdk_mcp_server', spy_server)
    ran: list[str] = []

    def call(tool: str, args: dict[str, object]) -> str:
        assert args.get('safety') == 'no_pay'  # 앱 결제 버튼 차단을 늘 켠다
        code = str(args['code'])
        ran.append(code)
        return '{"cost": 0}' if 'bad' in code else '{"cost": 900}'

    async def fake_query(prompt, options):
        tools = captured['tools']
        r1 = await tools['test_script'].handler({'code': 'return "bad"'})  # type: ignore[attr-defined]
        assert 'FAIL' in r1['content'][0]['text']
        r2 = await tools['test_script'].handler({'code': 'return "good"'})  # type: ignore[attr-defined]
        assert 'PASS' in r2['content'][0]['text']
        blocked = await tools['run_js'].handler({'code': "page.clickText('결제하기')"})  # type: ignore[attr-defined]
        assert '금지' in blocked['content'][0]['text']
        yield object()

    rep = ScriptRepairer(query_fn=fake_query, timeout_s=30)
    out = rep.repair(
        call=call,
        name='x_snap',
        args={'sku': '1'},
        goal='g',
        problem='p',
        last_output='',
        validate=ok_check,
        current=None,
    )
    assert out.status == 'fixed'
    assert out.code == 'return "good"'
    assert out.output == {'cost': 900}
    assert out.tests == 2
    # 시험 실행에는 이번 주문 인자가 앞에 붙고, 금지 코드는 브릿지로 나가지도 않는다
    assert ran[0].startswith('args={"sku": "1"};')
    assert all('결제하기' not in c for c in ran)


def test_hardcoded_amounts_are_caught() -> None:
    assert hardcoded_amounts('return {cost: 46370}', {'cost': 46370}) == ['46370']
    assert hardcoded_amounts("const t='46,370원'", {'cost': 46370}) == ['46,370']
    assert hardcoded_amounts('return {cost: num(m[1])}', {'cost': 46370}) == []
    # 작은 수(수량·대기 ms)는 보지 않는다
    assert hardcoded_amounts('await sleep(700)', {'qty': 700}) == []


def test_match_options_uses_ai_only_within_numeric_pool(buyer) -> None:
    from samba_agent.agents.base import Decision

    asked: list[str] = []

    def decide(prompt, model):
        asked.append(prompt)
        return Decision(choice='718(56.8cm)', reason='7 1/8 = 718')

    buyer._decide = decide
    opts = ['712(59.6cm)', '718(56.8cm)']
    wanted = '레오파드 색상 7 1/8（56.8cm）'
    assert buyer._match_options(opts, wanted) == ['718(56.8cm)']
    # 같은 질문은 작업 안에서 다시 묻지 않는다(계정 4개 비교)
    assert buyer._match_options(opts, wanted) == ['718(56.8cm)']
    assert len(asked) == 1
    # 모델이 후보 밖(숫자 안 겹치는 712)을 골라도 받아 주지 않는다
    buyer._decide = lambda p, m: Decision(choice='712(59.6cm)', reason='가까움')
    assert (
        buyer._match_options(['712(59.6cm)', '718(56.8cm)'], '레오파드 7 1/8（56.8cm） 포장') == []
    )


def test_missing_script_is_created_by_ai(buyer) -> None:
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('refused: no saved script named "cm29_set_shipping"')
    )
    respx.post(f'{URL}/tool/save_script').mock(return_value=page('saved: cm29_set_shipping'))
    fake = FakeRepairer(RepairOutcome('fixed', 'ok', {'cost': 1}, 'return {cost:1}', 1))
    buyer.repairer = fake
    assert buyer.script_json('cm29_set_shipping', {}, goal='g', check=ok_check) == {'cost': 1}
    assert '처음부터' in str(fake.calls[0]['problem'])


def test_shipping_set_problem_needs_phone_field() -> None:
    from samba_agent.agents.buyer import shipping_set_problem

    ship = {'name': '홍길동', 'address': '서울특별시 강남구 테헤란로 1'}
    check = shipping_set_problem(ship)
    assert check({**ship, 'phone_field_id': 42}) is None
    assert check({**ship, 'phone_field_ids': [1, 2]}) is None
    assert '전화 칸' in (check(dict(ship)) or '')


def test_history_recent_problems(tmp_path) -> None:
    hist = ScriptHistory(tmp_path)
    hist.record('s', 'a', 'b', {'problem': '원가 못 읽음'})
    assert any('원가 못 읽음' in p for p in hist.recent_problems('s'))
    assert hist.recent_problems('none') == []


def test_app_supports_pay_guard_detects_old_app() -> None:
    from samba_agent.repair import app_supports_pay_guard

    class R:
        def __init__(self, result: str) -> None:
            self.result = result

    class Old:
        def call(self, name, **kw):
            return R('"probe-ran"')  # 예전 앱: 모르는 safety 를 무시하고 실행

    class New:
        def call(self, name, **kw):
            return R('safety: no_pay supported')  # 새 앱: 지원 문구

    class Down:
        def call(self, name, **kw):
            raise RuntimeError('bridge down')

    assert not app_supports_pay_guard(Old())
    assert app_supports_pay_guard(New())
    assert not app_supports_pay_guard(Down())


@pytest.mark.coupon_download
def test_download_coupons_runs_script_per_account(buyer) -> None:
    """상품 확인 전에 계정마다 '쿠폰받기' 스크립트를 부른다(실기: 안 받은 쿠폰으로 계정 비교가 틀렸다)."""
    from samba_agent.agents.contracts import Assignment, OrderRef

    route = respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"ok": true, "clicked": true, "issued": ["11,940"]}')
    )
    order = OrderRef(order_no='A1', source='MUSINSA', seller='포이즌', sku='5458452', qty=1)
    a = Assignment(order=order, allowed_tools=buyer.spec.tools, rules='', dry_run=False)
    buyer._download_coupons(a, 'buyer01')
    body = json.loads(route.calls[0].request.content)['args']
    assert body['name'] == 'musinsa_coupon_download'
    assert json.loads(body['args'])['profile'] == 'buyer01'
    assert any('11,940' in e.detail for e in buyer.evidence)


def test_audit_requotes_account_whose_coupon_did_not_apply(buyer) -> None:
    """buyer01 이 쿠폰을 받았는데 비교액이 다른 계정보다 높으면 다시 견적하고, 고쳐지면 그 값으로 비교한다."""
    from samba_agent.agents.base import Decision
    from samba_agent.agents.contracts import Assignment, OrderRef

    buyer._decide = lambda p, m: Decision(choice='없음', reason='이상 없음')
    order = OrderRef(order_no='A1', source='MUSINSA', seller='포이즌', sku='1', qty=1)
    a = Assignment(order=order, allowed_tools=buyer.spec.tools, rules='', dry_run=False)
    quotes = [
        ('buyer01', {'cost': 114630, 'coupons_issued': ['11,940']}),
        ('buyer02', {'cost': 103170, 'coupons_issued': []}),
    ]
    buyer._quote = lambda a, acc: {'cost': 103170, 'coupons_issued': ['11,940']}
    out = dict(buyer._audit_quotes(a, quotes))
    assert out['buyer01']['cost'] == 103170
    assert buyer._expect_cost['buyer01'] == 103170


def test_audit_drops_account_that_stays_expensive(buyer) -> None:
    from samba_agent.agents.base import Decision
    from samba_agent.agents.contracts import Assignment, OrderRef

    buyer._decide = lambda p, m: Decision(choice='없음', reason='이상 없음')
    order = OrderRef(order_no='A1', source='MUSINSA', seller='포이즌', sku='1', qty=1)
    a = Assignment(order=order, allowed_tools=buyer.spec.tools, rules='', dry_run=False)
    quotes = [
        ('buyer01', {'cost': 114630, 'coupons_issued': ['11,940']}),
        ('buyer02', {'cost': 103170, 'coupons_issued': []}),
    ]
    buyer._quote = lambda a, acc: {'cost': 114630, 'coupons_issued': ['11,940']}
    out = dict(buyer._audit_quotes(a, quotes))
    assert 'buyer01' not in out and 'buyer02' in out


def test_quote_cost_adds_points_used_from_order_prep() -> None:
    """견적 행에 적립금이 없으면 주문서 정돈의 사용 적립금이 원가에 들어간다(원가 = 결제×청구할인 − 적립 + 적립금)."""
    from samba_agent.agents.buyer import cheapest_quotes

    raw = [{'method': '무신사페이', 'card': '롯데카드', 'cost': 51360, 'points_used': 6150}]
    best = cheapest_quotes(raw, None, None)[0]
    assert best['cost'] == 56483


def test_quotes_drop_disallowed_card_issuers() -> None:
    """허용 카드사 밖(삼성) 견적은 뺀다 — 무신사머니가 남는다."""
    from samba_agent.agents.buyer import cheapest_quotes

    raw = [
        {'method': '무신사페이', 'card': '무신사 삼성카드', 'cost': 49310},
        {'method': '무신사머니', 'card': None, 'cost': 51360, 'reward': 2000},
    ]
    rows = cheapest_quotes(raw, None, None)
    assert [r['method'] for r in rows] == ['무신사머니']


def test_quote_parallel_uses_one_lane_per_account(buyer, monkeypatch) -> None:
    """계정 비교를 레인(소싱처-계정)마다 동시에 돌리고 결과·근거를 계정 순서대로 모은다."""
    from samba_agent.agents.contracts import Assignment, OrderRef

    lanes: list[str | None] = []

    def fake_quote(self, a, account):
        lanes.append(self.bridge._lane)
        self.note('계정 견적', f'{account}: 원가')
        return {'cost': {'buyer01': 100, 'buyer02': 90}[account]}

    monkeypatch.setattr(BuyerAgent, '_quote', fake_quote)
    # 비교가 끝나면 레인마다 제 탭을 닫는다(이긴 계정 주문서를 레인 밖에서 다시 만들 때 남의 주문서를 집지 않게)
    closed = respx.post(f'{URL}/tool/run_js').mock(return_value=page('ok'))
    order = OrderRef(order_no='A1', source='MUSINSA', seller='포이즌', sku='1', qty=1)
    a = Assignment(order=order, allowed_tools=buyer.spec.tools, rules='', dry_run=False)
    buyer.evidence = []
    buyer._quote_errors = []
    buyer._quote_skips = []
    out = buyer._quote_parallel(a, ['buyer01', 'buyer02'])
    assert [acc for acc, _ in out] == ['buyer01', 'buyer02']
    assert sorted(lanes) == ['musinsa-buyer02', 'musinsa-buyer01']
    assert sorted(c.request.headers['X-Samba-Lane'] for c in closed.calls) == [
        'musinsa-buyer02',
        'musinsa-buyer01',
    ]
    assert [e.detail for e in buyer.evidence if e.label == '계정 견적'] == [
        'buyer01: 원가',
        'buyer02: 원가',
    ]


def test_bridge_client_sends_lane_header() -> None:
    from samba_agent.bridge.client import BridgeClient

    route = respx.post(f'{URL}/tool/get_page').mock(return_value=page('ok'))
    c = BridgeClient(URL, 'a' * 64, allowed=('get_page',)).with_lane('musinsa-buyer01')
    c.call('get_page')
    assert route.calls[0].request.headers['X-Samba-Lane'] == 'musinsa-buyer01'


def test_size_letters_must_match() -> None:
    from samba_agent.agents.buyer import size_letters

    assert size_letters('상아색 S') == {'S'}
    assert size_letters('-SHIRT_IVORY [LW263TS02IV]') == set()
    assert size_letters('IVORY [SIZE]S') == {'S'}
    assert size_letters('BLACK · ONE') == {'ONE'}


def test_size_letter_options_matches_asia_size_prefix() -> None:
    """색이 하나뿐인 상품의 사이즈만 있는 선택지(A/S)를 주문 옵션 '블랙 S' 와 맞춘다 — 여럿이 맞으면 고르지 않는다."""
    from samba_agent.agents.buyer import size_letter_options

    opts = ['A/XS', 'A/S', 'A/M', 'A/L', 'A/XL']
    assert size_letter_options(opts, '블랙 S') == ['A/S']
    assert size_letter_options(opts, '그레이 L') == ['A/L']
    assert size_letter_options(opts, '블랙 250') == []
    assert size_letter_options(['블랙 S', '화이트 S'], '블랙 S') == []
    assert size_letter_options(['A/S 품절', 'A/M'], '블랙 S') == []
