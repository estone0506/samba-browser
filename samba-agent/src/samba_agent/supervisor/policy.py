"""감독 규칙 — 재시도 여부와 구매 결과 검사(스펙 §4.3-4, §5-4, §6)."""

from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import AgentSpec
from samba_agent.failures import FailReason

STAGES = ('buy', 'pay', 'record', 'verify')
KIND_OF_STAGE = {'buy': 'buyer', 'pay': 'payer', 'record': 'recorder', 'verify': 'verifier'}

# 다시 해도 같은 답이 나오는 사유 — 재시도 없이 사람에게 넘긴다
NO_RETRY_REASONS = frozenset(
    {FailReason.PERMISSION_DENIED, FailReason.DUPLICATE, FailReason.CAPTCHA, FailReason.MARGIN}
)


def should_retry(spec: AgentSpec, result: AgentResult, attempts: int) -> bool:
    """이 실패를 같은 에이전트로 한 번 더 시켜도 되는가."""
    if result.status != 'fail':
        return False  # needs_human 은 재시도하지 않는다
    if spec.retry <= 0:
        return False  # 결제 에이전트 — 재결제 위험
    if result.fail_reason in NO_RETRY_REASONS:
        return False
    return attempts <= spec.retry


def check_buyer(result: AgentResult) -> AgentResult:
    """구매 결과를 감독자가 검사한다 — 카드가 있고 마진이 통과해야 결제로 넘어간다."""
    if result.status != 'ok':
        return result
    payload = result.payload
    if not payload.get('card'):
        return AgentResult(
            status='fail',
            reason='감독자 검사: 결제할 카드가 정해지지 않았다',
            fail_reason=FailReason.CARD_MISSING,
            payload=payload,
            evidence=result.evidence,
        )
    margin = payload.get('margin_pct')
    if not isinstance(margin, (int, float)) or margin <= 0:
        return AgentResult(
            status='fail',
            reason=f'감독자 검사: 마진 미달({margin})',
            fail_reason=FailReason.MARGIN,
            payload=payload,
            evidence=result.evidence,
        )
    return result
