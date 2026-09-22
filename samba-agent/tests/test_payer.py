# 결제 에이전트 — dry-run / 정상 / 카드 없음 / 캡차 / 승인 거절 / 성공 문구 미확인
import json

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


def assignment(reg, *, dry_run: bool, card: str | None = '현대', handoff=None) -> Assignment:
    spec = reg['payer']
    return Assignment(
        order=ORDER,
        options={'card': card} if card else {},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
        handoff={'cost': 89000, 'pay_provider': 'toss', **(handoff or {})},
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
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(
        side_effect=[page('결제 진행 중'), page('결제 완료되었습니다')]
    )
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
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('declined: 한도 초과'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.UNKNOWN


@respx.mock
def test_성공_문구를_못_보면_ok_를_내지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('처리 중입니다'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.VERIFY_MISMATCH)
    assert '결제됐는지' in out.reason


@respx.mock
def test_결제_응답에_비밀값이_실리지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    body = fill.calls.last.request.content.decode('utf-8')
    assert 'password' not in body.lower() or '"value"' not in body  # 값을 보내지 않는다
    assert 'pin' not in str(out.payload).lower()
    assert not find_leaks(out.payload)
    assert not find_leaks(out.reason)
    assert not find_leaks([e.detail for e in out.evidence])


@respx.mock
def test_결제창_진입_인자는_카드명에_따옴표가_있어도_유효한_JSON이다(reg):
    """수기 문자열 포맷 대신 json.dumps 를 쓴다 — 카드명에 따옴표가 섞여도 깨지지 않는다."""
    enter = respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=True, card='현대"카드'))
    assert out.status == 'ok'
    body = json.loads(enter.calls.last.request.content.decode('utf-8'))
    script_args = json.loads(
        body['args']['args']
    )  # 스크립트 args 자체도 유효 JSON 문자열이어야 한다
    assert script_args == {'card': '현대"카드'}


@respx.mock
def test_카드_요구_거절은_카드_없음으로_분류한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('refused: card-required - call again with card set')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@respx.mock
def test_카드를_못_찾으면_카드_없음으로_분류한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('refused: card-not-found')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@pytest.mark.parametrize(
    ('refusal', 'reason'),
    [
        ('refused: pay-account-ambiguous (choose payAccount: a, b)', FailReason.UNKNOWN),
        ('refused: pay-account-mismatch (a != b)', FailReason.UNKNOWN),
        ('refused: no-account', FailReason.UNKNOWN),
        # 금고 잠김은 다시 해도 같다 — 권한 부족으로 분류해 재시도를 막는다(리뷰 지적 — I5)
        ('refused: vault-locked', FailReason.PERMISSION_DENIED),
        ('refused: verify-failed', FailReason.UNKNOWN),
    ],
)
@respx.mock
def test_계정_모호_불일치_잠김_인증실패는_사람에게_넘기고_사유를_담는다(reg, refusal, reason):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page(refusal))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', reason)
    # refused: 뒤 사유 원문(비밀 없음)이 reason 에 남는다 — 사람이 무엇 때문인지 바로 안다
    assert refusal.removeprefix('refused:').strip()[:20] in out.reason


@respx.mock
def test_거절_한글_표기도_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('refused: 거절됨'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)


@respx.mock
def test_결제_에이전트는_재시도하지_않는다(reg):
    """등록부 payer 행의 retry 가 0 이다. 폰 승인이 거절돼도 다시 부르지 않고 그대로 사람에게 넘긴다
    (같은 주문 재결제 방지). 중복 주문 자체의 차단은 큐(order_no UNIQUE, queue/db.py)의 몫이라
    이 에이전트 범위 밖이다 — 여기서는 한 번의 실행 안에서 도구를 다시 부르지 않는 것만 본다.
    """
    spec = reg['payer']
    assert spec.retry == 0
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
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


@respx.mock
def test_이미_결제된_화면이면_폰_승인을_부르지_않는다(reg):
    # 리뷰 지적 — Critical 2 ③: 폰 승인 전에 주문 상세를 1회 읽어 재결제를 막는다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 완료되었습니다'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PAY_INTERRUPTED)
    assert not pay.called
    assert not fill.called


@respx.mock
def test_요청자가_카드를_안_주면_구매가_고른_카드로_결제한다(reg):
    # 리뷰 지적 — C3: options 에 카드가 없으면 인계값의 카드를 쓴다
    enter = respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=True, card=None, handoff={'card': '현대'}))
    assert out.status == 'ok'
    body = json.loads(enter.calls.last.request.content.decode('utf-8'))
    assert json.loads(body['args']['args'])['card'] == '현대'


