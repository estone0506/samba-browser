"""결제 에이전트 — 코드와 도구만 쓴다. LLM 판단이 없고, 재시도도 없다(등록부 payer 행 retry: 0).

비밀번호·카드번호는 여기를 지나가지 않는다. 앱의 fill_secret 과 phone_approve_payment 가
값을 직접 채우고 우리에게는 돌려주지 않는다(docs/bridge.md). 이 파일과 결과 payload 에는
카드 브랜드명만 남고, 실제 결제 성공 문구를 화면에서 확인하기 전에는 ok 를 내지 않는다.
"""

import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urlsplit

from samba_agent.agents.base import AgentBase, AgentFailure, run_agent, split_page_dialogs
from samba_agent.agents.buyer import POINTS_ONLY_METHOD
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text
from samba_agent.sources import default_sources
from samba_agent.wave.client import WaveClient, WaveError

# 결제 성공을 확인하는 문구. 이걸 보기 전에는 ok 를 내지 않는다(브리프 §완료조건)
# a-rt.com 주문내역 첫 주문(번호·일시·금액)을 읽는 run_js 본문 — 탭 열기 다음에 붙인다
_ART_RECENT_ORDER_JS = (
    "await sleep(4000)\n"
    "const t = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\\s+/g, ' ')\n"
    "const m = t.match(/주문번호 (\\d{10,}) 주문일시 (\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d) 총 결제금액 ([\\d,]+) 원/)\n"
    "return JSON.stringify(m ? { no: m[1], at: m[2], amount: m[3] } : {})"
)
# 한국 시간(윈도에 tzdata 가 없어 고정 오프셋)
_KST = timezone(timedelta(hours=9))

# 페이코 PC 결제창: 정보제공동의 체크박스를 켜고 '결제' 링크를 누르는 run_js 본문(탭 전환 다음에 붙인다)
_PAYCO_AGREE_PAY_JS = (
    "let tr = (await page.get({ interactive: true })).tree\n"
    "const cb = tr.match(/\\[(\\d+)\\] checkbox[^\\n]*/)\n"
    "if (cb && !/checked/.test(cb[0])) { await page.click(parseInt(cb[1])); await sleep(500) }\n"
    "tr = (await page.get({ interactive: true })).tree\n"
    "const pay = tr.match(/\\[(\\d+)\\] link \"결제\"/)\n"
    "if (!pay) return JSON.stringify({ clicked: false, note: 'no pay link' })\n"
    "await page.click(parseInt(pay[1])); await sleep(1500)\n"
    "return JSON.stringify({ clicked: true, agreed: !!cb })"
)

PAY_SUCCESS_MARKERS = ('결제 완료', '결제완료', '주문완료', '주문 완료', 'approved')
# 결제 "전" 검사용 — 결제창·주문서에도 흔한 '결제 완료 시 적립' 같은 글자로 멈추지 않게 좁힌다
# (실기: 무신사페이 결제창 문구에 걸려 결제 전 pay_interrupted). 주문 완료 주소의 탭이 있거나,
# 화면에 주문 완료 문구와 주문번호가 함께 있어야 이미 결제된 것으로 본다
_PAID_URL_RE = re.compile(
    r'order/result|order/complete|order-complete|orderComplete|order_complete'
)
_PAID_TEXT = ('주문이 완료', '주문완료', '주문 완료')


def looks_already_paid(list_tabs_output: str, page: str) -> bool:
    """재진입 때 이미 결제가 끝났는지(재결제 금지). 주문 완료 탭이 있거나 완료 문구+주문번호가 함께 보이면 True."""
    if _PAID_URL_RE.search(list_tabs_output or ''):
        return True
    return any(t in page for t in _PAID_TEXT) and '주문번호' in page


# 'refused: <reason>' 응답은 공통 껍데기(agents/base.tool)가 사유로 옮긴다(리뷰 지적 — I5).
# 여기서는 접두사 없이 오는 과거 형식만 한 번 더 본다
DECLINED_MARKERS = ('declined', '거절')

# 결제창의 신원정보(주문자) 입력칸을 찾는 검색어 — find_elements 로 elementId 를 얻는다
IDENTITY_QUERY = '주문자'

# 웹 결제 비밀번호 키패드 화면에서 요소 번호를 얻는 검색어. 키패드 경로에서는 앱이 번호를 쓰지
# 않지만(숫자 버튼을 앱이 직접 누른다) fill_secret 스키마가 정수를 요구한다
KEYPAD_QUERY = '비밀번호'

# 시험 입력(dry-run) 응답 표시. 앱은 'refused: dry-run …'(폰) · 'refused: DRY_RUN …'(웹 키패드)로
# 돌려준다 — refusal.py 가 거절로 분류하지 않고 그대로 넘겨 준다
DRY_RUN_MARKERS = ('dry-run', 'dry_run')

# find_elements 응답 한 줄 형식: `[12] textbox "주문자 이름"`(src/shared/snapshot.ts)
ELEMENT_ID_RE = re.compile(r'^\[(\d+)\]', re.MULTILINE)

# 결제수단 이름 → 폰 결제 앱(provider enum, src/main/phone/pay.ts PAY_PROVIDERS)
PAY_PROVIDER_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ('toss', ('토스', 'toss')),
    ('payco', ('페이코', 'payco')),
    ('kakaopay', ('카카오', 'kakao')),
    ('naverpay', ('네이버', 'naver')),
)

