"""패션플러스 주문 이행 연동(2026-09-27) — 소싱처 표·주문서 탭 정리·상품번호·상품 전체 품절(SOLD OUT) 확정."""

import re

import pytest

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import (
    _CLOSE_ORDER_TABS_JS,
    CONFIRMED_SOLD_OUT,
    SOLD_OUT_PRODUCT_SKIP,
    BuyerAgent,
    is_confirmed_sold_out_skip,
    product_no_of,
    snapshot_args,
    snapshot_problem,
    snapshot_sold_out,
)
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.sources import Sources

URL = 'http://127.0.0.1:47811'
PRODUCT = 'https://www.fashionplus.co.kr/goods/detail/12345678'
ORDER_FORM = 'https://www.fashionplus.co.kr/order/87654321'
ACCOUNTS = ['buyer01', 'buyer02']
# 스냅샷 초안이 상품 전체 품절에 돌려주는 모양(선택지 0개·sold_out·error)
SOLD_SNAP: dict[str, object] = {
    'options': [],
    'sold_out': True,
    'error': 'sold_out',
    'note': '상품 전체 품절(SOLD OUT, 선택지 0개)',
    'cost': None,
    'methods': [],
    'selected': None,
}


def _close_re() -> re.Pattern[str]:
    r"""주문서 탭 닫기 JS 의 정규식을 파이썬으로 옮긴다(JS 의 '\/' 는 '/')."""
    js = re.search(r'if \(/(.+?)/\.test', _CLOSE_ORDER_TABS_JS)
    assert js
    return re.compile(js.group(1).replace(r'\/', '/'))


def test_패션플러스_행은_네이버페이_정돈_배송확정_상품ID_를_켠다() -> None:
    fp = Sources.load(DEFAULT_ROOT).by_id('패션플러스')
    assert fp is not None and fp.id == 'FashionPlus'
    assert fp.pay_provider == 'naver'
    assert fp.order_prep and fp.shipping_confirm and fp.payment_quotes
    assert fp.order_prep_script == 'fashionplus_order_prep'
    assert fp.confirm_shipping_script == 'fashionplus_confirm_shipping'
    assert fp.checkout_script_name == 'checkout_enter_fashionplus'


def test_패션플러스_스냅샷_sku_는_상품번호다() -> None:
    order = OrderRef.model_validate(
        {
            'order_no': 'A1',
            'source': 'FashionPlus',
            'seller': '포이즌',
            'sku': 'x',
            'qty': 1,
            'product_url': PRODUCT + '?utm=1',
        }
    )
    assert '"sku": "12345678"' in snapshot_args('buyer.fashionplus', order)


def test_패션플러스_주문서_탭도_스냅샷_전에_닫는다() -> None:
    pat = _close_re()
    assert pat.search(ORDER_FORM)
    # 상품·주문 관리·주문 상세 탭은 닫지 않는다
    assert not pat.search(PRODUCT)
    assert not pat.search('https://www.fashionplus.co.kr/mypage/order')
    assert not pat.search('https://www.fashionplus.co.kr/mypage/order/detail/87654321')
    # 기존 사이트 주문서는 그대로 닫힌다
    assert pat.search('https://pay.ssg.com/order/ordPage.ssg?ordKey=1')


def test_패션플러스_상품번호는_goods_detail_이다() -> None:
    assert product_no_of(PRODUCT) == '12345678'
    assert product_no_of(PRODUCT + '?x=1') == '12345678'
    assert product_no_of('https://www.musinsa.com/products/5837910') == '5837910'


def test_상품_전체_품절은_sold_out_참이고_선택지가_없을_때만이다() -> None:
    assert snapshot_sold_out(SOLD_SNAP)
    # 선택지가 하나라도 읽혔으면 확증이 아니다
    assert not snapshot_sold_out({**SOLD_SNAP, 'options': ['BLACK / 250']})
    # 참 비슷한 값(문자열)은 받지 않는다
    assert not snapshot_sold_out({**SOLD_SNAP, 'sold_out': 'true'})
    assert not snapshot_sold_out({'options': [], 'note': 'no options'})


def test_상품_전체_품절이면_스냅샷_수리를_하지_않는다() -> None:
    assert snapshot_problem('BLACK 250')(SOLD_SNAP) is None
    assert snapshot_problem(None)(SOLD_SNAP) is None
    # 표시 없이 선택지만 비면 여전히 수리 대상
    assert snapshot_problem('BLACK 250')({'options': [], 'note': 'no options'}) is not None


def test_상품_전체_품절_사유는_확정_품절로_본다() -> None:
    assert is_confirmed_sold_out_skip(f'buyer01: {SOLD_OUT_PRODUCT_SKIP} (SOLD OUT)')


@pytest.fixture()
def buyer(monkeypatch) -> BuyerAgent:
    reg = Registry.load(DEFAULT_ROOT)
    spec = reg['buyer.fashionplus']
    agent = BuyerAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: None,  # type: ignore[arg-type,return-value]
    )
    agent._dry_run = False
    agent.evidence = []
    agent._quote_errors = []
    agent._quote_skips = []
    cls = type(agent)
    monkeypatch.setattr(cls, '_payable_providers', lambda self, acc: None)
    monkeypatch.setattr(cls, '_allowed_providers', lambda self, acc=None: None)
    monkeypatch.setattr(cls, '_login_as', lambda self, acc: None)

    def no_ai(self: BuyerAgent, options: list[str], wanted: str | None) -> list[str]:
        raise AssertionError('상품 전체 품절에서 옵션 대조(AI 매칭)까지 가면 안 된다')

    monkeypatch.setattr(cls, '_match_options', no_ai)
    return agent


def _assignment(buyer: BuyerAgent) -> Assignment:
    order = OrderRef(
        order_no='A1',
        source='FashionPlus',
        seller='포이즌',
        sku='12345678',
        qty=1,
        option='BLACK 250',
        product_url=PRODUCT,
    )
    return Assignment(order=order, allowed_tools=buyer.spec.tools, rules='', dry_run=False)


def test_견적에서_상품_전체_품절은_옵션_대조_없이_확정_품절_사유로_남긴다(
    buyer, monkeypatch
) -> None:
    monkeypatch.setattr(BuyerAgent, '_snapshot', lambda self, a, acc: dict(SOLD_SNAP))
    assert buyer._quote(_assignment(buyer), 'buyer01') is None
    assert len(buyer._quote_skips) == 1
    assert is_confirmed_sold_out_skip(buyer._quote_skips[0])


def test_모든_계정이_상품_전체_품절이면_확정_품절로_끝난다(buyer, monkeypatch) -> None:
    monkeypatch.setattr(BuyerAgent, '_snapshot', lambda self, a, acc: dict(SOLD_SNAP))
    with pytest.raises(AgentFailure) as e:
        buyer._pick_cheapest(_assignment(buyer), ACCOUNTS)
    assert e.value.reason.startswith(CONFIRMED_SOLD_OUT)
    assert e.value.fail_reason is FailReason.OUT_OF_STOCK