@respx.mock
def test_성공_화면에서_소싱_주문번호를_뽑아_넘긴다(reg):
    # 리뷰 지적 — I2: 아무도 source_order_no 를 만들지 않아 기록·검증이 비어 있었다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[7] textbox "이름"'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(
        side_effect=[page('결제 진행 중'), page('결제 완료되었습니다 주문번호 M-20260922-77')]
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['source_order_no'] == 'M-20260922-77'


# 앱 스키마(src/main/agent/tools.ts fill_secret · tools-phone.ts phone_approve_payment)
FILL_SECRET_KEYS = {'elementId', 'itemType', 'field', 'accountLabel', 'provider', 'format'}
PAY_KEYS = {'provider', 'amountKrw', 'merchant', 'methodLabel', 'card', 'payAccount'}
PAY_PROVIDERS = {'toss', 'payco', 'kakaopay', 'naverpay'}
ITEM_TYPES = {'login', 'password', 'card', 'note', 'identity', 'document'}


def _args(route) -> dict:
    return json.loads(route.calls.last.request.content.decode('utf-8'))['args']


def _full_pay_mocks():
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(
        return_value=page('INTERACTIVE ELEMENTS:\n[12] textbox "주문자 이름"')
    )
    respx.post(f'{URL}/tool/get_page').mock(
        side_effect=[page('결제 진행 중'), page('결제 완료 주문번호 M-1')]
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    return fill, pay


@respx.mock
def test_fill_secret_인자가_앱_스키마와_맞는다(reg):
    # 리뷰 지적 — I6: 필수 elementId·itemType 없이 부르면 앱이 400 이다
    fill, _pay = _full_pay_mocks()
    out = agent(reg)(assignment(reg, dry_run=False, handoff={'pay_provider': 'toss'}))
    assert out.status == 'ok'
    args = _args(fill)
    assert set(args) <= FILL_SECRET_KEYS
    assert isinstance(args['elementId'], int)
    assert args['elementId'] == 12
    assert args['itemType'] in ITEM_TYPES
    assert args['itemType'] == 'identity'


@respx.mock
def test_phone_approve_payment_인자가_앱_스키마와_맞는다(reg):
    # 리뷰 지적 — I7: provider enum · 양의 정수 amountKrw · merchant · methodLabel 이 필수다
    _fill, pay = _full_pay_mocks()
    out = agent(reg)(assignment(reg, dry_run=False, card='토스페이', handoff={'cost': 89000}))
    assert out.status == 'ok'
    args = _args(pay)
    assert set(args) <= PAY_KEYS
    assert args['provider'] in PAY_PROVIDERS
    assert args['provider'] == 'toss'
    assert isinstance(args['amountKrw'], int) and args['amountKrw'] == 89000
    assert args['merchant'] == '무신사'
    assert args['methodLabel'] == '토스페이'


@respx.mock
def test_카드_브랜드는_결제앱_안에서_고를_카드로_넘긴다(reg):
    _fill, pay = _full_pay_mocks()
    out = agent(reg)(
        assignment(
            reg, dry_run=False, card='현대', handoff={'cost': 89000, 'pay_provider': '토스페이'}
        )
    )
    assert out.status == 'ok'
    args = _args(pay)
    assert args['provider'] == 'toss'
    assert args['card'] == '현대'


@respx.mock
def test_금액을_모르면_결제하지_않는다(reg):
    # amountKrw 는 양의 정수여야 한다 — 모르면 결제 자체를 하지 않는다
    _fill, pay = _full_pay_mocks()
    out = agent(reg)(assignment(reg, dry_run=False, handoff={'cost': None, 'pay_provider': 'toss'}))
    assert out.status == 'needs_human'
    assert not pay.called


@respx.mock
def test_결제앱을_정할_수_없으면_결제하지_않는다(reg):
    _fill, pay = _full_pay_mocks()
    out = agent(reg)(
        assignment(reg, dry_run=False, card='현대', handoff={'cost': 89000, 'pay_provider': None})
    )
    assert out.status == 'needs_human'
    assert not pay.called


@respx.mock
def test_신원정보_입력칸을_못_찾으면_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('no element matches "이름"'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, handoff={'pay_provider': 'toss'}))
    assert out.status == 'needs_human'
    assert not fill.called
    assert not pay.called