# 결제창(팝업) 호스트 → 결제 앱. 결제 앱은 사람이 지정하지 않는다 — 사이트 결제 흐름에서
# 열리는 결제창을 보고 정한다(브리프 §결제앱 자동판별). 앱의 판단표(src/main/agent/tools.ts
# PAY_HOST_PROVIDERS)와 같은 호스트를 쓰되, 값은 이 저장소의 PayProvider(src/main/phone/pay.ts)로
# 맞춘다 — kakao→kakaopay, naver→naverpay
PAY_HOST_PROVIDERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r'(^|\.)toss\.im$|(^|\.)tosspayments\.com$'), 'toss'),
    (re.compile(r'(^|\.)payco\.com$'), 'payco'),
    (re.compile(r'(^|\.)kakaopay\.com$|(^|\.)kakao\.com$'), 'kakaopay'),
    (re.compile(r'(^|\.)pay\.naver\.com$'), 'naverpay'),
)

# 키패드 입력 뒤 주문 완료 화면이 뜰 때까지 기다리는 시간(ms)
PAY_RESULT_WAIT_MS = 4000
# 키패드가 뜰 때까지 팝업을 다시 보는 횟수·간격(최대 약 20초)
KEYPAD_POLL_TRIES = 10
KEYPAD_POLL_WAIT_MS = 2000
# 아직 키패드·비밀번호 칸이 아닌 화면에서 앱이 돌려주는 거절 — 기다렸다 다시 본다
_KEYPAD_NOT_READY = ('target is not a secret input', 'not found', 'no active tab')


def _keypad_not_ready(out: str) -> bool:
    low = out.lower()
    return any(k in low for k in _KEYPAD_NOT_READY)


# PC(웹) 결제창에서 비밀번호 키패드로 끝나는 간편결제 — 폰 승인을 쓰지 않는다(사용자 2026-09-25: 페이코는 PC 결제,
# 폰 결제는 안정화 전까지 쓰지 않는다)
# PC 결제창에서 비밀번호 키패드로 끝내는 결제 — 폰 승인으로 보내지 않는다(모바일 결제는 안정화 전까지 쓰지 않음, 사용자).
# 네이버페이도 PC 결제창(pay.naver.com 비밀번호 키패드, 앱이 글자 인식으로 누름)으로 간다 — 폰 승인 도구로 보내면
# 휴대폰 네이버 앱 경로라 폰이 없어 시간 초과로 끊겼다(실기 2026-09-25 ABC 반스)
PC_PAY_PROVIDERS = frozenset({'payco', 'naverpay'})


def web_pay_provider(card: str) -> str | None:
    """웹 결제 비밀번호의 제공자 — 무신사페이는 musinsapay, 페이코는 payco, 사이트 머니(무신사머니·SSG PAY…)는 site, 모르면 None."""
    if '무신사페이' in card or 'musinsapay' in card.lower():
        return 'musinsapay'
    if '페이코' in card or 'payco' in card.lower():
        return 'payco'
    if '네이버' in card or 'naver' in card.lower():
        return 'naver'
    if any(k in card for k in ('머니', 'SSG PAY', 'L.pay', '스마일')):
        return 'site'
    return None


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or '').lower()
    except ValueError:
        return ''


def _pay_host_provider(url: str) -> str | None:
    """결제창 URL 의 호스트가 폰 결제 앱(토스·페이코·카카오·네이버)이면 그 이름, 아니면 None(웹 결제창)."""
    host = _host_of(url)
    for pattern, provider in PAY_HOST_PROVIDERS:
        if pattern.search(host):
            return provider
    return None


# run_script checkout_enter_* 직후 결제창(팝업)이 아직 하나도 없을 때 한 번 더 보기 전 기다리는
# 시간(ms) — 사이트가 팝업을 띄우는 타이밍과 어긋나 곧장 웹 결제 경로로 새지 않게 한다(리뷰 지적 — Minor 4)
PAY_POPUP_WAIT_MS = 2000
# 결제창 '결제하기' 버튼이 뜰 때까지 다시 보는 횟수·간격(중간 bridge 페이지를 지나는 시간)
PAY_BUTTON_POLL_TRIES = 12
PAY_BUTTON_POLL_WAIT_MS = 700

# list_tabs 응답에서 팝업 kind 만 그물망으로 건질 때 쓰는 보조 정규식.
# 정상 응답은 JSON 배열(id·kind·title·url·…)이지만, 형식이 바뀌어도 최소한
# "kind":"popup" 옆의 url 값은 이걸로 건진다(문자열 형식 대비)
POPUP_URL_FALLBACK_RE = re.compile(r'"kind"\s*:\s*"popup"[^{}]*?"url"\s*:\s*"([^"]*)"')

# 소싱처별 "결제창 진입" 저장 스크립트 이름은 소싱처 표(sources.yaml)가 준다 —
# checkout_enter_<key>(29CM 만 checkout_enter_29cm 으로 표에 적어 둔 예외).
# 표에 없는 소싱처는 기본 checkout_enter 로 진입한다
DEFAULT_CHECKOUT_SCRIPT = 'checkout_enter'


def checkout_script_for(source: str) -> str:
    """소싱처(한글 이름·id 어느 쪽이든) → 결제창 진입 스크립트 이름."""
    found = default_sources().by_id(source)
    return found.checkout_script_name if found else DEFAULT_CHECKOUT_SCRIPT


# dry_run 이면 결제 에이전트가 절대 부르지 않는 부수효과 도구(허용 목록에 있어도 막는다).
# 코드 흐름상 dry_run 은 결제창 진입 뒤 곧바로 끝나 이 도구들을 호출하지 않지만, buyer.py 처럼
# tool() 에서도 한 번 더 막아 이중으로 지킨다(불변조건)
DRY_RUN_BLOCKED_TOOLS = frozenset({'fill_secret', 'phone_approve_payment'})

