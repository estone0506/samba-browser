# 구매 에이전트 — 정상 / 품절 / 중복 / 배송지 / 카드 없음 / 캡차 / 결제창은 건드리지 않는다
import json

import httpx
import pytest
import respx

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import BuyerAgent
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


def route_run_script(responses: dict[str, object]) -> object:
    """저장 스크립트 이름(run_script 의 args.name)별로 다른 JSON 을 돌려주는 respx 핸들러.

    respx 는 URL 로만 매칭해서 같은 /tool/run_script 로 스냅샷·배송지 호출이 모두 들어온다 —
    본문의 스크립트 이름으로 직접 분기한다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        name = body.get('args', {}).get('name')
        if name not in responses:
            raise AssertionError(f'예상치 못한 run_script 호출: {name}')
        return page(json.dumps(responses[name], ensure_ascii=False))

    return handler


@respx.mock
def test_정상이면_계정_카드_원가_배송지를_돌려준다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {
                'musinsa_product_snapshot': SNAPSHOT_OK,
                'musinsa_set_shipping': SHIPPING,  # 그대로 반영됐다고 메아리쳐 준다
            }
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
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
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING}
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
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
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)


@respx.mock
def test_이미_구매한_흔적이_있으면_중복으로_거절한다(reg):
    dup = {**SNAPSHOT_OK, 'already_ordered': True}
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page(json.dumps(dup, ensure_ascii=False))
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.DUPLICATE)


@respx.mock
def test_쓸_수_있는_계정이_없으면_unknown으로_거절한다(reg):
    no_account = {**SNAPSHOT_OK, 'coupons': {}}
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page(json.dumps(no_account, ensure_ascii=False))
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.UNKNOWN)
    assert out.reason == '쓸 수 있는 계정 없음'


@respx.mock
def test_배송지를_못_받으면_사람에게_넘긴다(reg):
    no_shipping = {**SNAPSHOT_OK, 'shipping': {}}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': no_shipping, 'samba_order_shipping': {}}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)
    assert '홍길동' not in out.reason
    assert find_leaks(out.reason) == []


@respx.mock
def test_배송지_입력_검증이_어긋나면_사람에게_넘긴다(reg):
    # 반영 확인 응답이 요청과 다르다(전화번호가 빠졌다) — 마스킹 비교에서 어긋난다
    bad_echo = {'name': SHIPPING['name'], 'address': SHIPPING['address']}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': bad_echo}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)


@respx.mock
def test_지시받은_카드가_없으면_거절한다(reg):
    no_card = {**SNAPSHOT_OK, 'methods': ['신한']}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': no_card, 'musinsa_set_shipping': SHIPPING}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@respx.mock
def test_캡차가_뜨면_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('needs_user: 캡차 확인 필요'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.CAPTCHA)


@respx.mock
def test_결제_도구는_부르지도_못한다(reg):
    route = respx.post(f'{URL}/tool/phone_approve_payment')
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
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
