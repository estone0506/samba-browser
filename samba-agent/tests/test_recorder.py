# 기록 에이전트 — dry-run / 저장 후 재확인 / 재시도는 재저장 없이 재확인만 / 한 필드라도
# 다르면 실패 / 브릿지 끊김 / 타입 정규화 / 계정은 마스킹 없는 옵션에서 / 개인정보 미노출
import json

import httpx
import pytest
import respx

from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.recorder import SAVE_SCRIPT, RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)
ACCOUNT = 'sales-acct-01'  # 내부 판매 계정 식별자 — 고객 개인정보가 아니다
EMAIL_ACCOUNT = 'kimsun@example.com'  # 이메일 꼴 내부 계정 — 이래도 가려지면 안 된다
EXPECTED = {
    'source_order_no': 'M-777',
    'real_price': 89000,
    'shipping_fee': 0,
    'flags': '직배',
}
SAVED_VALUES = {**EXPECTED, 'account': ACCOUNT, 'memo': '포이즌 주문 자동 처리'}


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(reg, *, dry_run: bool, expected=None, account=ACCOUNT, handoff=None) -> Assignment:
    spec = reg['recorder']
    return Assignment(
        order=ORDER,
        options={'account': account} if account else {},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
        expected=EXPECTED if expected is None else expected,
        handoff=handoff or {},
    )


def agent(reg) -> RecorderAgent:
    spec = reg['recorder']
    return RecorderAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='포이즌 주문 자동 처리', reason='주문번호와 소싱처를 적었다'),
    )


def page(obj) -> httpx.Response:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@respx.mock
def test_dry_run_은_저장하지_않고_계획만_준다(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    save = respx.post(f'{URL}/tool/run_script')
    out = agent(reg)(assignment(reg, dry_run=True))
    assert out.status == 'ok'
    assert out.payload['planned']['source_order_no'] == 'M-777'
    assert out.payload['planned']['account'] == ACCOUNT
    assert not save.called


@respx.mock
def test_저장된_적_없으면_저장하고_각_필드를_다시_읽어_확인한다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    # 1) 기존 저장 확인(없음 — 빈 행) 2) 저장 3) 저장 확인(값 채워짐)
    route.side_effect = [page({}), page('saved'), page(SAVED_VALUES)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['saved'] is True
    assert out.payload['already_saved'] is False
    assert route.call_count == 3


@respx.mock
def test_이미_저장된_주문을_다시_호출해도_저장은_한_번뿐이다(reg):
    """재시도 = 재저장이 아니다 — 이미 저장된 주문이면 저장을 건너뛰고 재확인만 한다."""
    route = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))

    # 1회차: 저장 안 됨 → 저장 → 재확인
    route.side_effect = [page({}), page('saved'), page(SAVED_VALUES)]
    a = assignment(reg, dry_run=False)
    first = agent(reg)(a)
    assert first.status == 'ok'
    assert first.payload['already_saved'] is False

    # 2회차(재시도): 이미 저장돼 있음 → 저장을 부르지 않고 재확인만
    route.side_effect = [page(SAVED_VALUES)]
    second = agent(reg)(a)
    assert second.status == 'ok'
    assert second.payload['already_saved'] is True

    save_calls = [
        c
        for c in route.calls
        if json.loads(c.request.content)['args']['name'] == 'samba_save_order'
    ]
    assert len(save_calls) == 1


@respx.mock
def test_저장은_됐는데_되읽기만_어긋나도_재저장하지_않고_실패한다(reg):
    """ "저장은 됐는데 되읽기만 어긋난" 경우 — 재저장이 아니라 사람 확인으로 넘긴다."""
    route = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    wrong = {**SAVED_VALUES, 'real_price': 12345}
    # 이미 저장된 행이 있지만(존재함) 값이 다르다 — 저장을 다시 부르면 안 된다
    route.side_effect = [page(wrong)]
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert 'real_price' in out.reason
    save_calls = [
        c
        for c in route.calls
        if json.loads(c.request.content)['args']['name'] == 'samba_save_order'
    ]
    assert len(save_calls) == 0


@respx.mock
def test_한_필드라도_다르면_실패하고_재결제하지_않는다(reg):
    wrong = {**SAVED_VALUES, 'real_price': 12345}
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(wrong)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert 'real_price' in out.reason


@respx.mock
def test_되읽은_숫자와_문자열_타입이_달라도_같은_값이면_통과한다(reg):
    """숫자 필드는 캐스팅해서 비교하고, 문자열은 strip 해서 비교한다(타입 정규화)."""
    stringy = {
        **SAVED_VALUES,
        'real_price': '89000',  # 문자열이지만 숫자로는 같다
        'shipping_fee': '0',
        'memo': ' 포이즌 주문 자동 처리 ',  # 앞뒤 공백만 다르다
    }
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(stringy)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'


@respx.mock
def test_브릿지가_끊기면_bridge_down(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/run_script').mock(side_effect=httpx.ConnectError('refused'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.fail_reason is FailReason.BRIDGE_DOWN


@respx.mock
def test_허용_목록_밖_도구는_거절되고_저장을_시도하지_않는다(reg):
    """등록부 tools 를 progress 만 남기고 좁히면 run_script 조차 내보내지 않는다."""
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    save = respx.post(f'{URL}/tool/run_script')
    spec = reg['recorder'].model_copy(update={'tools': ('progress',)})
    restricted = RecorderAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='포이즌 주문 자동 처리', reason='주문번호와 소싱처를 적었다'),
    )
    out = restricted(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
    assert not save.called


@respx.mock
def test_이메일_꼴_계정이_마스킹_없이_그대로_저장된다(reg):
    """account 는 내부 판매 계정 식별자다 — expected(마스킹 거친 결과)가 아니라
    Assignment.options 에서 받아 이메일 꼴이어도 가려지지 않는다."""
    saved = {**EXPECTED, 'account': EMAIL_ACCOUNT, 'memo': '포이즌 주문 자동 처리'}
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(saved)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, account=EMAIL_ACCOUNT))
    assert out.status == 'ok'
    assert out.payload['values']['account'] == EMAIL_ACCOUNT


@respx.mock
def test_저장_결과에_개인정보가_남지_않는다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(SAVED_VALUES)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert find_leaks(out.payload) == []
    assert find_leaks(out.reason) == []
    assert find_leaks([e.detail for e in out.evidence]) == []


@respx.mock
def test_계정은_인계값에서_받아_저장한다(reg):
    # 리뷰 지적 — I1: options 에 account 를 채우는 곳이 없어 빈 계정으로 저장됐다
    saved: list[dict] = []

    def handler(request):
        body = json.loads(request.content.decode('utf-8'))
        args = json.loads(body['args']['args'])
        if body['args']['name'] == SAVE_SCRIPT:
            saved.append(args)
            return httpx.Response(200, json={'ok': True, 'result': 'saved', 'steps': []})
        stored = saved[-1] if saved else {}
        return httpx.Response(200, json={'ok': True, 'result': json.dumps(stored), 'steps': []})

    respx.post(f'{URL}/tool/run_script').mock(side_effect=handler)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(
        assignment(
            reg,
            dry_run=False,
            expected={'real_price': 89000, 'source_order_no': 'M-1', 'shipping_fee': 0},
            account=None,
            handoff={'account': 'samba01@wave.co.kr'},
        )
    )
    assert out.status == 'ok'
    assert saved[0]['account'] == 'samba01@wave.co.kr'
