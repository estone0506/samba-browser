# 구매 에이전트 — 정상 / 품절 / 카드 없음 / 캡차 / 결제창은 건드리지 않는다
import httpx
import pytest
import respx

from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='SKU-260', qty=1)


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(reg) -> Assignment:
    spec = reg['buyer.musinsa']
    return Assignment(
        order=ORDER,
        options={'card': '현대'},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=True,
    )


def agent(reg, decide) -> BuyerAgent:
    spec = reg['buyer.musinsa']
    return BuyerAgent(
        spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), decide
    )


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@respx.mock
def test_정상이면_계정_카드_원가를_돌려준다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page(
            '{"options":["260","265"],"coupons":{"a***@x.com":5000},'
            '"methods":["현대","삼성"],"cost":89000,"margin_pct":12.5}'
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='주문 사이즈와 일치'))(assignment(reg))
    assert out.status == 'ok'
    assert out.payload['card'] == '현대'
    assert out.payload['cost'] == 89000
    assert out.reason  # 근거가 반드시 있다
    assert [e.label for e in out.evidence]


@respx.mock
def test_옵션이_없으면_품절로_거절한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"options":[],"coupons":{},"methods":["현대"],"cost":0,"margin_pct":0}')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)


@respx.mock
def test_지시받은_카드가_없으면_거절한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page(
            '{"options":["260"],"coupons":{"a***@x.com":0},'
            '"methods":["신한"],"cost":89000,"margin_pct":12.5}'
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
        return_value=page(
            '{"options":["260"],"coupons":{"a***@x.com":0},'
            '"methods":["현대"],"cost":89000,"margin_pct":12.5}'
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert not route.called