# 결제 직전 재조회에서 '아직 미처리' 로 보는 삼바웨이브 상태(플레이북 §5-1)
WAVE_PENDING_STATUS = 'pending'

# 결제 성공 화면에서 소싱처 주문번호를 뽑는 표현 — 기록·검증이 이 값으로 대조한다(리뷰 지적 — I2)
SOURCE_ORDER_NO_RE = re.compile(r'주문\s?번호[^0-9A-Za-z]{0,4}([A-Za-z0-9][A-Za-z0-9-]{4,31})')


# 결제 앱 안에서 고를 카드의 검색어(플레이북 §0) — 카드사 이름 조각 → phone_approve_payment 의 card 값
CARD_APP_CODES: tuple[tuple[tuple[str, ...], str], ...] = (
    (('현대',), '현대'),
    (('KB', '국민'), 'Smart'),
    (('롯데',), 'LOCA'),
    (('신한',), '11번가'),
    (('농협', 'NH'), 'zgm'),
)


def card_app_code(issuer: object) -> str | None:
    """카드사 이름('농협카드') → 결제 앱 검색어('zgm'). 표에 없으면 이름 그대로, 비어 있으면 None"""
    text = str(issuer or '').strip()
    if not text:
        return None
    for names, code in CARD_APP_CODES:
        if any(n in text for n in names):
            return code
    return text


def _pay_provider(*candidates: object) -> str | None:
    """결제수단 이름에서 폰 결제 앱을 고른다. 못 고르면 None — 결제하지 않는다."""
    for candidate in candidates:
        text = str(candidate or '').lower()
        if not text:
            continue
        for provider, keywords in PAY_PROVIDER_KEYWORDS:
            if any(k in text for k in keywords):
                return provider
    return None


def _popups_and_active_tabs(list_tabs_output: str) -> tuple[list[dict[str, object]], set[str]]:
    """list_tabs 출력(list_tabs, src/main/agent/tools.ts)에서 팝업 창 목록과 활성 탭 id 집합을
    뽑는다. 결제창은 kind가 popup 인 창이다(주소 검색창 등 다른 팝업도 섞일 수 있어 호스트로
    다시 거른다). 팝업이 여럿일 때 우선순위를 매기려면 openerId(팝업을 연 탭)와 active(그 탭이
    지금 활성 탭인지)가 있어야 하므로, 정상 JSON 응답에서만 그 값을 함께 돌려준다 — 형식이 바뀌어
    문자열만 훑는 예비 경로에서는 URL만 남고 우선순위 정보는 없다."""
    try:
        targets = json.loads(list_tabs_output)
    except (json.JSONDecodeError, TypeError):
        targets = None
    if isinstance(targets, list):
        popups = [
            t for t in targets if isinstance(t, dict) and t.get('kind') == 'popup' and t.get('url')
        ]
        active_tab_ids = {
            str(t['id'])
            for t in targets
            if isinstance(t, dict)
            and t.get('kind') == 'tab'
            and t.get('active') is True
            and t.get('id')
        }
        return popups, active_tab_ids
    fallback = [
        {'url': m.group(1)} for m in POPUP_URL_FALLBACK_RE.finditer(list_tabs_output) if m.group(1)
    ]
    return fallback, set()


def _pay_provider_from_host(url: str) -> str | None:
    """팝업 URL 호스트로 결제 앱을 고른다. 앱의 payProviderOfUrl(tools.ts)과 같은 표를 쓴다."""
    try:
        host = (urlsplit(url).hostname or '').lower()
    except ValueError:
        return None
    if not host:
        return None
    for pattern, provider in PAY_HOST_PROVIDERS:
        if pattern.search(host):
            return provider
    return None


def _element_id(found: str) -> int | None:
    """find_elements 응답에서 첫 요소 번호를 뽑는다. 없으면 None."""
    m = ELEMENT_ID_RE.search(found)
    return int(m.group(1)) if m else None


