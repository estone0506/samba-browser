"""감독자 그래프 — 구매 → 결제 → 기록 → 검증 순으로 넘기고 결과를 검사한다.

각 단계는 노드 하나다. 노드는 등록부에서 에이전트를 고르고(코드 배정),
`agents` 에 등록된 함수를 부르고, 결과를 검사해 다음 단계로 갈지 사람에게 넘길지 정한다.
"""

from collections.abc import Callable, Mapping

from langgraph.graph import END, StateGraph

from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeError
from samba_agent.failures import FailReason
from samba_agent.supervisor.assign import build_assignment
from samba_agent.supervisor.policy import KIND_OF_STAGE, STAGES, check_buyer, should_retry
from samba_agent.supervisor.state import RunState

AgentFn = Callable[..., AgentResult]
# 외부 변경 직전 승인 함수(Task 6 이 채운다). None 이면 승인 단계가 없다
ApproveFn = Callable[[str, RunState, AgentResult], bool]

# 외부 시스템을 실제로 바꾸는 단계 — 사람 승인 없이는 들어가지 않는다(스펙 §10-1)
EXTERNAL_STAGES = ('pay', 'record')


def _stop(state: RunState, name: str, result: AgentResult) -> RunState:
    """사람에게 넘기고 멈춘다."""
    results = {**state.get('results', {}), name: result}
    return {
        **state,
        'results': results,
        'stage': 'done',
        'outcome': 'needs_human',
        'fail_reason': result.fail_reason or FailReason.UNKNOWN,
    }


def _run_stage(
    reg: Registry, agents: Mapping[str, AgentFn], stage: str, state: RunState
) -> RunState:
    """한 단계 — 배정 → 실행 → 검사 → (필요하면) 재시도 1회."""
    spec = reg.pick(KIND_OF_STAGE[stage], state['order'], state.get('options', {}))
    if spec is None:
        return _stop(
            state,
            'supervisor',
            AgentResult(
                status='needs_human',
                reason=f'unsupported: {state["order"].source} 를 맡을 {stage} 에이전트가 없다',
                fail_reason=FailReason.UNKNOWN,
            ),
        )
    fn = agents.get(spec.name)
    if fn is None:
        return _stop(
            state,
            spec.name,
            AgentResult(
                status='needs_human',
                reason=f'등록부에 있으나 구현이 없다: {spec.name}',
                fail_reason=FailReason.UNKNOWN,
            ),
        )
    attempts = dict(state.get('attempts', {}))
    while True:
        attempts[spec.name] = attempts.get(spec.name, 0) + 1
        try:
            result = fn(build_assignment(reg, spec, state))
        except BridgeError as e:
            result = AgentResult(status='fail', reason=f'브릿지 오류: {e}', fail_reason=e.reason)
        if stage == 'buy':
            result = check_buyer(result)
        if result.status == 'ok':
            break
        if should_retry(spec, result, attempts[spec.name]):
            continue
        return _stop({**state, 'attempts': attempts}, spec.name, result)
    return {
        **state,
        'results': {**state.get('results', {}), spec.name: result},
        'attempts': attempts,
        'evidence': [*state.get('evidence', []), *result.evidence],
        'stage': stage,
    }


def _finish(state: RunState) -> RunState:
    """끝. 이미 멈춘 상태면 그대로 두고, 아니면 done."""
    if state.get('outcome') is not None:
        return {**state, 'stage': 'done'}
    return {**state, 'stage': 'done', 'outcome': 'done', 'fail_reason': None}


def build_supervisor(
    reg: Registry,
    agents: Mapping[str, AgentFn],
    *,
    checkpointer: object | None = None,
    approve: ApproveFn | None = None,
):
    """감독자 그래프를 만든다. agents 는 이름 → 함수(실제 에이전트 또는 테스트용 가짜)."""
    graph: StateGraph = StateGraph(RunState)

    def make(stage: str) -> Callable[[RunState], RunState]:
        def node(state: RunState) -> RunState:
            if state.get('outcome') is not None:
                return state
            # 외부를 바꾸는 단계는 사람 승인을 먼저 받는다(스펙 §10-1). Task 6 이 이 자리를 쓴다
            if approve is not None and stage in EXTERNAL_STAGES:
                last = list(state.get('results', {}).values())[-1]
                if not approve(stage, state, last):
                    return _stop(
                        state,
                        f'approval.{stage}',
                        AgentResult(
                            status='needs_human',
                            reason=f'{stage} 단계를 사용자가 승인하지 않았다',
                            fail_reason=FailReason.PERMISSION_DENIED,
                        ),
                    )
            return _run_stage(reg, agents, stage, state)

        return node

    for stage in STAGES:
        graph.add_node(stage, make(stage))
    graph.add_node('finish', _finish)
    graph.set_entry_point(STAGES[0])
    for i, stage in enumerate(STAGES):
        nxt = STAGES[i + 1] if i + 1 < len(STAGES) else 'finish'
        graph.add_conditional_edges(
            stage,
            lambda s, nxt=nxt: 'finish' if s.get('outcome') is not None else nxt,
            {nxt: nxt, 'finish': 'finish'},
        )
    graph.add_edge('finish', END)
    return graph.compile(checkpointer=checkpointer) if checkpointer else graph.compile()
