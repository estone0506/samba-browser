"""배정 — 등록부에서 조건이 맞는 에이전트를 고르고 Assignment 를 만든다.

LLM 이 아니라 코드가 고른다. 결정 근거가 남고 채점이 되기 때문이다(스펙 §4.3).
"""

from samba_agent.agents.contracts import Assignment
from samba_agent.agents.registry import AgentSpec, Registry
from samba_agent.supervisor.state import RunState


def build_assignment(reg: Registry, spec: AgentSpec, state: RunState) -> Assignment:
    """에이전트에 넘길 입력. 허용 도구와 규칙 본문을 감독자가 쥐여 준다."""
    buyer = next(
        (r for name, r in state.get('results', {}).items() if name.startswith('buyer.')), None
    )
    account = buyer.payload.get('account') if buyer else None
    return Assignment(
        order=state['order'],
        options=state.get('options', {}),
        account_candidates=(str(account),) if account else (),
        evidence_so_far=tuple(state.get('evidence', [])),
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=bool(state.get('dry_run', True)),
        expected=_expected(state),
    )


def _expected(state: RunState) -> dict[str, object]:
    """구매·결제 결과에서 기록·검증이 대조할 값만 뽑는다."""
    out: dict[str, object] = {}
    for name, r in state.get('results', {}).items():
        if name.startswith('buyer.'):
            out.update(
                {
                    'account': r.payload.get('account'),
                    'real_price': r.payload.get('cost'),
                    'source_order_no': r.payload.get('source_order_no'),
                }
            )
        if name == 'payer':
            out.setdefault('source_order_no', r.payload.get('source_order_no'))
    return {k: v for k, v in out.items() if v is not None}
