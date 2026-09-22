"""감독자 그래프 — 구매 → 결제 → 기록 → 검증 순으로 넘기고 결과를 검사한다.

각 단계는 노드 하나다. 노드는 등록부에서 에이전트를 고르고(코드 배정),
`agents` 에 등록된 함수를 부르고, 결과를 검사해 다음 단계로 갈지 사람에게 넘길지 정한다.
"""

from collections.abc import Callable, Mapping

from langgraph.graph import END, StateGraph
from langgraph.types import Command, interrupt

from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeError
from samba_agent.failures import FailReason
from samba_agent.supervisor.approval import approval_request
from samba_agent.supervisor.assign import build_assignment
from samba_agent.supervisor.policy import KIND_OF_STAGE, STAGES, check_buyer, should_retry
from samba_agent.supervisor.state import RunState

AgentFn = Callable[..., AgentResult]

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


class _ResumeSafeGraph:
    """체크포인터가 있을 때, 같은 스레드로 평범한 입력을 다시 넣어도 처음부터 다시 돌지 않게 막는다.

    LangGraph 는 진행 중(중단 포함)인 스레드에 dict 입력을 다시 주면 그 입력으로 새로
    시작해버린다. 승인 대기 중에 같은 요청이 중복으로 들어와도(예: 재시도 큐, 재배포) 이미 한
    구매·결제를 다시 돌리지 않도록, 대기 중인 스레드에는 입력을 무시하고 그냥 재개한다.
    """

    def __init__(self, compiled: object) -> None:
        self._compiled = compiled

    def _resume_in_place(self, input_: object, config: object | None) -> bool:
        if config is None or isinstance(input_, Command) or input_ is None:
            return False
        snapshot = self._compiled.get_state(config)  # type: ignore[attr-defined]
        return bool(snapshot.next)

    def invoke(self, input_: object, config: object | None = None, **kwargs: object) -> object:
        if self._resume_in_place(input_, config):
            input_ = None
        return self._compiled.invoke(input_, config, **kwargs)  # type: ignore[attr-defined]

    def __getattr__(self, name: str) -> object:
        return getattr(self._compiled, name)


def build_supervisor(
    reg: Registry,
    agents: Mapping[str, AgentFn],
    *,
    checkpointer: object | None = None,
    gate: bool = False,
):
    """감독자 그래프를 만든다. agents 는 이름 → 함수(실제 에이전트 또는 테스트용 가짜)."""
    if gate and checkpointer is None:
        raise ValueError('게이트를 쓰려면 체크포인터가 필요하다')

    graph: StateGraph = StateGraph(RunState)

    def make(stage: str) -> Callable[[RunState], RunState]:
        def node(state: RunState) -> RunState:
            if state.get('outcome') is not None:
                return state
            # 외부를 바꾸는 단계는 여기서 멈춘다. 슬랙 승인 버튼이 Command(resume=...) 로 깨운다
            if gate and stage in EXTERNAL_STAGES:
                answer = interrupt(approval_request(stage, state).as_dict())
                by = str(answer.get('by', '')) if isinstance(answer, dict) else ''
                approved = bool(answer.get('approved')) if isinstance(answer, dict) else False
                if not approved:
                    return _stop(
                        state,
                        f'approval.{stage}',
                        AgentResult(
                            status='needs_human',
                            reason=f'{stage} 단계를 사용자가 승인하지 않았다',
                            fail_reason=FailReason.PERMISSION_DENIED,
                        ),
                    )
                state = {**state, 'approvals': {**state.get('approvals', {}), stage: by}}
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
    if checkpointer:
        return _ResumeSafeGraph(graph.compile(checkpointer=checkpointer))
    return graph.compile()
