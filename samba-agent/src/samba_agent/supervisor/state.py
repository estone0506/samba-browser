"""감독자 그래프의 상태. 비밀값은 절대 여기 담지 않는다."""

import re
from typing import Literal, TypedDict

from samba_agent.agents.contracts import AgentResult, Evidence, OrderRef
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_value

Stage = Literal['buy', 'pay', 'record', 'verify', 'done']
Outcome = Literal['done', 'failed', 'needs_human', 'cancelled']

# 애초에 state/체크포인트/승인 요약에 담기면 안 되는 키 — 있으면 저장을 거부한다
_SECRET_KEY_PATTERN = re.compile(r'password|secret|token|card_number|cvc|pin', re.IGNORECASE)


def sanitize_payload(payload: dict[str, object]) -> dict[str, object]:
    """state/체크포인트/승인 요약에 담기 전에 payload 를 가린다.

    비밀·카드번호류 키가 섞여 있으면(모델·브릿지가 실수로 돌려준 경우) 조용히 가리지
    않고 ValueError 로 거부한다 — 이름·전화·주소·이메일만 mask_value 로 가리고
    주문·금액·근거(카드 브랜드명 등)는 그대로 남긴다.
    """
    for key in payload:
        if _SECRET_KEY_PATTERN.search(key):
            raise ValueError(f'payload 에 비밀·카드 정보로 보이는 키가 있다: {key}')
    masked = mask_value(payload)
    assert isinstance(masked, dict)  # mask_value(dict) 는 항상 dict 를 돌려준다
    return masked


def sanitize_result(result: AgentResult) -> AgentResult:
    """AgentResult 를 state 에 저장하기 전에 payload 만 sanitize_payload 로 가린다."""
    if not result.payload:
        return result
    return result.model_copy(update={'payload': sanitize_payload(result.payload)})


class RunState(TypedDict, total=False):
    """실행 1건의 상태. LangGraph 체크포인트에 그대로 저장된다."""

    order: OrderRef
    options: dict[str, str]
    job_id: int
    dry_run: bool
    stage: Stage
    results: dict[str, AgentResult]
    attempts: dict[str, int]
    evidence: list[Evidence]
    outcome: Outcome | None
    fail_reason: FailReason | None
    approvals: dict[str, str]
