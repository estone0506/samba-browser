# 주문 조회 — 정상 / 누락 필드 options 보완 / 그래도 누락 / 권한 부족 / 개인정보 미포함
import json

import httpx
import pytest
import respx
from pydantic import ValidationError

from samba_agent.agents.contracts import OrderRef
from samba_agent.bridge.client import BridgeClient, BridgeError
from samba_agent.failures import FailReason
from samba_agent.queue.orders import lookup_order

URL = 'http://127.0.0.1:47811'


def client() -> BridgeClient:
    return BridgeClient(URL, 'a' * 64, allowed=['run_script'], busy_wait_s=0.0)


def found(body: dict) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': json.dumps(body), 'steps': []})


@respx.mock
def test_정상_조회():
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=found({'source': '무신사', 'seller': '포이즌', 'sku': 'SKU1', 'qty': 2})
    )
    ref = lookup_order(client(), '1001', {})
    assert ref.order_no == '1001'
    assert (ref.source, ref.seller, ref.sku, ref.qty) == ('무신사', '포이즌', 'SKU1', 2)


@respx.mock
def test_누락_필드는_options_로_보완한다():
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=found({'source': '무신사', 'sku': 'SKU1', 'qty': 1})
    )
    ref = lookup_order(client(), '1001', {'seller': '포이즌'})
    assert ref.seller == '포이즌'


@respx.mock
def test_options_로도_안_채워지면_실패한다():
    respx.post(f'{URL}/tool/run_script').mock(return_value=found({'source': '무신사'}))
    with pytest.raises(ValueError, match='order lookup incomplete'):
        lookup_order(client(), '1001', {})


@respx.mock
def test_권한_부족은_BridgeError_로_전파된다():
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=httpx.Response(403, json={'error': 'forbidden'})
    )
    with pytest.raises(BridgeError) as e:
        lookup_order(client(), '1001', {})
    assert e.value.reason is FailReason.PERMISSION_DENIED


def test_OrderRef_는_qty_0_을_거부한다():
    with pytest.raises(ValidationError):
        OrderRef(order_no='1001', source='무신사', seller='포이즌', sku='SKU1', qty=0)


@respx.mock
def test_qty_가_1_미만이면_실패한다():
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=found({'source': '무신사', 'seller': '포이즌', 'sku': 'SKU1', 'qty': 0})
    )
    with pytest.raises(ValueError, match='qty'):
        lookup_order(client(), '1001', {})


@respx.mock
def test_결과에_개인정보가_있어도_OrderRef_에는_없다():
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=found(
            {
                'source': '무신사',
                'seller': '포이즌',
                'sku': 'SKU1',
                'qty': 1,
                'customerName': '홍길동',
                'phone': '010-1234-5678',
                'address': '서울시 어딘가',
            }
        )
    )
    ref = lookup_order(client(), '1001', {})
    dumped = ref.model_dump()
    assert set(dumped) == {'order_no', 'source', 'seller', 'sku', 'qty'}
    assert '홍길동' not in str(ref)


def test_스크립트가_별칭_키로_돌려줘도_OrderRef_를_만든다():
    """실기: samba_find_order 가 sourcingPlatform·sellerAccount·option 키로 돌려줬다."""
    import json

    import httpx

    from samba_agent.bridge.client import BridgeClient
    from samba_agent.queue.orders import lookup_order

    body = {
        'found': True,
        'productOrderNo': '20260922BBAE44',
        'market': 'ABCmart',
        'sellerAccount': '신세계몰(seller01)',
        'qty': 1,
        'productName': '나이키 코르테즈',
        'option': '265',
        'sourcingPlatform': 'ABC마트',
        'sourcingAccount': 'ABCmart · 사무(mjkim88)',
    }

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={'ok': True, 'result': json.dumps(body), 'steps': []})

    client = BridgeClient(
        'http://127.0.0.1:1',
        'x' * 64,
        allowed=['run_script'],
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    ref = lookup_order(client, '20260922BBAE44', {})
    assert ref.source == 'ABC마트'
    assert ref.seller == '신세계몰(seller01)'
    assert ref.sku == '나이키 코르테즈 [265]'
    assert ref.qty == 1
