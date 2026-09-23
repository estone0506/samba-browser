# 구매 에이전트 — 정상 / 품절 / 중복 / 배송지 / 카드 없음 / 캡차 / 결제창은 건드리지 않는다
import json

import httpx
import pytest
import respx

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import BuyerAgent, shipping_matches, snapshot_args
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='SKU-260', qty=1)

# 배송지 표본 — 테스트에서만 쓰는 가짜 개인정보. 어디에도 원문으로 남으면 안 된다
SHIPPING = {'name': '홍길동', 'phone': '010-1234-5678', 'address': '서울특별시 강남구 테헤란로 1'}

# 배송지 스크립트의 반영 확인 응답 — 이름·주소를 메아리치고 비워 둔 전화 칸 번호를 알려 준다
SHIPPING_ECHO = {'name': SHIPPING['name'], 'address': SHIPPING['address'], 'phone_field_id': 42}

SNAPSHOT_OK = {
    'options': ['260', '265'],
    'coupons': {'a***@x.com': 5000},
    'methods': ['현대', '삼성'],
    'cost': 89000,
    'margin_pct': 12.5,
    'shipping': SHIPPING,
}


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(reg, *, dry_run: bool = True) -> Assignment:
    spec = reg['buyer.musinsa']
    return Assignment(
        order=ORDER,
        options={'card': '현대'},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
    )


def agent(reg, decide) -> BuyerAgent:
    spec = reg['buyer.musinsa']
    return BuyerAgent(
        spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), decide
    )


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


def mock_fill_secret(result: str = 'ok: filled identity.phone'):
    """앱 fill_secret — 번호는 앱이 키마스터에서 채우고 우리에게는 결과 문구만 온다."""
    return respx.post(f'{URL}/tool/fill_secret').mock(return_value=page(result))


