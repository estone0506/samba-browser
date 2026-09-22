# 결제 에이전트 — dry-run / 정상 / 카드 없음 / 캡차 / 승인 거절 / 성공 문구 미확인
import httpx
import pytest
import respx

from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(reg, *, dry_run: bool, card: str | None = '현대') -> Assignment:
    spec = reg['payer']
    return Assignment(
        order=ORDER,
        options={'card': card} if card else {},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
    )


def agent(reg) -> PayerAgent:
    spec = reg['payer']

    # 결제 에이전트는 LLM 을 쓰지 않는다 — decide 를 부르면 테스트가 터지게 둔다
    def never(_p, _m):
        raise AssertionError('결제 에이전트는 LLM 판단을 하지 않는다')

    return PayerAgent(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), never)


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@respx.mock
def test_dry_run_이면_결제하지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment')
    out = agent(reg)(assignment(reg, dry_run=True))
    assert out.status == 'ok'
    assert out.payload == {'dry_run': True, 'paid': False}
    assert not pay.called  # 외부를 바꾸지 않았다


@respx.mock
def test_실제_결제는_폰_승인까지_하고_성공_문구를_확인한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 완료되었습니다'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['paid'] is True
    assert pay.called
    # 한 번의 실행에서 폰 승인은 정확히 한 번만 — 같은 주문을 두 번 결제하지 않는다
    assert pay.calls.call_count == 1


@respx.mock
def test_카드가_없으면_시작도_하지_않는다(reg):
    enter = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card=None))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)
    assert not enter.called


@respx.mock
def test_캡차는_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('needs_user: 캡차'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.CAPTCHA)


@respx.mock
def test_폰_승인이_거절되면_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('declined: 한도 초과'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.UNKNOWN


@respx.mock
def test_성공_문구를_못_보면_ok_를_내지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('처리 중입니다'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.VERIFY_MISMATCH)
    assert '결제됐는지' in out.reason


@respx.mock
def test_결제_응답에_비밀값이_실리지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 완료'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    body = fill.calls.last.request.content.decode('utf-8')
    assert 'password' not in body.lower() or '"value"' not in body  # 값을 보내지 않는다
    assert 'pin' not in str(out.payload).lower()
    assert not find_leaks(out.payload)
    assert not find_leaks(out.reason)


@respx.mock
def test_결제_에이전트는_재시도하지_않는다(reg):
    """등록부 payer 행의 retry 가 0 이다. 폰 승인이 거절돼도 다시 부르지 않고 그대로 사람에게 넘긴다
    (같은 주문 재결제 방지). 중복 주문 자체의 차단은 큐(order_no UNIQUE, queue/db.py)의 몫이라
    이 에이전트 범위 밖이다 — 여기서는 한 번의 실행 안에서 도구를 다시 부르지 않는 것만 본다.
    """
    spec = reg['payer']
    assert spec.retry == 0
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('declined: 한도 초과')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert pay.calls.call_count == 1  # 거절돼도 다시 부르지 않는다


@respx.mock
def test_권한_부족이면_재시도_없이_바로_실패한다(reg):
    """브릿지가 401/403 을 돌려주면(토큰 오류·키마스터 잠김) 재시도 없이 바로 fail 이다."""
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=httpx.Response(403, json={'error': 'forbidden'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'fail'
    assert out.fail_reason == FailReason.PERMISSION_DENIED
