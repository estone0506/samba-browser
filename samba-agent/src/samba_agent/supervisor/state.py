"""감독자 그래프의 상태. 비밀값은 절대 여기 담지 않는다."""

from typing import Literal, TypedDict

from samba_agent.agents.contracts import AgentResult, Evidence, OrderRef
from samba_agent.failures import FailReason

Stage = Literal['buy', 'pay', 'record', 'verify', 'done']
Outcome = Literal['done', 'failed', 'needs_human', 'cancelled']


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