def route_run_script(responses: dict[str, object]) -> object:
    """저장 스크립트 이름(run_script 의 args.name)별로 다른 JSON 을 돌려주는 respx 핸들러.

    respx 는 URL 로만 매칭해서 같은 /tool/run_script 로 스냅샷·배송지 호출이 모두 들어온다 —
    본문의 스크립트 이름으로 직접 분기한다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        name = body.get('args', {}).get('name')
        if name not in responses and str(name).endswith('_confirm_shipping'):
            # 확정 스크립트는 표본에 없어도 받은 인자를 되읽기로 메아리친다
            args = json.loads(body['args'].get('args') or '{}')
            return page(json.dumps({'ok': True, **args}, ensure_ascii=False))
        if name not in responses:
            raise AssertionError(f'예상치 못한 run_script 호출: {name}')
        return page(json.dumps(responses[name], ensure_ascii=False))

    return handler


def mock_accounts(*labels: str, locked: bool = False, login: str = 'already signed in (logout)'):
    """주문 계정이 없는 주문의 계정 경로 — 기본 탭 열기·계정 목록·계정별 로그인을 mock 한다.

    list_accounts 는 앱처럼 풀린 금고면 배열을, 잠겼으면 {vaultLocked, accounts} 를 돌려준다.
    """
    accounts = [
        {'label': x, 'username': 'a***', 'types': ['login'], 'tags': []}
        for x in labels or ('acc1',)
    ]
    body = {'vaultLocked': True, 'accounts': accounts} if locked else accounts
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok: tab t9'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/login').mock(return_value=page(login))
    return respx.post(f'{URL}/tool/list_accounts').mock(
        return_value=page(json.dumps(body, ensure_ascii=False))
    )


@respx.mock
def test_정상이면_계정_카드_원가_배송지를_돌려준다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {
                'musinsa_product_snapshot': SNAPSHOT_OK,
                'musinsa_set_shipping': SHIPPING_ECHO,  # 그대로 반영됐다고 메아리쳐 준다
            }
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='주문 사이즈와 일치'))(assignment(reg))
    assert out.status == 'ok'
    assert out.payload['card'] == '현대'
    assert out.payload['cost'] == 89000
    assert out.payload['shipping_set'] is True
    assert out.reason  # 근거가 반드시 있다
    assert [e.label for e in out.evidence]


@respx.mock
def test_배송지_원문은_결과_어디에도_남지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='주문 사이즈와 일치'))(assignment(reg))
    dumped = json.dumps(out.model_dump(mode='json'), ensure_ascii=False)
    assert find_leaks(dumped) == []
    assert SHIPPING['name'] not in dumped
    assert SHIPPING['phone'].replace('-', '') not in dumped.replace('-', '')


@respx.mock
def test_옵션이_없으면_품절로_거절한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"options":[],"coupons":{},"methods":["현대"],"cost":0,"margin_pct":0}')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)


@respx.mock
def test_이미_구매한_흔적이_있으면_중복으로_거절한다(reg):
    dup = {**SNAPSHOT_OK, 'already_ordered': True}
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page(json.dumps(dup, ensure_ascii=False))
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.DUPLICATE)


@pytest.mark.parametrize('locked', [True, False])
@respx.mock
def test_금고가_잠겼거나_계정이_없으면_사람에게_넘긴다(reg, locked):
    snap = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    if locked:
        mock_accounts('A', 'B', locked=True)
    else:
        mock_accounts()
        respx.post(f'{URL}/tool/list_accounts').mock(return_value=page('[]'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PERMISSION_DENIED)
    assert '소싱처 계정 없음/금고 잠김: MUSINSA' in out.reason
    assert not snap.called


@respx.mock
def test_배송지를_못_받으면_사람에게_넘긴다(reg):
    no_shipping = {**SNAPSHOT_OK, 'shipping': {}}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': no_shipping, 'samba_order_shipping': {}}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)
    assert '홍길동' not in out.reason
    assert find_leaks(out.reason) == []


@respx.mock
def test_배송지_입력_검증이_어긋나면_사람에게_넘긴다(reg):
    # 반영 확인 응답이 요청과 다르다(주소가 빠졌다) — 마스킹 비교에서 어긋난다
    bad_echo = {**SHIPPING_ECHO, 'address': ''}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': bad_echo}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)


@respx.mock
def test_지시받은_카드가_없으면_거절한다(reg):
    no_card = {**SNAPSHOT_OK, 'methods': ['신한']}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': no_card, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@respx.mock
def test_캡차가_뜨면_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('needs_user: 캡차 확인 필요'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.CAPTCHA)


@respx.mock
def test_결제_도구는_부르지도_못한다(reg):
    route = respx.post(f'{URL}/tool/phone_approve_payment')
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert not route.called


@respx.mock
def test_dry_run이면_부수효과_도구를_아예_부르지_않는다(reg):
    route = respx.post(f'{URL}/tool/save_script')
    b = agent(reg, lambda p, m: m(choice='260', reason='x'))
    b._dry_run = True
    with pytest.raises(AgentFailure) as e:
        b.tool('save_script', name='x', args='{}')
    assert (e.value.status, e.value.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
    assert not route.called


@respx.mock
def test_dry_run이_아니면_부수효과_도구_호출은_막지_않는다(reg):
    route = respx.post(f'{URL}/tool/save_script').mock(return_value=page('ok'))
    b = agent(reg, lambda p, m: m(choice='260', reason='x'))
    b._dry_run = False
    b.tool('save_script', name='x', args='{}')
    assert route.called


def _login_mocks(*login_results: str):
    """로그인 확인 경로의 도구 3개를 mock 한다. login 은 호출 순서대로 답한다."""
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok: tab t9'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    results = list(login_results)
    return respx.post(f'{URL}/tool/login').mock(
        side_effect=lambda _req: page(results.pop(0) if len(results) > 1 else results[0])
    )


ORDER_WITH_ACCOUNT = ORDER.model_copy(update={'account': 'buyer01'})


def assignment_with_account(reg) -> Assignment:
    return assignment(reg).model_copy(update={'order': ORDER_WITH_ACCOUNT})


@respx.mock
def test_소싱_계정이_있으면_스냅샷_전에_로그인한다(reg):
    login = _login_mocks(
        'submitted: check the page for success or captcha/2FA', 'already signed in (logout)'
    )
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'ok'
    assert login.call_count == 2  # 제출 뒤 한 번 더 불러 로그인됐는지 확인한다
    assert json.loads(login.calls[0].request.content)['args'] == {'accountLabel': 'buyer01'}
    # 계정 이름의 프로필로 탭을 열었다
    new_tab = next(c for c in respx.calls if c.request.url.path.endswith('/new_tab'))
    assert json.loads(new_tab.request.content)['args']['profile'] == 'buyer01'
    assert any('로그인 완료' in e.detail for e in out.evidence)


@respx.mock
def test_이미_로그인돼_있으면_바로_진행한다(reg):
    login = _login_mocks('already signed in (logout)')
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'ok'
    assert login.call_count == 1


@respx.mock
def test_저장된_계정이_없으면_사람에게_넘긴다(reg):
    _login_mocks('account not found: use list_accounts')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.PERMISSION_DENIED
    assert '로그인 실패' in out.reason


@respx.mock
def test_스냅샷의_계정이_주문_계정과_다르면_사람에게_넘긴다(reg):
    _login_mocks('already signed in (logout)')
    other = {**SNAPSHOT_OK, 'account': 'buyer02'}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': other})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.PERMISSION_DENIED
    assert 'buyer02' in out.reason


@respx.mock
def test_실패해도_그때까지의_근거는_결과에_남는다(reg):
    # 실기: 실패 사유만 남고 옵션 목록 등 근거가 비어 진단이 막혔다
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {
                'musinsa_product_snapshot': {**SNAPSHOT_OK, 'methods': ['신한']},
                'musinsa_set_shipping': SHIPPING_ECHO,
            }
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'fail'
    labels = [e.label for e in out.evidence]
    assert {'계정 선택', '옵션 목록', '옵션 선택', '배송지'} <= set(labels)


def test_스냅샷_인자는_상품_ID와_사이즈를_우선한다():
    """실기: 판매 상품명을 ABC마트 검색어로 써서 검색 결과 페이지에서 '품절'로 오판했다."""
    abc = OrderRef(
        order_no='A1',
        source='ABC마트',
        seller='신세계몰',
        sku='매장정품 코르테즈 [265]',
        qty=1,
        option='265',
        product_url='https://abcmart.a-rt.com/product/new?prdtNo=1010118346',
    )
    assert json.loads(snapshot_args('buyer.abc', abc)) == {
        'sku': '1010118346',
        'qty': 1,
        'size': '265',
    }
    # ID 규칙이 없는 소싱처는 URL 그대로, URL 도 없으면 판매 상품명
    musinsa = abc.model_copy(update={'product_url': 'https://www.musinsa.com/products/1'})
    assert (
        json.loads(snapshot_args('buyer.musinsa', musinsa))['sku']
        == 'https://www.musinsa.com/products/1'
    )
    plain = abc.model_copy(update={'product_url': None, 'option': None})
    assert json.loads(snapshot_args('buyer.abc', plain)) == {
        'sku': '매장정품 코르테즈 [265]',
        'qty': 1,
    }
    with_account = abc.model_copy(update={'account': 'buyer01'})
    with_acc = json.loads(snapshot_args('buyer.abc', with_account))
    assert with_acc['account'] == 'buyer01' and with_acc['profile'] == 'buyer01'


def test_스냅샷_인자는_따옴표가_있어도_JSON_이다():
    order = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='SKU "A"', qty=2)
    assert json.loads(snapshot_args('buyer.musinsa', order)) == {'sku': 'SKU "A"', 'qty': 2}


# ---- 삼바웨이브 배송지 공급자 · 표시 이름 계정(Task C) · 전화는 신원정보(P2) ----

WAVE_BASE = 'https://wave.test'
WAVE_API = f'{WAVE_BASE}/api/v1/internal/harness'
# 삼바웨이브 상세 응답 — 고객 전화번호가 실려 와도 하네스는 버린다
CUSTOMER = {
    'name': '홍길동',
    'phone': '010-1234-5678',
    'address': '서울특별시 강남구 테헤란로 1',
    'address_detail': '2층',
    'postal_code': '06234',
}


def wave_client():
    from samba_agent.wave.client import WaveClient

    return WaveClient(WAVE_BASE, 'test-token', 'tenant-1')


def shipping_provider():
    from samba_agent.agents.factory import _shipping_provider

    return _shipping_provider(wave_client())


def buyer_with_wave(reg, decide):
    a = agent(reg, decide)
    a.set_shipping_provider(shipping_provider())
    return a


def _recording_handler(snapshot_name, applied, echo_extra=None):
    """스냅샷은 표본을, 배송지 스크립트는 받은 인자(+전화 칸 번호)를 메아리친다."""
    extra = {'phone_field_id': 42} if echo_extra is None else echo_extra

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body['args']['name'] == snapshot_name:
            return page(json.dumps(SNAPSHOT_OK, ensure_ascii=False))
        args = json.loads(body['args']['args'])
        if body['args']['name'].endswith('_confirm_shipping'):
            # 확정 스크립트 — 폼을 저장한 뒤 주문서에서 되읽은 값을 그대로 메아리친다
            return page(json.dumps({'ok': True, **args}, ensure_ascii=False))
        applied.update(args)
        return page(json.dumps({**applied, **extra}, ensure_ascii=False))

    return handler


def _wave_direct():
    return respx.get(f'{WAVE_API}/orders/A1').mock(
        return_value=httpx.Response(
            200, json={'order_number': 'A1', 'order_type': 'direct', 'shipping': CUSTOMER}
        )
    )


@respx.mock
def test_삼바웨이브가_있으면_배송지는_거기서_받는다(reg):
    """직배 — 스냅샷에 실린 값보다 삼바웨이브 상세의 고객 이름·주소가 우선한다."""
    _wave_direct()
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('musinsa_product_snapshot', applied)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert applied['address'] == CUSTOMER['address']
    assert applied['postal_code'] == '06234' and applied['address_detail'] == '2층'
    dumped = json.dumps(out.model_dump(mode='json'), ensure_ascii=False)
    assert find_leaks(dumped) == []
    assert CUSTOMER['address'] not in dumped


@respx.mock
def test_삼바웨이브_배송지_조회가_실패하면_그_사유로_실패한다(reg):
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(403, json={'detail': 'x'}))
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': SNAPSHOT_OK})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)


@respx.mock
def test_스냅샷이_표시_이름을_돌려주면_대조를_건너뛴다(reg):
    """실기: 사이트가 로그인 아이디 대신 한글 별명(김사무1)을 돌려준다 — 불일치로 보지 않는다."""
    snap = {**SNAPSHOT_OK, 'account': '김사무1'}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': snap, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    a = assignment(reg).model_copy(
        update={'order': ORDER.model_copy(update={'account': 'buyer01'})}
    )
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(a)
    assert out.status == 'ok'
    assert any('표시 이름이라 대조 불가' in e.detail for e in out.evidence)


@respx.mock
def test_스냅샷이_다른_아이디를_돌려주면_사람에게_넘긴다(reg):
    snap = {**SNAPSHOT_OK, 'account': 'someone_else'}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': snap})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    a = assignment(reg).model_copy(
        update={'order': ORDER.model_copy(update={'account': 'buyer01'})}
    )
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(a)
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PERMISSION_DENIED)


@respx.mock
def test_고객_전화번호는_어디에도_입력하지_않는다(reg):
    # 사용자 결정(2026-09-23): 전화 칸은 앱이 키마스터 신원정보로 채운다 — 하네스는 번호를 보지 않는다
    _wave_direct()
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler(
            'musinsa_product_snapshot', applied, echo_extra={'phone_field_id': 7}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = mock_fill_secret()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert 'phone' not in applied  # 스크립트 인자에 phone 키 자체가 없다
    assert applied['name'] == CUSTOMER['name']
    assert json.loads(fill.calls[0].request.content)['args'] == {
        'elementId': 7,
        'itemType': 'identity',
        'field': 'identity.phone',
    }
    # 어떤 도구 호출에도 고객 번호가 실리지 않았다
    for call in respx.calls:
        if call.request.content:
            assert '5678' not in call.request.content.decode('utf-8')
    assert any(e.label == '배송 연락처' for e in out.evidence)


@respx.mock
def test_스냅샷에_실린_전화번호도_배송지_스크립트에_넘기지_않는다(reg):
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('musinsa_product_snapshot', applied)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert 'phone' not in applied and applied['name'] == SHIPPING['name']


@pytest.mark.parametrize(
    ('echo_extra', 'fill_result', 'want'),
    [
        ({}, None, '전화 칸을 찾지 못함'),
        ({'phone_field_id': 42}, 'not found: identity.phone', '배송 연락처 입력 실패'),
        ({'phone_field_id': 42}, 'refused: vault-locked', '배송 연락처 입력 실패'),
    ],
)
@respx.mock
def test_전화_칸을_채우지_못하면_사람에게_넘긴다(reg, echo_extra, fill_result, want):
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('musinsa_product_snapshot', applied, echo_extra=echo_extra)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = mock_fill_secret(fill_result or 'ok')
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'needs_human'
    assert want in out.reason
    assert fill.called is (fill_result is not None)


@respx.mock
def test_dry_run에서도_배송_연락처_입력은_막지_않는다(reg):
    b = agent(reg, lambda p, m: m(choice='260', reason='x'))
    b._dry_run = True
    route = mock_fill_secret()
    b.tool('fill_secret', elementId=1, itemType='identity', field='identity.phone')
    assert route.called


def _abc_agent(reg):
    spec = reg['buyer.abc']
    abc = BuyerAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='260', reason='일치'),
    )
    abc.set_shipping_provider(shipping_provider())
    return abc, spec


def _abc_assignment(reg, spec):
    order = ORDER.model_copy(update={'source': 'ABCmart', 'order_type': 'direct'})
    return assignment(reg).model_copy(update={'order': order, 'allowed_tools': spec.tools})


@respx.mock
def test_ABC마트는_항상_까대기로_기본_배송지를_유지한다(reg):
    # 플레이북 §4: 까대기면 계정 기본 배송지(사무실)를 유지하고 수정하지 않는다
    wave = respx.get(f'{WAVE_API}/orders/A1')
    abc, spec = _abc_agent(reg)
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('abc_product_snapshot', applied)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = respx.post(f'{URL}/tool/fill_secret')
    out = abc(_abc_assignment(reg, spec))
    assert out.status == 'ok'
    assert applied == {}  # 배송지 스크립트를 부르지 않았다
    assert not wave.called and not fill.called
    assert any(e.detail == '사무실 수령(기본 배송지 유지)' for e in out.evidence)


@respx.mock
def test_까대기_주문서에_기본_배송지가_없으면_사람에게_넘긴다(reg):
    abc, spec = _abc_agent(reg)
    snap = {**SNAPSHOT_OK, 'shipping': {'name': '', 'address': ''}}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'abc_product_snapshot': snap})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = abc(_abc_assignment(reg, spec))
    assert out.status == 'needs_human' and '기본 배송지 없음' in out.reason


@pytest.mark.parametrize(
    ('page_text', 'ok'),
    [
        ('배송지 받는 분 삼바 사무실 주소 서울시', True),
        ('배송지 등록된 배송지가 없습니다 배송지를 추가해 주세요', False),
        ('결제수단 선택', False),
    ],
)
@respx.mock
def test_스냅샷에_배송지가_없으면_주문서_화면으로_확인한다(reg, page_text, ok):
    abc, spec = _abc_agent(reg)
    snap = {k: v for k, v in SNAPSHOT_OK.items() if k != 'shipping'}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'abc_product_snapshot': snap})
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page(page_text))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = abc(_abc_assignment(reg, spec))
    assert (out.status == 'ok') is ok


@respx.mock
def test_공급자는_까대기를_요청했는데_고객_주소가_오면_멈춘다():
    _wave_direct()
    with pytest.raises(AgentFailure) as e:
        shipping_provider()('A1', 'kkadaegi')
    assert e.value.status == 'needs_human' and '사무실 배송지' in e.value.reason


@respx.mock
def test_공급자가_주는_배송지에는_전화번호가_없다():
    _wave_direct()
    got = shipping_provider()('A1', 'direct')
    assert 'phone' not in got
    assert got['name'] == CUSTOMER['name'] and got['postal_code'] == '06234'


@respx.mock
def test_스냅샷에_마진이_없으면_판매가로_계산한다(reg):
    # 실기: 소싱처 스냅샷은 margin_pct 를 모른다(null) → 감독자가 마진 미달로 거부했다
    snap = {**SNAPSHOT_OK, 'margin_pct': None, 'cost': 80000}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': snap, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    order = ORDER.model_copy(update={'sale_price': 100000})
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(
        assignment(reg).model_copy(update={'order': order})
    )
    assert out.status == 'ok'
    assert out.payload['margin_pct'] == 20.0
    assert any(e.label == '마진 계산' for e in out.evidence)
    assert any('정산금 미확인 근사' in e.detail for e in out.evidence)


@respx.mock
def test_정산금이_있으면_정산금_기준으로_마진을_계산한다(reg):
    # 플레이북 §3: 마진율 = (정산금 − 원가) ÷ 매출 × 100 — 스냅샷 값보다 우선한다
    snap = {**SNAPSHOT_OK, 'margin_pct': 30, 'cost': 80000, 'pay_amount': 81000}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': snap, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    order = ORDER.model_copy(update={'sale_price': 100000, 'revenue': 90000})
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(
        assignment(reg).model_copy(update={'order': order})
    )
    assert out.status == 'ok'
    assert out.payload['margin_pct'] == 10.0
    assert out.payload['paid'] == 81000
    assert not any('근사' in e.detail for e in out.evidence)


def test_주문_옵션과_맞는_후보만_남긴다():
    from samba_agent.agents.buyer import matching_options

    # 실기: 230 주문에 후보가 220~270(230 없음)인데 모델이 '가장 가까운 220' 을 골랐다
    assert matching_options(['220', '225', '240', '250'], '230') == []
    assert matching_options(['220', '230', '240'], '230') == ['230']
    assert matching_options(['230(mm)', '240'], '옵션:230'.replace('옵션:', '')) == ['230(mm)']
    assert matching_options(['BLACK / 270', 'WHITE / 270'], 'BLACK / 270') == ['BLACK / 270']
    assert matching_options(['70(S)', '75(M)'], 'S') == ['70(S)']
    assert matching_options(['75(M) (품절)', '80(L)'], '75(M)') == []
    assert matching_options(['260', '265'], None) == ['260', '265']


@respx.mock
def test_주문_옵션에_맞는_후보가_없으면_모델에게_묻지_않고_품절이다(reg):
    snap = {**SNAPSHOT_OK, 'options': ['220', '240']}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': snap})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    asked = []

    def decide(p, m):
        asked.append(p)
        return m(choice='220', reason='가장 가까움')

    order = ORDER.model_copy(update={'option': '230'})
    out = agent(reg, decide)(assignment(reg).model_copy(update={'order': order}))
    assert (out.status, out.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)
    assert asked == []


# ---- 계정 비교(사용자 지시 2026-09-23: 계정별로 싸게 살 수 있는 걸 비교하고 구매 계정을 고른다) ----


def _per_account_snapshots(by_account: dict[str, object], calls: list[str]):
    """스냅샷 스크립트는 args.account 별로 다른 견적을, 배송지 스크립트는 메아리를 준다.

    값이 문자열이면 그대로(예: 캡차 표시) 돌려준다. 스냅샷을 부른 계정 순서를 calls 에 남긴다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        name = body['args']['name']
        args = json.loads(body['args']['args'])
        if name == 'musinsa_product_snapshot':
            calls.append(f'snapshot:{args.get("account")}')
            got = by_account[args['account']]
            return page(got if isinstance(got, str) else json.dumps(got, ensure_ascii=False))
        if name.endswith('_confirm_shipping'):
            # 확정은 calls 에 남기지 않는다(배송지 순서 단언은 set_shipping 기준)
            return page(json.dumps({'ok': True, **args}, ensure_ascii=False))
        calls.append(f'{name}:{args.get("profile")}')
        return page(json.dumps(SHIPPING_ECHO, ensure_ascii=False))

    return handler


