"""SSG 결제 진입 인자 — 카드사(issuer)·신세계백화점 허용·도착 상품 주소(expect.product_url)·금액·탭."""

import json

import httpx
import pytest
import respx

from samba_agent.agents.contracts import AgentResult, Assignment, OrderRef
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.assign import _handoff

URL = 'http://127.0.0.1:47811'
ENTER_OK = '{"ok": true, "method": "SSGPAY", "popup_url": null}'
MALL = 'https://shinsegaemall.ssg.com/item/itemView.ssg?itemId=1000000000333&siteNo=6004'


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


def payer(reg: Registry) -> PayerAgent:
    spec = reg['payer']

    def never(_p, _m):  # 결제 에이전트는 LLM 판단을 하지 않는다
        raise AssertionError('LLM 호출 금지')

    return PayerAgent(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), never)


def enter_args(reg: Registry, source: str, handoff: dict[str, object]) -> dict[str, object]:
    """시험 실행(dry-run)으로 결제 진입 스크립트를 부르고 그 이름·인자를 돌려준다."""
    enter = respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    # 결제 전 주문서 대조(_check_order_form) — 주문서 탭으로 옮겨 옵션(270)이 보이는지 본다
    respx.post(f'{URL}/tool/switch_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문서 나이키 HF5441-100 270 1개'))
    spec = reg['payer']
    order = OrderRef(order_no='A1', source=source, seller='쿠팡', sku='S1', qty=1, option='270')
    a = Assignment(
        order=order,
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=True,
        handoff={'cost': 95700, **handoff},
    )
    out = payer(reg)(a)
    assert out.status == 'ok', out.reason
    body = json.loads(enter.calls.last.request.content.decode('utf-8'))['args']
    return {'name': body['name'], **json.loads(body['args'])}


SSG_HANDOFF: dict[str, object] = {
    'card': 'SSGPAY',
    'card_issuer': '현대카드',
    'buy_source': 'SSG',
    'account': 'acc1',
    'paid': 100000,
    'order_tab': 'tab-333',
    'selected': '270',
    'product_no': '1000000000333',
    'product_name': '나이키 HF5441-100',
    'product_url': MALL,
}


@respx.mock
def test_SSG_결제_진입에_카드사_백화점_허용_상품주소_금액_탭을_넘긴다(reg) -> None:
    args = enter_args(reg, 'SSG', SSG_HANDOFF)
    assert args['name'] == 'checkout_enter_ssg'
    assert (args['card'], args['issuer']) == ('SSGPAY', '현대카드')
    assert args['allow_department'] is True  # 사용자 2026-09-27: 신세계백화점 허용
    assert (args['amount'], args['tab']) == (100000, 'tab-333')
    assert args['expect'] == {
        'name': '나이키 HF5441-100',
        'option': '270',
        'selected': '270',
        'product_no': '1000000000333',
        'product_url': MALL,
    }


@respx.mock
def test_다른_소싱처는_백화점_허용·상품주소를_넘기지_않는다(reg) -> None:
    args = enter_args(reg, '무신사', {'card': '무신사페이', 'buy_source': 'MUSINSA'})
    assert args['name'] == 'checkout_enter_musinsa'
    assert 'allow_department' not in args and 'issuer' not in args
    assert set(args['expect']) == {'name', 'option', 'selected', 'product_no'}  # type: ignore[arg-type]


def test_구매_인계값에_상품주소·경로·애드픽_적립이_실린다() -> None:
    r = AgentResult(
        status='ok',
        reason='ok',
        payload={'product_url': MALL, 'route': 'adpick', 'adpick_reward': 1600, 'card_issuer': '현대카드'},
    )
    out = _handoff({'results': {'buyer.ssg': r}})  # type: ignore[typeddict-item]
    assert (out['product_url'], out['route'], out['adpick_reward'], out['card_issuer']) == (
        MALL,
        'adpick',
        1600,
        '현대카드',
    )
