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
        # 결제 앱(provider)은 여기서 사람이 정해 넘기지 않는다 — payer 가 카드 이름이나
        # 결제창(list_tabs) 을 보고 스스로 정한다(사용자 결정)
        handoff={'cost': 89000, **(handoff or {})},
    )


def agent(reg) -> PayerAgent:
    spec = reg['payer']

    # 결제 에이전트는 LLM 을 쓰지 않는다 — decide 를 부르면 테스트가 터지게 둔다
    def never(_p, _m):
        raise AssertionError('결제 에이전트는 LLM 판단을 하지 않는다')

    return PayerAgent(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), never)


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


# 결제창(팝업) 목록 흉내 — 앱 list_tabs(src/main/agent/tools.ts)가 돌려주는 모양(id·kind·title·url).
# popup_url 이 있으면 결제창 팝업 하나를 섞어 넣고, 없으면 탭만 돌려준다(결제창이 안 뜬 경우)
def list_tabs_page(popup_url: str | None) -> httpx.Response:
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com/order',
            'active': True,
        }
    ]
    if popup_url:
        targets.append(
            {'id': 'p1', 'kind': 'popup', 'title': '결제', 'url': popup_url, 'openerId': 't1'}
        )
    return page(json.dumps(targets, ensure_ascii=False))


TOSS_POPUP_URL = 'https://pay.toss.im/checkout'


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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
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


def _full_pay_mocks(popup_url: str | None = TOSS_POPUP_URL):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(popup_url))
    # 팝업이 0개일 때만 실제로 불린다(리뷰 지적 — Minor 4) — 다른 시나리오에서는 그냥 등록만 해 둔다
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
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
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    args = _args(fill)
    assert set(args) <= FILL_SECRET_KEYS
    assert isinstance(args['elementId'], int)
    assert args['elementId'] == 12
    assert args['itemType'] in ITEM_TYPES
    assert args['itemType'] == 'identity'


@respx.mock
def test_phone_approve_payment_인자가_앱_스키마와_맞는다(reg):
    # 리뷰 지적 — I7: provider enum · 양의 정수 amountKrw · merchant · methodLabel 이 필수다.
    # 카드 이름 자체가 결제 앱을 가리키면(토스페이) 결제창을 보지 않고 바로 정한다
    _fill, pay = _full_pay_mocks(popup_url=None)
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
    # 사용자 결정 — 결제 앱은 카드 이름이 아니라 결제창(팝업) 호스트로 정한다.
    # 결제수단 '현대카드' + 결제창 pay.toss.im 팝업 → provider toss 로 부른다
    _fill, pay = _full_pay_mocks(popup_url=TOSS_POPUP_URL)
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    args = _args(pay)
    assert args['provider'] == 'toss'
    assert args['card'] == '현대카드'


@respx.mock
def test_카드_이름이_네이버페이면_결제창_없이_바로_정한다(reg):
    # 결제수단 문자열에 이미 앱 이름이 있으면(네이버페이) 결제창을 보지 않고 그것을 우선한다.
    # payAccount 관련 코드는 전부 제거했다(리뷰 지적 — Critical 1) — 앱이 쇼핑몰 계정에 연결된
    # 네이버 계정으로 스스로 고른다. handoff 에 pay_account 값이 실려 와도(죽은 값) 절대
    # phone_approve_payment 로 넘어가지 않는다(inert 방지 — 꺼져 있는 게 아니라 없는지 본다)
    _fill, pay = _full_pay_mocks(popup_url=None)
    a = assignment(
        reg, dry_run=False, card='네이버페이', handoff={'cost': 89000, 'pay_account': 'acc-a'}
    )
    out = agent(reg)(a)
    assert out.status == 'ok'
    args = _args(pay)
    assert args['provider'] == 'naverpay'
    assert 'payAccount' not in args


@respx.mock
def test_토스여도_handoff에_pay_account가_있어도_넘기지_않는다(reg):
    # payAccount 는 앱 스키마상 네이버페이 전용이지만, 어떤 provider 에도 넘기지 않는 게
    # 사용자 결정이다(리뷰 지적 — Critical 1) — 토스에서도 죽은 값이 새 나가지 않는지 본다
    _fill, pay = _full_pay_mocks(popup_url=None)
    out = agent(reg)(
        assignment(
            reg, dry_run=False, card='토스페이', handoff={'cost': 89000, 'pay_account': 'acc-b'}
        )
    )
    assert out.status == 'ok'
    args = _args(pay)
    assert args['provider'] == 'toss'
    assert 'payAccount' not in args


@respx.mock
def test_금액을_모르면_결제하지_않는다(reg):
    # amountKrw 는 양의 정수여야 한다 — 모르면 결제 자체를 하지 않는다
    _fill, pay = _full_pay_mocks()
    out = agent(reg)(assignment(reg, dry_run=False, handoff={'cost': None}))
    assert out.status == 'needs_human'
    assert not pay.called


@respx.mock
def test_결제앱을_정할_수_없으면_폰_승인_없이_웹_결제_경로로_간다(reg):
    # 사용자 결정 — 결제창(팝업)이 없고 결제수단 문자열에도 앱 이름이 없으면(사이트 자체
    # 결제·카드 직접 결제) phone_approve_payment 를 부르지 않는다. 그래도 성공 문구를
    # 화면에서 확인하기 전에는 ok 를 내지 않는다
    _fill, pay = _full_pay_mocks(popup_url=None)
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert not pay.called