def _amount_krw(value: object) -> int | None:
    """결제 금액(원 단위 양의 정수). 모르거나 0 이하면 None — 앱 스키마가 거절한다."""
    try:
        amount = round(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return amount if amount > 0 else None


# 주문 완료 주소 속 주문번호(무신사 …/order/result/202609241804480002)
RESULT_URL_ORDER_NO_RE = re.compile(r'order/(?:result|complete)/([A-Za-z0-9-]{6,32})')


def _source_order_no(page: str, tabs: str = '') -> str | None:
    """결제 성공 화면(없으면 주문 완료 탭 주소)에서 소싱처 주문번호를 뽑는다. 못 찾으면 None.

    실기: 무신사페이 완료 화면 글자에 '주문번호' 표기가 없어 기록이 멈췄다 — 완료 탭 주소에는 번호가 있다.
    """
    m = SOURCE_ORDER_NO_RE.search(page)
    if m:
        return m.group(1)
    m = RESULT_URL_ORDER_NO_RE.search(tabs)
    return m.group(1) if m else None


class PayerAgent(AgentBase):
    """모든 소싱처의 결제를 맡는다. 등록부에서 retry: 0 이다 — 여기서도 다시 부르지 않는다."""

    _dry_run: bool = True
    # 삼바웨이브 내부 API 클라이언트. factory 가 꽂는다(없으면 결제 직전 재조회를 건너뛴다)
    _wave: 'WaveClient | None' = None

    def set_wave(self, wave: 'WaveClient | None') -> None:
        """삼바웨이브 클라이언트를 꽂는다. 배선은 factory 가 한다."""
        self._wave = wave

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
        self.reset_repairs()
        return run_agent(lambda: self._pay(assignment), lambda: self.evidence)

    def _recheck_wave(self, a: Assignment) -> None:
        """결제창 진입 전 SAMBA 재조회(플레이북 §5-1) — 그사이 누가 샀거나 상태가 바뀌었는지 본다.

        소싱주문번호가 이미 있으면 중복 구매라 끝내고, 상태가 미처리(pending)가 아니면
        (취소·반품·다른 작업자 처리 등) 사람에게 넘긴다. 조회 자체가 실패해도 확인 못 한 채
        결제하지 않는다. 삼바웨이브가 없으면 건너뛴다(앱 저장 스크립트 경로).
        """
        if self._wave is None:
            return
        self.step('payer: 결제 직전 SAMBA 재조회')
        try:
            current = self._wave.get_order(a.order.order_no)
        except WaveError as e:
            raise AgentFailure(
                'needs_human', f'결제 직전 SAMBA 재조회 실패(결제하지 않음): {e}', e.reason
            ) from e
        sourcing_no = (current.sourcing_order_number or '').strip()
        if sourcing_no:
            raise AgentFailure(
                'fail', f'이미 소싱주문번호가 있다: {sourcing_no}', FailReason.DUPLICATE
            )
        status = (current.status or '').strip()
        if status.lower() != WAVE_PENDING_STATUS:
            raise AgentFailure(
                'needs_human', f'상태 변경: {status or "(비어 있음)"}', FailReason.UNKNOWN
            )
        self.note('결제 직전 재조회', f'상태 {status} · 소싱주문번호 없음')

    def tool(self, name: str, /, **args: object) -> str:
        """dry_run 이면 부수효과 도구는 허용 목록에 있어도 아예 부르지 않는다(불변조건).

        딱 하나의 예외가 시험 입력이다 — `dryRunDigits` 를 실어 부르면 앱이 결제 비밀번호를
        그 자리수만 누르고 취소한다(결제는 끝나지 않는다). 그 인자가 없으면 여전히 막는다.
        """
        dry_digits = args.get('dryRunDigits')
        allowed_dry_call = isinstance(dry_digits, int) and dry_digits > 0
        if self._dry_run and name in DRY_RUN_BLOCKED_TOOLS and not allowed_dry_call:
            raise AgentFailure(
                'fail',
                f'dry_run 에서는 부수효과 도구를 부르지 않는다: {name}',
                FailReason.PERMISSION_DENIED,
            )
        return super().tool(name, **args)

    def _list_tabs_popups(self) -> tuple[list[dict[str, object]], set[str]]:
        """list_tabs 를 불러 팝업 목록과 활성 탭 id 집합을 돌려준다. list_tabs 자체가 실패하면
        (브릿지 오류 등) 결제창을 못 본 채로 찍어 승인하면 안 되므로 바로 사람에게 넘긴다 —
        이때 사유를 UNKNOWN 으로 뭉개지 않고 브릿지가 준 fail_reason 을 그대로 살린다(리뷰 지적 — Minor 3)."""
        try:
            listed = self.tool('list_tabs')
        except AgentFailure as e:
            raise AgentFailure(
                'needs_human',
                f'결제창 목록을 확인할 수 없다: {e.reason}',
                e.fail_reason,
            ) from e
        return _popups_and_active_tabs(listed)

    def _provider_from_payment_popup(self) -> str | None:
        """지금 열린 결제창(팝업)의 호스트로 결제 앱을 고른다. 결제창이 없거나 아는 결제
        앱의 호스트가 아니면 None — 그때는 phone_approve_payment 를 부르지 않고 웹 결제
        경로로 간다.

        결제창이 하나도 없으면(팝업 0개) 사이트가 아직 못 띄웠을 수 있으니 wait 로 한 번만
        기다렸다 다시 본다(리뷰 지적 — Minor 4). 그래도 없으면 웹 결제 경로다.

        결제 호스트에 매칭되는 팝업이 여럿이면 그 팝업을 연 탭(openerId)이 지금 활성 탭인
        것을 우선 쓴다 — 지금 사람이 보고 있는 흐름에서 뜬 결제창이라는 뜻이라 다른 팝업과
        provider 가 갈려도 그것을 쓴다. 활성 탭이 연 팝업이 하나도 없으면, 모두 같은 결제
        앱이면 목록의 마지막(가장 최근에 뜬 것)을 쓰지만 서로 다른 결제 앱을 가리키면 어느
        쪽인지 코드가 짐작하지 않고 사람에게 넘긴다(근거에 호스트를 남긴다, 리뷰 지적 — Important 2)."""
        popups, active_tab_ids = self._list_tabs_popups()
        if not popups:
            self.tool('wait', ms=PAY_POPUP_WAIT_MS)
            popups, active_tab_ids = self._list_tabs_popups()
        if not popups:
            return None

        matches = [
            (str(p['url']), _pay_provider_from_host(str(p['url'])), p.get('openerId'))
            for p in popups
        ]
        matches = [
            (url, provider, opener) for url, provider, opener in matches if provider is not None
        ]
        if not matches:
            return None

        for url, provider, opener in matches:
            if opener is not None and str(opener) in active_tab_ids:
                return provider

        providers = {provider for _, provider, _ in matches}
        if len(providers) > 1:
            hosts = ', '.join(url for url, _, _ in matches)
            raise AgentFailure(
                'needs_human',
                f'결제창이 여럿이고 서로 다른 결제 앱을 가리킨다 — 사람이 확인한다: {hosts}',
                FailReason.UNKNOWN,
            )
        return matches[-1][1]

    def _web_pay(self, a: Assignment) -> None:
        """사이트 결제창(팝업)의 '결제하기' → 웹 키패드에 fill_secret(password) — 플레이북 §7 무신사머니 흐름.

        결제창이 뜨면 그 창으로 옮겨 '결제하기'를 한 번 누른다(무신사머니 금액 확인창). 이어 뜨는 비밀번호
        키패드는 앱이 배치를 읽어 누른다(fill_secret, provider 는 앱이 결제창으로 고른다). 결제창이 없으면
        지금 화면의 키패드를 바로 찾는다. 비밀번호 값은 어디서도 다루지 않는다.
        """
        # 결제창은 중간 창(money.musinsapayments.com/bridge)이 닫히고 /payment 창이 새로 뜬다 — 그 사이엔
        # '결제하기'가 없고, 처음 본 창은 사라진다. 매번 결제창 목록을 다시 읽어 가장 최근 창에서 버튼을 찾는다
        # (실기 2026-09-25: 첫 창만 보다 버튼을 못 눌러 결제 미완료 3건)
        pay_btn = None
        seen_popup = False
        for _ in range(PAY_BUTTON_POLL_TRIES):
            popups, _active = self._list_tabs_popups()
            # 웹 결제창 — 사이트 결제창과 PC 에서 끝내는 간편결제 창(네이버페이·페이코)의 '결제하기'를 누른다
            web = [
                p
                for p in popups
                if p.get('id')
                and _host_of(str(p.get('url') or ''))
                and _pay_host_provider(str(p.get('url') or '')) in (None, *PC_PAY_PROVIDERS)
            ]
            if web:
                seen_popup = True
                self.tool('switch_tab', id=str(web[-1]['id']))
                pay_btn = _element_id(self.tool('find_elements', query='결제하기'))
                if pay_btn is not None:
                    break
            self.tool('wait', ms=PAY_BUTTON_POLL_WAIT_MS)
        if pay_btn is None and self._payco_agree_and_pay():
            seen_popup = True
            pay_btn = -1  # 페이코 창의 '결제'는 위에서 눌렀다
        if seen_popup and pay_btn is None:
            self.note('결제창', '결제하기 버튼이 뜨지 않음 — 키패드를 바로 찾는다')
        if pay_btn is not None and pay_btn >= 0:
            self.step('payer: 결제창 결제하기')
            self.tool('click', id=pay_btn, label='결제하기')
            self.tool('wait', ms=PAY_POPUP_WAIT_MS)
        # 결제 비밀번호 종류 — 무신사페이는 무신사머니와 비밀번호가 따로다(musinsapay), 사이트 머니는 'site'.
        # 계정에 비밀번호가 여럿이면 없을 때 모호하다(실기)
        card = str(a.handoff.get('card') or a.options.get('card') or '')
        provider = web_pay_provider(card)
        account = str(a.handoff.get('account') or a.order.account or '')
        self.step('payer: 결제 비밀번호(앱 입력)')
        # 키패드는 결제하기 뒤 늦게, 다른 팝업에 뜰 수 있다(실기: 무신사페이 — 활성 탭이 키패드가 아니라 거절).
        # 앱은 키패드·비밀번호 칸이 실제로 있을 때만 누르고 아니면 아무것도 누르지 않고 거절하므로,
        # 최근 팝업부터 돌며 뜰 때까지 기다렸다 다시 시도한다. 한 번 누른 키패드는 앱이 다시 누르지 않는다
        out = ''
        for attempt in range(KEYPAD_POLL_TRIES):
            popups, _active = self._list_tabs_popups()
            targets = [str(p['id']) for p in reversed(popups) if p.get('id')] or ['']
            for tab_id in targets:
                if tab_id:
                    self.tool('switch_tab', id=tab_id)
                found = self.tool('find_elements', query=KEYPAD_QUERY)
                try:
                    out = self.tool(
                        'fill_secret',
                        elementId=_element_id(found) or 0,
                        itemType='password',
                        **({'provider': provider} if provider else {}),
                        **({'accountLabel': account} if account else {}),
                    )
                except AgentFailure as e:
                    # 앱 거절은 예외로 온다 — 문구로 바꿔 '아직 키패드 아님'이면 다시 본다
                    out = e.reason
                if not _keypad_not_ready(out):
                    break
            if not _keypad_not_ready(out):
                break
            if attempt + 1 < KEYPAD_POLL_TRIES:
                self.tool('wait', ms=KEYPAD_POLL_WAIT_MS)
        self.note('키패드 입력', mask_text(out[:200]))
        low = out.lower()
        if low.startswith('refused') or 'not found' in low or 'ambiguous' in low:
            raise AgentFailure(
                'needs_human',
                f'결제 비밀번호를 앱이 넣지 못했다 — 사람이 직접 누른다: {mask_text(out[:100])}',
                FailReason.PERMISSION_DENIED,
            )
        self.tool('wait', ms=PAY_RESULT_WAIT_MS)

    def _confirm_paid(self, a: Assignment, card: str) -> AgentResult:
        """결제 뒤 성공 확인 — 완료 화면 문구, 없으면(ABC·그랜드스테이지) 주문내역의 방금 생긴 주문으로."""
        self.step('payer: 성공 확인')
        page = self._success_page()
        recent_no = None
        if not any(m in page for m in PAY_SUCCESS_MARKERS):
            # ABC마트·그랜드스테이지는 네이버페이 뒤 완료 화면을 못 잡는 일이 있다 — 주문내역에서 방금(10분 안) 생긴
            # 결제완료 주문을 찾아 확인한다(실기 2026-09-25 반스: 결제됐는데 '확인되지 않는다'로 멈춤)
            recent_no = self._recent_art_order(a)
            if recent_no:
                page = f'결제완료 주문번호 {recent_no}'
        if not any(m in page for m in PAY_SUCCESS_MARKERS):
            raise AgentFailure(
                'needs_human',
                '결제됐는지 화면에서 확인되지 않는다 — 사람이 봐야 한다(재결제 금지)',
                FailReason.VERIFY_MISMATCH,
            )
        self.note('결제 성공', mask_text(page[:200]))
        # 누가 결제했는지(플레이북 §5-4) — 이 경로는 에이전트가 결제를 끝낸 것이다
        payload: dict[str, object] = {
            'dry_run': False,
            'paid': True,
            'paid_by': 'agent',
            'card': card,
        }
        try:
            tabs_now = self.tool('list_tabs')
        except AgentFailure:
            tabs_now = ''
        source_order_no = recent_no or _source_order_no(page, tabs_now)
        if source_order_no is not None:
            payload['source_order_no'] = source_order_no
            self.note('소싱 주문번호', source_order_no)
        return AgentResult(
            status='ok',
            reason=f'{card} 로 결제 완료를 화면에서 확인했다',
            payload=payload,
            evidence=tuple(self.evidence),
        )

    def _payco_agree_and_pay(self) -> bool:
        """페이코 PC 결제창(bill.payco.com) — 버튼이 '결제하기'가 아니라 '결제' 링크이고 정보제공동의를 켜야 한다.

        동의를 켜고 '결제'를 누르면 페이코 결제 비밀번호 키패드가 뜬다(비밀번호 없이는 결제되지 않는다).
        실기 2026-09-25 르무통: '결제하기'만 찾다 못 찾아 키패드 없이 멈췄다. 페이코 창이 아니면 False.
        """
        popups, _active = self._list_tabs_popups()
        payco = [
            p
            for p in popups
            if p.get('id') and _host_of(str(p.get('url') or '')).endswith('bill.payco.com')
        ]
        if not payco:
            return False
        code = f'await tabs.switch({json.dumps(str(payco[-1]["id"]))})\n' + _PAYCO_AGREE_PAY_JS
        try:
            out = self.tool('run_js', code=code)
        except AgentFailure as e:
            self.note('페이코 결제', mask_text(f'동의·결제 누르기 실패({e.reason[:80]})'))
            return False
        self.note('페이코 결제', mask_text(out[:160]))
        return '"clicked":true' in out.replace(' ', '')

    def _recent_art_order(self, a: Assignment) -> str | None:
        """a-rt.com(ABC마트·그랜드스테이지) 주문내역에서 10분 안에 생긴 결제완료 주문번호. 아니면 None."""
        source = str(a.handoff.get('buy_source') or a.order.source or '')
        host = {'ABCmart': 'abcmart.a-rt.com', 'GrandStage': 'grandstage.a-rt.com'}.get(source)
        account = str(a.handoff.get('account') or a.order.account or '')
        if not host or not account:
            return None
        code = (
            f"await tabs.open({{ url: 'https://{host}/mypage/claim/claim-order-main', "
            f"profile: {json.dumps(account)} }})\n" + _ART_RECENT_ORDER_JS
        )
        try:
            raw = self.tool('run_js', code=code, safety='no_pay')
            found = json.loads(raw[raw.index('{'):]) if '{' in raw else {}
        except (AgentFailure, ValueError):
            return None
        no, at = str(found.get('no') or ''), str(found.get('at') or '')
        if not no or not at:
            return None
        try:
            placed = datetime.strptime(at, '%Y-%m-%d %H:%M:%S').replace(tzinfo=_KST)
        except ValueError:
            return None
        if abs((datetime.now(_KST) - placed).total_seconds()) > 600:
            return None
        self.note('결제 확인(주문내역)', f'{no} {at} {found.get("amount")}원')
        return no

    def _success_page(self) -> str:
        """결제 뒤 화면 — 주문 완료 탭(…/order/result/…)이 있으면 그 탭으로 옮겨 읽는다."""
        try:
            listed = self.tool('list_tabs')
            for m in re.finditer(
                r'"id"\s*:\s*"([^"]+)"[^}]*?"url"\s*:\s*"([^"]*order/result[^"]*)"', listed
            ):
                self.tool('switch_tab', id=m.group(1))
                break
        except AgentFailure:
            pass
        return self.tool('get_page')

    def _dry_run_keypad(self, a: Assignment, card: str, digits: int) -> AgentResult:
        """결제창까지 간 뒤 결제 비밀번호를 `digits` 자리만 눌러 보고 취소한다.

        실기에서 키패드 자동 입력이 되는지만 보는 길이다 — 결제는 어느 경로에서도 끝나지
        않는다. 결제 앱이 정해지면 폰 승인 도구로, 아니면 웹 키패드(fill_secret)로 간다.
        비밀번호 값은 앱 안에만 있고 여기로는 자리수조차 오지 않는다(돌아오는 것은 문구뿐)."""
        self.step(f'payer: 시험 입력 — 결제 비밀번호 {digits}자리만 누르고 취소')
        provider = _pay_provider(card) or self._provider_from_payment_popup()
        if provider is not None:
            amount = _amount_krw(a.handoff.get('cost'))
            if amount is None:
                raise AgentFailure(
                    'needs_human',
                    '결제 금액을 모른다 — 시험 입력도 하지 않는다',
                    FailReason.UNKNOWN,
                )
            # 카드사(card_issuer)가 있으면 결제 앱 검색어로, 없고 카드 이름 자체가 결제 앱(예: 토스페이)이면 카드 아님
            card_hint = card_app_code(a.handoff.get('card_issuer')) or (
                None if _pay_provider(card) else card
            )
            out = self.tool(
                'phone_approve_payment',
                provider=provider,
                amountKrw=amount,
                merchant=a.order.source,
                methodLabel=card,
                dryRunDigits=digits,
                **({'card': card_hint} if card_hint else {}),
            )
        else:
            # 결제 앱이 없다 — 사이트 결제창의 웹 키패드다. 요소 번호는 스키마가 요구해서 찾는다
            # 키패드는 결제하기 뒤 늦게·다른 팝업에 뜬다 — 실결제 경로(_web_pay)처럼 최근 팝업부터 다시 본다
            # (실기: 29CM 무신사페이 시험 입력이 키패드 전에 눌려 'target is not a secret input')
            label = a.handoff.get('account') or a.order.account
            out = ''
            for attempt in range(KEYPAD_POLL_TRIES):
                popups, _active = self._list_tabs_popups()
                for tab_id in [str(p['id']) for p in reversed(popups) if p.get('id')] or ['']:
                    if tab_id:
                        self.tool('switch_tab', id=tab_id)
                    found = self.tool('find_elements', query=KEYPAD_QUERY)
                    try:
                        out = self.tool(
                            'fill_secret',
                            elementId=_element_id(found) or 0,
                            itemType='password',
                            dryRunDigits=digits,
                            **(
                                {'provider': web_pay_provider(card)}
                                if web_pay_provider(card)
                                else {}
                            ),
                            **({'accountLabel': label} if label else {}),
                        )
                    except AgentFailure as e:
                        out = e.reason
                    if not _keypad_not_ready(out):
                        break
                if not _keypad_not_ready(out):
                    break
                if attempt + 1 < KEYPAD_POLL_TRIES:
                    self.tool('wait', ms=KEYPAD_POLL_WAIT_MS)
        self.note('시험 입력', mask_text(out[:200]))
        if not any(m in out.lower() for m in DRY_RUN_MARKERS):
            # 시험 입력이라고 했는데 시험 입력 응답이 아니다 — 결제가 진행됐을 수 있다
            raise AgentFailure(
                'needs_human',
                f'시험 입력 응답이 아니다 — 사람이 결제 상태를 확인한다: {mask_text(out[:100])}',
                FailReason.PAY_INTERRUPTED,
            )
        return AgentResult(
            status='ok',
            reason=f'dry-run: 결제 비밀번호 {digits}자리만 눌러 보고 취소했다(결제 안 함)',
            payload={'dry_run': True, 'paid': False, 'keypad_tested': True, 'digits': digits},
            evidence=tuple(self.evidence),
        )

    def _pay(self, a: Assignment) -> AgentResult:
        self.evidence = []
        # 요청자가 지정한 카드가 먼저, 없으면 구매 에이전트가 고른 카드다(리뷰 지적 — C3)
        card = a.options.get('card') or a.handoff.get('card')
        card = str(card) if card else None
        if not card:
            # 감독자가 이미 검사하지만, 결제 직전에 한 번 더 막는다
            raise AgentFailure('fail', '결제할 카드가 없다', FailReason.CARD_MISSING)

        self._recheck_wave(a)

        if a.dry_run and card == POINTS_ONLY_METHOD:
            # 포인트 전액 결제는 결제하기 한 번에 주문이 끝난다 — 시험에서는 결제창 진입 스크립트도 부르지 않는다
            self.step('payer: dry-run — 포인트 전액 결제라 결제하기를 누르지 않고 끝낸다')
            return AgentResult(
                status='ok',
                reason='dry-run: 포인트 전액 결제 — 결제하기를 누르지 않았다(결제 안 함)',
                payload={'dry_run': True, 'paid': False, 'points_only': True},
                evidence=tuple(self.evidence),
            )

        self.step('payer: 결제창 진입')
        # 실제로 산 사이트(교차 비교) 기준으로 결제창에 들어간다
        script = checkout_script_for(str(a.handoff.get('buy_source') or a.order.source))
        payload: dict[str, object] = {'card': card}
        profile = a.handoff.get('account') or a.order.account
        if profile:
            payload['profile'] = profile  # 구매가 연 계정 프로필의 주문서에서 결제창을 연다
        # 결제창 진입은 AI 수리 대상이 아니다 — 비밀번호 없는 간편결제(무신사페이 카드 등)는 '결제하기' 한 번에
        # 결제가 끝난다(실기 2026-09-24: 수리 시험 중 결제하기 클릭으로 실결제 발생). 실패하면 사람에게 넘긴다
        raw_enter = self.tool(
            'run_script', name=script, args=json.dumps(payload, ensure_ascii=False)
        )
        body_enter, enter_dialogs = split_page_dialogs(raw_enter)
        if enter_dialogs:
            # 결제하기 뒤 뜬 경고창 — 결제창이 안 뜬 이유인 경우가 많다(예전엔 버려서 원인을 몰랐다)
            self.note('결제창 경고', mask_text(' | '.join(enter_dialogs)[:300]))
        try:
            parsed_enter = json.loads(body_enter)
        except ValueError:
            parsed_enter = None
        entered: dict[str, object] = (
            parsed_enter
            if isinstance(parsed_enter, dict)
            else {'ok': False, 'note': raw_enter[:120]}
        )
        self.note('결제창', mask_text(json.dumps(entered, ensure_ascii=False)[:200]))
        if not entered.get('ok'):
            # 결제하기를 못 눌렀다 — 비밀번호 단계로 가지 않는다(실기: 수단을 못 찾고도 키패드를 찾다 거절)
            raise AgentFailure(
                'needs_human',
                f'결제창을 열지 못했다: {mask_text(str(entered.get("error") or entered.get("note"))[:80])}'
                + (f' — 경고창: {mask_text(" | ".join(enter_dialogs)[:120])}' if enter_dialogs else '')
                + (f' — 화면: {mask_text(str(entered.get("note"))[:160])}' if entered.get('error') and entered.get('note') else ''),
                FailReason.UNKNOWN,
            )

        if entered.get('points_only') and not a.dry_run:
            # 포인트로 전액 결제 — 결제하기 한 번에 주문이 끝나 결제창·비밀번호가 없다(ABC 포인트 최대 사용, 사용자 2026-09-25).
            # 이미 결제된 화면 검사를 거치면 방금 끝난 주문을 재진입으로 오판하므로 바로 성공 확인으로 간다
            self.step('payer: 포인트 전액 결제 — 결제창 없음')
            return self._confirm_paid(a, card)

        if a.dry_run and a.dry_run_digits > 0:
            # 키패드 시험 입력: 결제 비밀번호를 절반만 누르고 취소한다(결제는 하지 않는다)
            return self._dry_run_keypad(a, card, a.dry_run_digits)

        if a.dry_run:
            # 사용자 검토 전에는 여기까지만 한다(스펙 §10-1) — 부수효과 도구는 부르지 않는다
            self.step('payer: dry-run — 결제하지 않고 끝낸다')
            return AgentResult(
                status='ok',
                reason=f'dry-run: {card} 로 결제창까지만 확인했다',
                payload={'dry_run': True, 'paid': False},
                evidence=tuple(self.evidence),
            )

        # 폰 승인 전에 주문 상세를 딱 한 번 읽어 이미 결제됐는지 본다 — 재시작·재진입으로
        # 여기까지 다시 왔을 때 결제를 두 번 하지 않는다(리뷰 지적 — Critical 2 ③)
        self.step('payer: 이미 결제됐는지 확인')
        before = self.tool('get_page')
        try:
            listed = self.tool('list_tabs')
        except AgentFailure:
            listed = ''
        if looks_already_paid(listed, before):
            self.note('결제 전 확인', mask_text(before[:200]))
            raise AgentFailure(
                'needs_human',
                '이미 결제된 화면이다 — 사람이 확인한다(재결제 금지)',
                FailReason.PAY_INTERRUPTED,
            )

        # 결제 금액이 없으면 무엇을 결제하는지도 모르는 것이다 — 시작 자체를 하지 않는다.
        # 앱 스키마(tools-phone.ts)가 양의 정수 amountKrw 를 요구한다(I7)
        amount = _amount_krw(a.handoff.get('cost'))
        if amount is None:
            raise AgentFailure(
                'needs_human',
                '결제 금액을 모른다 — 확인 전에는 결제하지 않는다',
                FailReason.UNKNOWN,
            )

        # 신원정보 칸(주문자 연락처 등)은 사이트에 따라 있을 때만 채운다 — 무신사머니 결제창에는 없다(플레이북 §7)
        # 값은 앱이 직접 채운다 — 여기서는 어떤 비밀값도 보내거나 받지 않는다.
        found = self.tool('find_elements', query=IDENTITY_QUERY)
        element_id = _element_id(found)
        if element_id is not None:
            self.step('payer: 신원정보 입력')
            try:
                self.tool('fill_secret', elementId=element_id, itemType='identity')
            except AgentFailure as e:
                # 신원정보 칸이 아닌 요소가 잡힌 경우(실기: 무신사 주문서 "주문자" 글자) — 결제를 막지 않는다
                self.note('신원정보 입력', mask_text(f'건너뜀({e.reason[:80]})'))

        # 결제 앱은 사람이 지정하지 않는다 — 카드 이름 자체가 앱을 가리키면(예: 토스페이) 그것을,
        # 아니면 지금 뜬 결제창(팝업)의 호스트를 보고 정한다. phone_approve_payment 를 부르기
        # 직전에 판단해야 그사이 열린 결제창까지 본다
        self.step('payer: 결제 앱 확인')
        provider = _pay_provider(card)
        if provider is None:
            provider = self._provider_from_payment_popup()
        if provider in PC_PAY_PROVIDERS:
            # PC 결제창에서 비밀번호를 받는 결제(페이코) — 폰 승인이 아니라 웹 키패드 경로로 간다
            provider = None

        if provider is not None:
            self.step('payer: 폰 승인')
            # 카드사(card_issuer)가 있으면 결제 앱 검색어로, 없고 카드 이름 자체가 결제 앱(예: 토스페이)이면 카드 아님
            card_hint = card_app_code(a.handoff.get('card_issuer')) or (
                None if _pay_provider(card) else card
            )
            # payAccount 는 앱 스키마상 네이버페이 전용이다. 사용자 결정 — 결제 앱이 쇼핑몰
            # 계정에 연결된 네이버 계정으로 스스로 고르게 두고, 어떤 provider 에도 payAccount 를
            # 넘기지 않는다(리뷰 지적 — Critical 1)
            approved = self.tool(
                'phone_approve_payment',
                provider=provider,
                amountKrw=amount,
                merchant=a.order.source,
                methodLabel=card,
                **({'card': card_hint} if card_hint else {}),
            )
            self.note('폰 승인', mask_text(approved[:200]))
            if any(m in approved for m in DECLINED_MARKERS):
                # 'refused:' 접두사 없는 과거 형식. 재시도 없음 — 그대로 사람에게 넘긴다(재결제 위험)
                raise AgentFailure(
                    'needs_human',
                    f'폰 승인 실패: {mask_text(approved[:100])}',
                    FailReason.UNKNOWN,
                )
        else:
            # 결제 앱이 없다 — 사이트 자체 결제창(무신사머니 등)의 웹 키패드 경로. 비밀번호는 앱(fill_secret)이 누른다
            self.step('payer: 결제 앱 없음 — 웹 결제창 경로')
            self._web_pay(a)

        return self._confirm_paid(a, card)
