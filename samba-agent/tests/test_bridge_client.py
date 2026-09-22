# 브릿지 클라이언트 — 성공 / 없는 도구 / 허용 목록 밖 / 401 / 409 재시도 / 504 / 연결 실패
import httpx
import pytest
import respx

from samba_agent.bridge.client import BridgeClient, BridgeError
from samba_agent.failures import FailReason

URL = 'http://127.0.0.1:47811'
TOKEN = 'a' * 64
ALL_TOOLS = ['get_page', 'run_script', 'click', 'phone_approve_payment']


def client(**kw) -> BridgeClient:
    return BridgeClient(URL, TOKEN, allowed=ALL_TOOLS, busy_wait_s=0.0, **kw)


@respx.mock
def test_성공하면_본문과_진행로그를_준다():
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(
            200,
            json={
                'ok': True,
                'result': '페이지 본문',
                'steps': [{'label': '페이지 읽기', 'ok': True}],
            },
        )
    )
    r = client().call('get_page')
    assert r.result == '페이지 본문'
    assert r.steps == (('페이지 읽기', True),)


@respx.mock
def test_토큰_헤더를_붙이고_args_로_감싼다():
    route = respx.post(f'{URL}/tool/run_script').mock(
        return_value=httpx.Response(200, json={'ok': True, 'result': 'ok', 'steps': []})
    )
    client().call('run_script', name='samba_find_order', args='{"orderNo":"1"}')
    req = route.calls.last.request
    assert req.headers['X-Samba-Token'] == TOKEN
    import json as _json

    assert _json.loads(req.content) == {
        'args': {'name': 'samba_find_order', 'args': '{"orderNo":"1"}'}
    }


@respx.mock
def test_허용_목록_밖_도구는_호출도_안_하고_권한부족():
    route = respx.post(f'{URL}/tool/click')
    scoped = client().scoped(['get_page'])
    with pytest.raises(BridgeError) as e:
        scoped.call('click', id=1, label='구매')
    assert e.value.reason is FailReason.PERMISSION_DENIED
    assert e.value.status is None
    assert not route.called  # 나가지 않았다


@respx.mock
@pytest.mark.parametrize('status', [401, 403, 404])
def test_권한_계열_응답은_permission_denied(status):
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(status, json={'error': 'unauthorized'})
    )
    with pytest.raises(BridgeError) as e:
        client().call('get_page')
    assert e.value.reason is FailReason.PERMISSION_DENIED
    assert e.value.status == status


@respx.mock
def test_409_는_재시도하고_성공하면_통과한다():
    route = respx.post(f'{URL}/tool/get_page')
    route.side_effect = [
        httpx.Response(409, json={'error': 'busy'}),
        httpx.Response(409, json={'error': 'busy'}),
        httpx.Response(200, json={'ok': True, 'result': '본문', 'steps': []}),
    ]
    assert client().call('get_page').result == '본문'
    assert route.call_count == 3


@respx.mock
def test_409_가_계속되면_bridge_down_이다():
    # 앱이 읽기 전용 모드면 세션을 못 열어 계속 409 다(스펙 §7 권한 부족)
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(409, json={'error': 'busy'})
    )
    with pytest.raises(BridgeError) as e:
        client(busy_retries=2).call('get_page')
    assert e.value.reason is FailReason.BRIDGE_DOWN
    assert e.value.status == 409


@respx.mock
def test_504_와_500_구분():
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(504, json={'ok': False, 'error': 'tool timeout'})
    )
    with pytest.raises(BridgeError) as e:
        client().call('get_page')
    assert e.value.reason is FailReason.BRIDGE_DOWN

    respx.post(f'{URL}/tool/click').mock(
        return_value=httpx.Response(500, json={'ok': False, 'error': 'boom'})
    )
    with pytest.raises(BridgeError) as e2:
        client().call('click', id=1, label='x')
    assert e2.value.reason is FailReason.UNKNOWN
    assert 'boom' in str(e2.value)


@respx.mock
def test_앱이_꺼져_있으면_bridge_down():
    respx.post(f'{URL}/tool/get_page').mock(side_effect=httpx.ConnectError('refused'))
    with pytest.raises(BridgeError) as e:
        client().call('get_page')
    assert e.value.reason is FailReason.BRIDGE_DOWN


@respx.mock
def test_health_는_도구_이름을_준다():
    respx.get(f'{URL}/health').mock(
        return_value=httpx.Response(200, json={'ok': True, 'tools': ['get_page', 'click']})
    )
    assert client().health() == ['get_page', 'click']


@respx.mock
def test_오류_메시지에_토큰이_새지_않는다():
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(401, json={'error': 'unauthorized'})
    )
    with pytest.raises(BridgeError) as e:
        client().call('get_page')
    assert TOKEN not in str(e.value)
    assert TOKEN not in repr(e.value)
