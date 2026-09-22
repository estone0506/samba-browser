"""결제 에이전트 — 코드와 도구만 쓴다. LLM 판단이 없고, 재시도도 없다(등록부 payer 행 retry: 0).

비밀번호·카드번호는 여기를 지나가지 않는다. 앱의 fill_secret 과 phone_approve_payment 가
값을 직접 채우고 우리에게는 돌려주지 않는다(docs/bridge.md). 이 파일과 결과 payload 에는
카드 브랜드명만 남고, 실제 결제 성공 문구를 화면에서 확인하기 전에는 ok 를 내지 않는다.
"""

import json
import re

from samba_agent.agents.base import AgentBase, AgentFailure, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text

# 결제 성공을 확인하는 문구. 이걸 보기 전에는 ok 를 내지 않는다(브리프 §완료조건)
PAY_SUCCESS_MARKERS = ('결제 완료', '결제완료', '주문완료', '주문 완료', 'approved')

# 앱의 phone_approve_payment 가 거절을 돌려줄 때 붙이는 접두사(src/main/agent/tools-phone.ts).
# 'refused: <reason>' 꼴이고, 성공이면 'ok' 다
REFUSED_PREFIX = 'refused:'

# refused: 뒤 사유 중 "카드 자체가 없다"에 해당하는 것 — 시작 전 카드 누락과 같은 사유로 묶는다
CARD_REFUSAL_MARKERS = ('card-required', 'card-not-found')

# refused: 뒤 사유 없이도(과거 형식) 거절로 보는 표시 — pay-account-*, no-account,
# vault-locked, verify-failed, stuck, handoff, declined, 거절 등은 전부 이쪽(사람이 봐야 한다)
DECLINED_MARKERS = ('declined', '거절')

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


def _classify_refusal(result: str) -> str | None:
    """phone_approve_payment 응답을 분류한다.

    'card_missing' — 카드를 요구했거나(card-required) 찾지 못했다(card-not-found)
    'needs_human' — 계정 모호·불일치·금고 잠김·인증 실패·거절 등, 사람이 봐야 한다
    None — 승인 성공(거절 표시가 없다)
    """
    text = result.strip()
    if text.startswith(REFUSED_PREFIX):
        body = text[len(REFUSED_PREFIX) :].strip()
        if any(body.startswith(m) for m in CARD_REFUSAL_MARKERS):
            return 'card_missing'
        # refused: 로 시작하는 나머지 사유는 전부 사람에게 넘긴다(pay-account-*, no-account,
        # vault-locked, verify-failed, stuck, handoff, declined, 거절 포함)
        return 'needs_human'
    if any(m in text for m in DECLINED_MARKERS):
        # refused: 접두사 없는 과거 형식과도 호환한다
        return 'needs_human'
    return None


def _source_order_no(page: str) -> str | None:
    """결제 성공 화면에서 소싱처 주문번호를 뽑는다. 못 찾으면 None(기록이 사람에게 넘어간다)."""
    m = SOURCE_ORDER_NO_RE.search(page)
    return m.group(1) if m else None


class PayerAgent(AgentBase):
    """모든 소싱처의 결제를 맡는다. 등록부에서 retry: 0 이다 — 여기서도 다시 부르지 않는다."""

    _dry_run: bool = True

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
        return run_agent(lambda: self._pay(assignment))

    def tool(self, name: str, /, **args: object) -> str:
        """dry_run 이면 부수효과 도구는 허용 목록에 있어도 아예 부르지 않는다(불변조건)."""
        if self._dry_run and name in DRY_RUN_BLOCKED_TOOLS:
            raise AgentFailure(
                'fail',
                f'dry_run 에서는 부수효과 도구를 부르지 않는다: {name}',
                FailReason.PERMISSION_DENIED,
            )
        return super().tool(name, **args)

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

        self.step('payer: 신원정보 입력')
        # 값은 앱이 직접 채운다 — 여기서는 어떤 비밀값도 보내거나 받지 않는다
        self.tool('fill_secret', field='identity', provider='site')

        self.step('payer: 폰 승인')
        approved = self.tool(
            'phone_approve_payment',
            merchant=a.order.source,
            methodLabel=card,
            card=card,
        )
        self.note('폰 승인', mask_text(approved[:200]))
        outcome = _classify_refusal(approved)
        if outcome == 'card_missing':
            raise AgentFailure(
                'fail',
                f'카드를 찾지 못했다: {mask_text(approved[:100])}',
                FailReason.CARD_MISSING,
            )
        if outcome == 'needs_human':
            # 재시도 없음 — 그대로 사람에게 넘긴다(재결제 위험). 사유 문자열을 그대로 담는다
            raise AgentFailure(
                'needs_human',
                f'폰 승인 실패: {mask_text(approved[:100])}',
                FailReason.UNKNOWN,
            )

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
