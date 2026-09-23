"""등록부 → 실제 에이전트 객체. 감독자는 이 사전만 받는다."""

from samba_agent.agents.base import DecideFn
from samba_agent.agents.buyer import BuyerAgent, ScriptsPendingBuyer
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.recorder import RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.agents.verifier import VerifierAgent
from samba_agent.bridge.client import BridgeClient
from samba_agent.supervisor.graph import AgentFn

_CLASSES = {
    'buyer': BuyerAgent,
    'payer': PayerAgent,
    'recorder': RecorderAgent,
    'verifier': VerifierAgent,
}


def build_agents(reg: Registry, bridge: BridgeClient, decide: DecideFn) -> dict[str, AgentFn]:
    """이름 → 호출 가능한 에이전트. 새 소싱처는 sources.yaml 1행이면 여기 자동으로 생긴다.

    저장 스크립트가 없는 소싱처(status: scripts_pending)도 만들어 둔다 — 부르면 곧바로
    needs_human('스크립트 미작성: <id>') 이다.
    """
    agents: dict[str, AgentFn] = {}
    for spec in [s for kind in _CLASSES for s in reg.of_kind(kind)]:
        source = reg.source_of(spec.name)
        if source is not None and source.status == 'scripts_pending':
            agents[spec.name] = ScriptsPendingBuyer(spec, source)
        else:
            agents[spec.name] = _CLASSES[spec.kind](spec, bridge, decide)
    return agents
