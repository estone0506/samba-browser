"""SSG 주문 이행 연동(2026-09-27) — 신세계몰 상품 찾기·진입 경로 비교·애드픽 적립·결제 진입 인자."""

import re

from samba_agent.agents.buyer import _CLOSE_ORDER_TABS_JS, product_no_of

SSG_ORDER = 'https://pay.ssg.com/order/ordPage.ssg?ordKey=1'
MALL_ITEM = 'https://shinsegaemall.ssg.com/item/itemView.ssg?itemId=1000012345678&siteNo=6004'


def _close_re() -> re.Pattern[str]:
    """주문서 탭 닫기 JS 의 정규식을 파이썬으로 옮긴다(JS 의 '\/' 는 '/')."""
    js = re.search(r'if \(/(.+?)/\.test', _CLOSE_ORDER_TABS_JS)
    assert js
    return re.compile(js.group(1).replace('\/', '/'))


def test_SSG_주문서_탭도_스냅샷_전에_닫는다() -> None:
    pat = _close_re()
    assert pat.search(SSG_ORDER)
    assert not pat.search(MALL_ITEM)  # 상품 탭은 닫지 않는다
    # 기존 사이트 주문서는 그대로 닫힌다
    assert pat.search('https://www.musinsa.com/order/order-form?x=1')


def test_SSG_상품번호는_itemId_다() -> None:
    assert product_no_of(MALL_ITEM) == '1000012345678'
    assert product_no_of('https://www.ssg.com/item/itemView.ssg?siteNo=6009&itemId=2000000000001') == '2000000000001'
    # 기존 규칙은 그대로
    assert product_no_of('https://www.musinsa.com/products/5837910') == '5837910'
