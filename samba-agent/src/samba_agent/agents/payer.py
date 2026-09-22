"""결제 에이전트 — 코드와 도구만 쓴다. LLM 판단이 없고, 재시도도 없다(등록부 payer 행 retry: 0).

비밀번호·카드번호는 여기를 지나가지 않는다. 앱의 fill_secret 과 phone_approve_payment 가
값을 직접 채우고 우리에게는 돌려주지 않는다(docs/bridge.md). 이 파일과 결과 payload 에는
카드 브랜드명만 남고, 실제 결제 성공 문구를 화면에서 확인하기 전에는 ok 를 내지 않는다.
"""

import json
import re
from urllib.parse import urlsplit

from samba_agent.agents.base import AgentBase, AgentFailure, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text

# 결제 성공을 확인하는 문구. 이걸 보기 전에는 ok 를 내지 않는다(브리프 §완료조건)
PAY_SUCCESS_MARKERS = ('결제 완료', '결제완료', '주문완료', '주문 완료', 'approved')

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

# run_script checkout_enter_* 직후 결제창(팝업)이 아직 하나도 없을 때 한 번 더 보기 전 기다리는
# 시간(ms) — 사이트가 팝업을 띄우는 타이밍과 어긋나 곧장 웹 결제 경로로 새지 않게 한다(리뷰 지적 — Minor 4)
PAY_POPUP_WAIT_MS = 2000

# list_tabs 응답에서 팝업 kind 만 그물망으로 건질 때 쓰는 보조 정규식.
# 정상 응답은 JSON 배열(id·kind·title·url·…)이지만, 형식이 바뀌어도 최소한
# "kind":"popup" 옆의 url 값은 이걸로 건진다(문자열 형식 대비)
POPUP_URL_FALLBACK_RE = re.compile(r'"kind"\s*:\s*"popup"[^{}]*?"url"\s*:\s*"([^"]*)"')

# 소싱처별 "결제창 진입" 저장 스크립트 이름. buyer.py 의 소싱처 키(무신사·29CM·ABC마트·롯데온)를
# 그대로 쓴다 — 등록부 match.source 값과 같다. 매핑에 없는 소싱처는 기본 checkout_enter 로 진입한다
CHECKOUT_SCRIPT = {
    '무신사': 'checkout_enter_musinsa',
    '29CM': 'checkout_enter_29cm',
    'ABC마트': 'checkout_enter_abc',
    '롯데온': 'checkout_enter_lotteon',
}
DEFAULT_CHECKOUT_SCRIPT = 'checkout_enter'

# dry_run 이면 결제 에이전트가 절대 부르지 않는 부수효과 도구(허용 목록에 있어도 막는다).
# 코드 흐름상 dry_run 은 결제창 진입 뒤 곧바로 끝나 이 도구들을 호출하지 않지만, buyer.py 처럼
# tool() 에서도 한 번 더 막아 이중으로 지킨다(불변조건)
DRY_RUN_BLOCKED_TOOLS = frozenset({'fill_secret', 'phone_approve_payment'})

# 결제 성공 화면에서 소싱처 주문번호를 뽑는 표현 — 기록·검증이 이 값으로 대조한다(리뷰 지적 — I2)
SOURCE_ORDER_NO_RE = re.compile(r'주문\s?번호[^0-9A-Za-z]{0,4}([A-Za-z0-9][A-Za-z0-9-]{4,31})')


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


def _source_order_no(page: str) -> str | None:
    """결제 성공 화면에서 소싱처 주문번호를 뽑는다. 못 찾으면 None(기록이 사람에게 넘어간다)."""
    m = SOURCE_ORDER_NO_RE.search(page)
    return m.group(1) if m else None


class PayerAgent(AgentBase):
    """모든 소싱처의 결제를 맡는다. 등록부에서 retry: 0 이다 — 여기서도 다시 부르지 않는다."""

    _dry_run: bool = True

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
        return run_agent(lambda: self._pay(assignment), lambda: self.evidence)

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
            # 카드 이름 자체가 결제 앱을 가리키면(예: 토스페이) 앱 안에서 고를 카드가 아니다
            card_hint = None if _pay_provider(card) else card
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
            found = self.tool('find_elements', query=KEYPAD_QUERY)
            out = self.tool(
                'fill_secret',
                elementId=_element_id(found) or 0,
                itemType='password',
                dryRunDigits=digits,
            )
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

        self.step('payer: 결제창 진입')
        script = CHECKOUT_SCRIPT.get(a.order.source, DEFAULT_CHECKOUT_SCRIPT)
        args = json.dumps({'card': card}, ensure_ascii=False)
        enter = self.tool('run_script', name=script, args=args)
        self.note('결제창', mask_text(enter[:200]))

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
        if any(m in before for m in PAY_SUCCESS_MARKERS):
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

        self.step('payer: 신원정보 입력')
        # 값은 앱이 직접 채운다 — 여기서는 어떤 비밀값도 보내거나 받지 않는다.
        # 앱 스키마는 elementId(정수)와 itemType 이 필수다(리뷰 지적 — I6)
        found = self.tool('find_elements', query=IDENTITY_QUERY)
        element_id = _element_id(found)
        if element_id is None:
            raise AgentFailure('needs_human', '신원정보 입력칸을 찾지 못했다', FailReason.UNKNOWN)
        self.tool('fill_secret', elementId=element_id, itemType='identity')

        # 결제 앱은 사람이 지정하지 않는다 — 카드 이름 자체가 앱을 가리키면(예: 토스페이) 그것을,
        # 아니면 지금 뜬 결제창(팝업)의 호스트를 보고 정한다. phone_approve_payment 를 부르기
        # 직전에 판단해야 그사이 열린 결제창까지 본다
        self.step('payer: 결제 앱 확인')
        provider = _pay_provider(card)
        if provider is None:
            provider = self._provider_from_payment_popup()

        if provider is not None:
            self.step('payer: 폰 승인')
            # 카드 이름 자체가 결제 앱을 가리키면(예: 토스페이) 앱 안에서 고를 카드가 아니다
            card_hint = None if _pay_provider(card) else card
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
            # 결제 앱을 정할 수 없다 — 사이트 자체 결제(카드 직접 결제)다. phone_approve_payment 는
            # 부르지 않는다(승인 앱이 없으니 승인할 것도 없다). 이 경로도 성공 문구를 확인하기
            # 전에는 ok 를 내지 않는다 — 아래 공통 성공 확인이 그대로 지킨다
            self.step('payer: 결제 앱을 정할 수 없다 — 웹 결제 경로로 진행')

        self.step('payer: 성공 확인')
        page = self.tool('get_page')
        if not any(m in page for m in PAY_SUCCESS_MARKERS):
            raise AgentFailure(
                'needs_human',
                '결제됐는지 화면에서 확인되지 않는다 — 사람이 봐야 한다(재결제 금지)',
                FailReason.VERIFY_MISMATCH,
            )
        self.note('결제 성공', mask_text(page[:200]))
        payload: dict[str, object] = {'dry_run': False, 'paid': True, 'card': card}
        source_order_no = _source_order_no(page)
        if source_order_no is not None:
            payload['source_order_no'] = source_order_no
            self.note('소싱 주문번호', source_order_no)
        return AgentResult(
            status='ok',
            reason=f'{card} 로 결제 완료를 화면에서 확인했다',
            payload=payload,
            evidence=tuple(self.evidence),
        )
