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
