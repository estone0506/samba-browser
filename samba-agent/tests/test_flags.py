"""가격X·재고X 표시 — 토글 버튼이라 이미 붙어 있으면 누르지 않고, 누른 뒤 태그로 확인한다."""

import json

from samba_agent.wave.client import WaveOrderDetail, infer_musinsa_product_id
from samba_agent.wave.flags import FlagMarker, flag_for


class _Wave:
    def __init__(self, tags: list[str]) -> None:
        self.tags = tags
        self.cancelled: list[tuple[str, str]] = []

    def set_cancel_requested(self, order_no: str, reason: str) -> bool:
        self.cancelled.append((order_no, reason))
        return True

    def get_order(self, order_no: str) -> WaveOrderDetail:
        return WaveOrderDetail(order_number=order_no, action_tag=','.join(self.tags))


def test_실패_사유별_표시():
    assert flag_for('margin') == ('no_price', '가격X')
    assert flag_for('out_of_stock') == ('no_stock', '재고X')
    assert flag_for('unknown') is None
    assert flag_for(None) is None


def test_태그가_없으면_누르고_되읽어_확인한다():
    wave = _Wave(['kkadaegi'])
    calls: list[tuple[str, dict[str, object]]] = []

    def run(name: str, args: dict[str, object]) -> str:
        calls.append((name, args))
        wave.tags.append('no_price')
        return json.dumps({'ok': True})

    out = FlagMarker(wave, run).mark('A1', 'margin')  # type: ignore[arg-type]
    assert out == '가격X 표시함 · 취소요청으로 바꿈'
    assert wave.cancelled == [('A1', 'margin')]
    assert calls == [('samba_set_flag', {'orderNo': 'A1', 'label': '가격X'})]


def test_이미_붙어_있으면_누르지_않는다():
    """토글이라 다시 누르면 꺼진다."""
    calls: list[str] = []
    marker = FlagMarker(_Wave(['no_stock']), lambda n, a: calls.append(n) or '{}')  # type: ignore[arg-type]
    assert marker.mark('A1', 'out_of_stock') == '재고X 이미 표시됨 · 취소요청으로 바꿈'
    assert calls == []


def test_눌렀는데_태그가_없으면_확인_필요로_남긴다():
    marker = FlagMarker(_Wave([]), lambda n, a: json.dumps({'ok': True}))  # type: ignore[arg-type]
    assert '확인 필요' in (marker.mark('A1', 'margin') or '')


def test_해당_없는_사유는_아무것도_안_한다():
    marker = FlagMarker(_Wave([]), lambda n, a: 1 / 0)  # type: ignore[arg-type]
    assert marker.mark('A1', 'captcha') is None


def test_상품명_끝_숫자로_무신사_상품번호를_추정한다():
    """소싱처 미등록 주문(사용자 2026-09-25) — 10자리 품번은 건너뛰고 마지막 5~8자리 숫자."""
    assert infer_musinsa_product_id('매장정품 르무통 LEMOUTON 5009530519 메이트 오렌지 3347853') == '3347853'
    assert infer_musinsa_product_id('남자데님팬츠 05415547 와이드 쿨 데님 415547 3colo') == '415547'
    assert infer_musinsa_product_id('나이키 에어포스') is None
    o = WaveOrderDetail(order_number='N', source_site='', product_name='르무통 메이트 블랙 3347848')
    assert (o.source_site, o.source_url, o.source_inferred) == (
        'MUSINSA',
        'https://www.musinsa.com/products/3347848',
        True,
    )
    kept = WaveOrderDetail(order_number='K', source_site='29CM', product_name='티셔츠 1234567')
    assert (kept.source_site, kept.source_inferred) == ('29CM', False)
