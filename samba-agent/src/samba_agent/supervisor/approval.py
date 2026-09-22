"""사람 검토 게이트 — 외부를 바꾸기 직전에 그래프를 멈추고 사람에게 묻는다(스펙 §10-1).

멈추는 자리는 두 곳뿐이다: 결제(pay)와 SAMBA-WAVE 기록(record).
요약 문장은 슬랙 메시지에 그대로 붙는다 — 사람이 이것만 보고 승인·거부를 고른다.
"""

from dataclasses import dataclass
from typing import Literal

from langgraph.types import Command

from samba_agent.agents.contracts import Evidence
from samba_agent.supervisor.state import RunState, sanitize_payload

APPROVAL_INTERRUPT_KEY = 'samba.approval'

_STAGE_TITLE = {'pay': '결제', 'record': 'SAMBA-WAVE 기록'}


@dataclass(frozen=True)
class ApprovalRequest:
    """슬랙에 띄울 승인 요청."""

    stage: Literal['pay', 'record']
    order_no: str
    summary: str
    evidence: tuple[Evidence, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            'kind': APPROVAL_INTERRUPT_KEY,
            'stage': self.stage,
            'order_no': self.order_no,
            'summary': self.summary,
            'evidence': [e.model_dump() for e in self.evidence],
        }


def approval_request(stage: str, state: RunState) -> ApprovalRequest:
    """지금까지의 결과로 승인 요약을 만든다. 금액은 천 단위 쉼표로 읽기 쉽게."""
    order = state['order']
    buyer = next(
        (r for name, r in state.get('results', {}).items() if name.startswith('buyer.')), None
    )
    payload = sanitize_payload(buyer.payload) if buyer else {}
    cost = payload.get('cost')
    cost_text = f'{int(cost):,}원' if isinstance(cost, (int, float)) else '미정'
    lines = [
        f'*{_STAGE_TITLE[stage]} 승인 요청* — 주문 {order.order_no} ({order.source})',
        f'계정: {payload.get("account", "미정")} · 카드: {payload.get("card", "없음")}',
        f'원가: {cost_text} · 마진: {payload.get("margin_pct", "미정")}%',
        f'모드: {"dry-run(외부 변경 없음)" if state.get("dry_run", True) else "실제 반영"}',
    ]
    if buyer is not None:
        lines.append(f'구매 에이전트 근거: {buyer.reason}')
    return ApprovalRequest(
        stage=stage,  # type: ignore[arg-type]
        order_no=order.order_no,
        summary='\n'.join(lines),
        evidence=tuple(state.get('evidence', [])),
    )


def resume_command(approved: bool, by: str) -> Command:
    """슬랙 버튼 → 그래프 재개.

    `by` 가 이 단계를 승인할 권한이 있는 사람인지는 이 계층이 검사하지 않는다 —
    승인자 권한 검사(허용 목록)는 호출자(슬랙 봇, Task 11) 책임이다.
    """
    return Command(resume={'approved': approved, 'by': by})
