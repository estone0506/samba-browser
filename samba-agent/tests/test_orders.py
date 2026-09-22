# 주문 조회 — 정상 / 누락 필드 options 보완 / 그래도 누락 / 권한 부족 / 개인정보 미포함
import json

import httpx
import pytest
import respx
from pydantic import ValidationError

from samba_agent.agents.contracts import OrderRef
from samba_agent.bridge.client import BridgeClient, BridgeError
from samba_agent.failures import FailReason
from samba_agent.queue.orders import LOOKUP_TOOLS, ORDERS_URL, focus_orders_page, lookup_order

URL = 'http://127.0.0.1:47811'


def client() -> BridgeClient:
    return BridgeClient(URL, 'a' * 64, allowed=list(LOOKUP_TOOLS), busy_wait_s=0.0)


def ok(result: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': result, 'steps': []})


ORDERS_TAB = {'id': 't1', 'kind': 'tab', 'url': ORDERS_URL, 'active': True}


@pytest.fixture(autouse=True)
def orders_tab():
    # 기본: 삼바웨이브 주문 탭이 이미 앞에 있다 — 조회는 list_tabs 1회 뒤 바로 스크립트다
    with respx.mock(assert_all_called=False) as m:
        m.post(f'{URL}/tool/list_tabs').mock(return_value=ok(json.dumps([ORDERS_TAB])))
        yield m


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

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith('/list_tabs'):
            return ok(json.dumps([ORDERS_TAB]))
        return httpx.Response(200, json={'ok': True, 'result': json.dumps(body), 'steps': []})

    client = BridgeClient(
        'http://127.0.0.1:1',
        'x' * 64,
        allowed=list(LOOKUP_TOOLS),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    ref = lookup_order(client, '20260922BBAE44', {})
    assert ref.source == 'ABC마트'
    assert ref.seller == '신세계몰(seller01)'
    assert ref.sku == '나이키 코르테즈 [265]'
    assert ref.qty == 1


def test_주문_탭이_뒤에_있으면_앞으로_가져온다(orders_tab):
    tabs = [
        {'id': 'm', 'kind': 'tab', 'url': 'https://www.musinsa.com/p/1', 'active': True},
        {**ORDERS_TAB, 'active': False},
    ]
    orders_tab.post(f'{URL}/tool/list_tabs').mock(return_value=ok(json.dumps(tabs)))
    switch = orders_tab.post(f'{URL}/tool/switch_tab').mock(return_value=ok('ok'))
    focus_orders_page(client())
    assert json.loads(switch.calls[0].request.content)['args'] == {'id': 't1'}


def test_주문_탭이_없으면_새로_열고_기다린다(orders_tab):
    tabs = [
        {'id': 'm', 'kind': 'tab', 'url': 'https://www.musinsa.com/p/1', 'active': True},
        {'id': 'p', 'kind': 'popup', 'url': ORDERS_URL, 'active': False},  # 팝업은 후보가 아니다
    ]
    orders_tab.post(f'{URL}/tool/list_tabs').mock(return_value=ok(json.dumps(tabs)))
    new_tab = orders_tab.post(f'{URL}/tool/new_tab').mock(return_value=ok('ok: tab n1'))
    wait = orders_tab.post(f'{URL}/tool/wait').mock(return_value=ok('ok'))
    focus_orders_page(client())
    assert json.loads(new_tab.calls[0].request.content)['args'] == {'url': ORDERS_URL}
    assert wait.called


def test_조회는_탭을_앞에_둔_뒤_스크립트를_돌린다(orders_tab):
    orders_tab.post(f'{URL}/tool/run_script').mock(
        return_value=found({'source': '무신사', 'seller': '포이즌', 'sku': 'SKU1', 'qty': 1})
    )
    lookup_order(client(), '1001', {})
    names = [c.request.url.path.rsplit('/', 1)[-1] for c in orders_tab.calls]
    assert names == ['list_tabs', 'run_script']
