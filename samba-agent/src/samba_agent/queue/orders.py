"""주문번호 → OrderRef 조회.

슬랙 명령은 주문번호만 준다. 감독자 배정(등록부 조건)에는 소싱처·판매처·SKU·수량이
필요해서 앱의 저장 스크립트 `samba_find_order` 로 읽어온다. 결과에 고객 이름·전화·주소가
섞여 있어도 OrderRef 에는 올리지 않는다 — 개인정보는 애초에 그래프 상태에 담지 않는다
(계획 문서 Global Constraints).
"""

import json
from collections.abc import Mapping

from samba_agent.agents.contracts import OrderRef
from samba_agent.bridge.client import BridgeClient

FIND_ORDER_SCRIPT = 'samba_find_order'
# OrderRef 를 채우는 데 필요한 필드만 본다 — 결과에 다른 키(개인정보 등)가 있어도 무시한다
_REQUIRED_FIELDS = ('source', 'seller', 'sku', 'qty')
# 앱 저장 스크립트(samba_find_order)는 사람이 고쳐 쓰는 것이라 키 이름이 흔들린다 — 별칭을 받아 준다
_ALIASES: dict[str, tuple[str, ...]] = {
    'source': ('source', 'sourcingPlatform', 'sourcing_platform', 'sourcing'),
    'seller': ('seller', 'sellerAccount', 'seller_account', 'market'),
    'qty': ('qty', 'quantity', 'count'),
}


def _normalize(data: dict[str, object]) -> dict[str, object]:
    """별칭 키를 표준 키로 옮기고, sku 가 없으면 상품명+옵션으로 만든다. 개인정보 키는 옮기지 않는다."""
    out: dict[str, object] = dict(data)
    for field, names in _ALIASES.items():
        if out.get(field) in (None, ''):
            for n in names:
                if data.get(n) not in (None, ''):
                    out[field] = data[n]
                    break
    if out.get('sku') in (None, ''):
        name = next(
            (str(data[k]) for k in ('productName', 'product', 'name', 'title') if data.get(k)), ''
        )
        option = str(data.get('option') or data.get('optionText') or '').strip()
        sku = (name + (f' [{option}]' if option else '')).strip()
        if sku:
            out['sku'] = sku
    return out


def lookup_order(bridge: BridgeClient, order_no: str, options: Mapping[str, str]) -> OrderRef:
    """브릿지로 주문을 찾아 OrderRef 를 만든다.

    결과 JSON 에 필드가 없으면 ``options`` 의 같은 키로 보완하고, 그래도 없으면
    ``ValueError`` 다. 브릿지 오류(권한 부족 등)는 ``BridgeError`` 그대로 전파한다.
    """
    result = bridge.call(
        'run_script', name=FIND_ORDER_SCRIPT, args=json.dumps({'orderNo': order_no})
    )
    try:
        data = json.loads(result.result)
    except ValueError as e:
        raise ValueError(f'{order_no} 조회 결과가 JSON 이 아니다') from e
    if not isinstance(data, dict):
        # TRY004 무시 — 스키마 오류도 lookup_order 는 전부 ValueError 하나로 통일한다
        raise ValueError(f'{order_no} 조회 결과가 객체가 아니다')  # noqa: TRY004

    data = _normalize(data)
    values: dict[str, object] = {}
    missing: list[str] = []
    for field in _REQUIRED_FIELDS:
        value = data.get(field)
        if value in (None, ''):
            value = options.get(field)
        if value in (None, ''):
            missing.append(field)
        else:
            values[field] = value
    if missing:
        raise ValueError(f'order lookup incomplete: {", ".join(missing)}')

    qty = int(values['qty'])  # type: ignore[arg-type]
    if qty < 1:
        raise ValueError(f'{order_no} qty 는 1 이상이어야 한다 (받은 값: {qty})')

    return OrderRef(
        order_no=order_no,
        source=str(values['source']),
        seller=str(values['seller']),
        sku=str(values['sku']),
        qty=qty,
    )