def _login_accounts(login_route) -> list[str]:
    return [json.loads(c.request.content)['args']['accountLabel'] for c in login_route.calls]


@respx.mock
def test_주문_계정이_지정되면_비교하지_않고_그_계정으로_산다(reg):
    listed = respx.post(f'{URL}/tool/list_accounts')
    _login_mocks('already signed in (logout)')
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots({'buyer01': SNAPSHOT_OK}, calls)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'ok'
    assert not listed.called
    assert calls == ['snapshot:buyer01', 'musinsa_set_shipping:buyer01']
    assert out.payload['account'] == 'buyer01'
    assert out.payload['accounts_compared'] == 1


@respx.mock
def test_두_계정이면_원가가_낮은_계정으로_산다(reg):
    listed = mock_accounts('A', 'B')
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'cost': 90000}, 'B': {**SNAPSHOT_OK, 'cost': 80000}}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    # 계정 목록은 소싱처 호스트로 묻는다(앱은 현재 탭 호스트만 답한다)
    assert json.loads(listed.calls[0].request.content)['args'] == {'host': 'musinsa.com'}
    # B 가 마지막 견적이라 다시 만들 필요 없이 그 주문서로 이어 간다
    assert _login_accounts(login) == ['A', 'B']
    assert calls == ['snapshot:A', 'snapshot:B', 'musinsa_set_shipping:B']
    assert out.payload['account'] == 'B'
    assert out.payload['accounts_compared'] == 2
    assert out.payload['cost'] == 80000
    details = [e.detail for e in out.evidence if e.label == '계정 견적']
    assert details == ['A: 원가 90,000원', 'B: 원가 80,000원']
    assert any(
        e.label == '계정 선택' and '원가 최저 80,000원 (비교 2계정)' in e.detail
        for e in out.evidence
    )