@respx.mock
def test_list_tabs가_실패하면_사람에게_넘긴다(reg):
    # 결제창을 못 본 채로 결제 앱을 찍어 승인하면 안 된다 — list_tabs 자체가 실패하면
    # (브릿지 오류 등) needs_human 이다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=httpx.Response(500, json={'error': 'boom'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
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
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert not fill.called
    assert not pay.called


@respx.mock
def test_list_tabs_실패_사유는_원래_fail_reason을_그대로_남긴다(reg):
    # 리뷰 지적 — Minor 3: list_tabs 의 AgentFailure 를 UNKNOWN 으로 재포장하지 않는다.
    # 403 은 브릿지가 PERMISSION_DENIED 로 분류한다(client.py) — needs_human 으로 넘어가도
    # 그 사유가 그대로 남아야 한다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=httpx.Response(403, json={'error': 'forbidden'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.PERMISSION_DENIED
    assert not pay.called


@respx.mock
def test_결제창이_아직_없으면_한번_기다렸다_다시_본다(reg):
    # 리뷰 지적 — Minor 4: run_script checkout_enter_* 직후 팝업이 0개면 바로 웹 경로로
    # 가지 않고 wait(2초) 후 list_tabs 를 한 번 더 본다. 두 번째에는 팝업이 잡힌다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    wait = respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    list_tabs = respx.post(f'{URL}/tool/list_tabs').mock(
        side_effect=[list_tabs_page(None), list_tabs_page(TOSS_POPUP_URL)]
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert wait.calls.call_count == 1
    assert json.loads(wait.calls.last.request.content.decode('utf-8'))['args'] == {'ms': 2000}
    assert list_tabs.calls.call_count == 2
    assert pay.called
    assert _args(pay)['provider'] == 'toss'


@respx.mock
def test_결제창이_끝내_안_뜨면_한번만_기다리고_웹_경로로_간다(reg):
    # 두 번째 list_tabs 도 팝업이 0개면 더 기다리지 않고(wait 는 딱 한 번) 웹 결제 경로로 간다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    wait = respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    list_tabs = respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(None))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert wait.calls.call_count == 1
    assert list_tabs.calls.call_count == 2
    assert not pay.called


def _list_tabs_with_two_popups(providers: tuple[str, str]) -> httpx.Response:
    """서로 다른 결제 호스트를 가리키는 팝업 두 개를 흉내 낸다. openerId 가 't1' 인데 't1' 은
    활성 탭이 아니다 — 활성 탭 우선 규칙으로 풀리지 않게 해서 provider 다름 판정을 본다."""
    hosts = {'toss': TOSS_POPUP_URL, 'naverpay': 'https://pay.naver.com/checkout'}
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com',
            'active': False,
        },
        {
            'id': 'p1',
            'kind': 'popup',
            'title': '결제1',
            'url': hosts[providers[0]],
            'openerId': 't1',
        },
        {
            'id': 'p2',
            'kind': 'popup',
            'title': '결제2',
            'url': hosts[providers[1]],
            'openerId': 't1',
        },
    ]
    return page(json.dumps(targets, ensure_ascii=False))


@respx.mock
def test_매칭_팝업이_둘이고_서로_다른_provider면_사람에게_넘긴다(reg):
    # 리뷰 지적 — Important 2: 팝업이 여럿이고 서로 다른 결제 앱을 가리키면 코드가 짐작하지
    # 않고 사람에게 넘긴다. 근거에 두 호스트가 남는다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=_list_tabs_with_two_popups(('toss', 'naverpay'))
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'needs_human'
    assert not pay.called
    assert 'pay.toss.im' in out.reason or 'tosspayments' in out.reason
    assert 'pay.naver.com' in out.reason


@respx.mock
def test_매칭_팝업이_여러개면_활성_탭이_연_팝업을_우선한다(reg):
    # 리뷰 지적 — Important 2: openerId 가 활성 탭인 팝업을 우선한다(같은 provider 중복이 아니라
    # 마지막이 다른 provider 여도 활성 탭 쪽을 쓴다)
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com',
            'active': False,
        },
        {
            'id': 't2',
            'kind': 'tab',
            'title': '29CM',
            'url': 'https://www.29cm.co.kr',
            'active': True,
        },
        {'id': 'p1', 'kind': 'popup', 'title': '결제1', 'url': TOSS_POPUP_URL, 'openerId': 't1'},
        {
            'id': 'p2',
            'kind': 'popup',
            'title': '결제2',
            'url': 'https://pay.naver.com/checkout',
            'openerId': 't2',
        },
    ]
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=page(json.dumps(targets, ensure_ascii=False))
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert _args(pay)['provider'] == 'naverpay'  # p2 를 연 t2 가 활성 탭이다


@respx.mock
def test_활성_탭이_연_팝업이_없으면_가장_최근_팝업을_쓴다(reg):
    # 매칭 팝업 둘 다 같은 provider 이고(중복 팝업), 어느 openerId 도 활성 탭이 아니면
    # 목록의 마지막(가장 최근에 뜬 것)을 쓴다
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com',
            'active': True,
        },
        {'id': 't2', 'kind': 'tab', 'title': '숨은 탭', 'url': 'about:blank', 'active': False},
        {'id': 'p1', 'kind': 'popup', 'title': '결제1', 'url': TOSS_POPUP_URL, 'openerId': 't2'},
        {
            'id': 'p2',
            'kind': 'popup',
            'title': '결제2(최근)',
            'url': 'https://tosspayments.com/checkout',
            'openerId': 't2',
        },
    ]
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('결제창 진입 ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=page(json.dumps(targets, ensure_ascii=False))
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert _args(pay)['provider'] == 'toss'
    assert _args(pay)['card'] == '현대카드'
