# 저장 스크립트 자가 수리 — 실패하면 AI 가 고쳐 이어 가고, 검증 통과한 코드만 저장한다
import json

import httpx
import pytest
import respx

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import BuyerAgent, snapshot_problem
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.repair import FileScriptSource, RepairOutcome, ScriptHistory, ScriptRepairer
from samba_agent.repair.agent import check_candidate, parse_output
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
            [{'name': 'x_snap', 'host': 'x.com', 'description': 'd', 'params': ['sku'], 'code': 'return 1'}]
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
    check = snapshot_problem('상아색 S')
    assert check({'options': ['상아색 / S'], 'cost': 1000}) is None
    assert '맞는 선택지가 없다' in (check({'options': ['블랙 / M'], 'cost': 1000}) or '')
    assert '원가' in (check({'options': ['상아색 S'], 'cost': 0}) or '')
    assert check({'already_ordered': True}) is None


def test_candidate_guard_blocks_payment_and_long_or_hardcoded_code() -> None:
    assert check_candidate("await page.clickText('결제하기')")
    assert check_candidate("location='https://money.musinsapayments.com'")
    assert check_candidate('x'.ljust(4001, 'x'))
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

    def spy_server(name, version='1.0.0', tools=None):  # noqa: ANN001, ANN202
        captured['tools'] = {t.name: t for t in tools or []}
        return real_server(name, version, tools)

    monkeypatch.setattr(claude_agent_sdk, 'create_sdk_mcp_server', spy_server)
    ran: list[str] = []

    def call(tool: str, args: dict[str, object]) -> str:
        code = str(args['code'])
        ran.append(code)
        return '{"cost": 0}' if 'bad' in code else '{"cost": 900}'

    async def fake_query(prompt, options):  # noqa: ANN001, ANN202
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
