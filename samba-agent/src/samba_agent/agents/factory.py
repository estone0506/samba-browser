"""등록부 → 실제 에이전트 객체. 감독자는 이 사전만 받는다."""

from samba_agent.agents.base import DecideFn
from samba_agent.agents.buyer import BuyerAgent
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
    """이름 → 호출 가능한 에이전트. 새 소싱처는 등록부 1행이면 여기 자동으로 생긴다."""
    return {
        spec.name: _CLASSES[spec.kind](spec, bridge, decide)
        for spec in [s for kind in _CLASSES for s in reg.of_kind(kind)]
    }