@respx.mock
def test_싼_계정이_먼저면_그_계정으로_다시_로그인해_주문서를_최신으로_만든다(reg):
    mock_accounts('A', 'B')
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'cost': 80000}, 'B': {**SNAPSHOT_OK, 'cost': 90000}}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert _login_accounts(login) == ['A', 'B', 'A']
    assert calls == ['snapshot:A', 'snapshot:B', 'snapshot:A', 'musinsa_set_shipping:A']
    assert out.payload['account'] == 'A'


@respx.mock
def test_한_계정이_품절이면_다른_계정으로_산다(reg):
    mock_accounts('A', 'B')
    calls: list[str] = []
    order = ORDER.model_copy(update={'option': '260'})
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {
                'A': {**SNAPSHOT_OK, 'options': ['260 (품절)', '265'], 'cost': 70000},
                'B': {**SNAPSHOT_OK, 'cost': 85000},
            },
            calls,
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(
        assignment(reg).model_copy(update={'order': order})
    )
    assert out.status == 'ok'
    assert out.payload['account'] == 'B'
    assert any(e.detail == 'A: 불가(주문 옵션 품절)' for e in out.evidence)


@respx.mock
def test_로그인에_실패한_계정은_빼고_비교한다(reg):
    mock_accounts('A', 'B')
    respx.post(f'{URL}/tool/login').mock(
        side_effect=lambda req: page(
            'account not found: use list_accounts'
            if json.loads(req.content)['args']['accountLabel'] == 'A'
            else 'already signed in'
        )
    )
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots({'B': SNAPSHOT_OK}, calls)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert out.payload['account'] == 'B'
    assert calls == ['snapshot:B', 'musinsa_set_shipping:B']


@respx.mock
def test_모든_계정이_품절이면_품절로_거절한다(reg):
    mock_accounts('A', 'B')
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'options': []}, 'B': {**SNAPSHOT_OK, 'cost': 0}}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)
    assert 'A' in out.reason and 'B' in out.reason
    assert calls == ['snapshot:A', 'snapshot:B']  # 배송지까지 가지 않았다


@respx.mock
def test_모든_계정이_로그인에_실패하면_품절이_아니라_사람에게_넘긴다(reg):
    mock_accounts('A', 'B', login='account not found: use list_accounts')
    snap = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PERMISSION_DENIED)
    assert not snap.called


@respx.mock
def test_한_계정에서_이미_산_흔적이_보이면_비교를_멈추고_중복이다(reg):
    mock_accounts('A', 'B')
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'already_ordered': True}, 'B': SNAPSHOT_OK}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.DUPLICATE)
    assert calls == ['snapshot:A']


@respx.mock
def test_비교_계정_수는_상한까지만(reg):
    mock_accounts('A', 'B', 'C', 'D')
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {
                'A': {**SNAPSHOT_OK, 'cost': 90000},
                'B': {**SNAPSHOT_OK, 'cost': 80000},
                'C': {**SNAPSHOT_OK, 'cost': 50000},
                'D': {**SNAPSHOT_OK, 'cost': 10000},
            },
            calls,
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    b = agent(reg, lambda p, m: m(choice='260', reason='일치'))
    b.compare_accounts_max = 2
    out = b(assignment(reg))
    assert out.status == 'ok'
    assert _login_accounts(login) == ['A', 'B']  # 원래 순서의 앞 2개만
    assert out.payload['account'] == 'B'
    assert out.payload['accounts_compared'] == 2
    assert any(e.label == '계정 후보' and '4개 중 앞 2개' in e.detail for e in out.evidence)


def test_계정_목록_결과를_읽는다():
    from samba_agent.agents.buyer import parse_account_labels

    unlocked = json.dumps([{'label': 'A'}, {'label': 'B'}, {'label': 'A'}, {'label': ''}])
    assert parse_account_labels(unlocked) == (['A', 'B'], False)
    assert parse_account_labels('{"vaultLocked": true, "accounts": [{"label": "A"}]}') == (
        ['A'],
        True,
    )
    assert parse_account_labels('{"accounts": [], "note": "host unknown"}') == ([], False)
    assert parse_account_labels('not set up: ask the user') == ([], False)


def test_계정_비교_상한_설정은_기본_5이고_1_이상이다(monkeypatch):
    from pydantic import ValidationError

    from samba_agent.settings import load_settings

    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'x' * 64)
    monkeypatch.delenv('SAMBA_COMPARE_ACCOUNTS_MAX', raising=False)
    assert load_settings(env_file=None).compare_accounts_max == 5
    monkeypatch.setenv('SAMBA_COMPARE_ACCOUNTS_MAX', '3')
    assert load_settings(env_file=None).compare_accounts_max == 3
    monkeypatch.setenv('SAMBA_COMPARE_ACCOUNTS_MAX', '0')
    with pytest.raises(ValidationError):
        load_settings(env_file=None)


def test_배송지_비교는_사이트_표기_차이를_허용한다():
    exp = {'name': '홍길동', 'address': '서울특별시 중구 세종대로 110'}
    assert shipping_matches(
        exp, {'name': '홍길동', 'address': '서울 중구 세종대로 110 (서울특별시청)'}
    )
    assert shipping_matches(exp, {'name': '홍 길동', 'address': '04524 서울 중구 세종대로 110'})
    # 이름이 다르거나 번지가 다르면 다른 곳이다
    assert not shipping_matches(exp, {'name': '김철수', 'address': '서울 중구 세종대로 110'})
    assert not shipping_matches(exp, {'name': '홍길동', 'address': '서울 중구 세종대로 111'})
    assert not shipping_matches(exp, {'name': '홍길동', 'address': ''})
