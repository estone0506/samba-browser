"""등록부 → 실제 에이전트 객체. 감독자는 이 사전만 받는다."""

from samba_agent.agents.base import DecideFn
from samba_agent.agents.buyer import BuyerAgent, ScriptsPendingBuyer, ShippingFn
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.recorder import RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.agents.verifier import VerifierAgent
from samba_agent.bridge.client import BridgeClient
from samba_agent.supervisor.graph import AgentFn
from samba_agent.wave.client import WaveClient

_CLASSES = {
    'buyer': BuyerAgent,
    'payer': PayerAgent,
    'recorder': RecorderAgent,
    'verifier': VerifierAgent,
}


def build_agents(
    reg: Registry, bridge: BridgeClient, decide: DecideFn, wave: WaveClient | None = None
) -> dict[str, AgentFn]:
    """이름 → 호출 가능한 에이전트. 새 소싱처는 sources.yaml 1행이면 여기 자동으로 생긴다.

    저장 스크립트가 없는 소싱처(status: scripts_pending)도 만들어 둔다 — 부르면 곧바로
    needs_human('스크립트 미작성: <id>') 이다.

    ``wave`` 를 주면 구매는 배송지를, 기록·검증은 삼바웨이브 행을 앱 화면 대신 내부 API 로 본다.
    """
    shipping_fn = _shipping_provider(wave)
    agents: dict[str, AgentFn] = {}
    for spec in [s for kind in _CLASSES for s in reg.of_kind(kind)]:
        source = reg.source_of(spec.name)
        if source is not None and source.status == 'scripts_pending':
            agents[spec.name] = ScriptsPendingBuyer(spec, source)
            continue
        agent = _CLASSES[spec.kind](spec, bridge, decide)
        if isinstance(agent, BuyerAgent):
            agent.set_shipping_provider(shipping_fn)
        elif isinstance(agent, RecorderAgent | VerifierAgent):
            agent.set_wave(wave)
        agents[spec.name] = agent
    return agents


def _shipping_provider(wave: WaveClient | None) -> ShippingFn | None:
    """주문번호 → 배송지 사전. 개인정보라 여기서 만들어 바로 넘기고 아무 데도 담지 않는다."""
    if wave is None:
        return None

    def fetch(order_no: str) -> dict[str, object]:
        # 까대기면 삼바웨이브가 사무실 주소를 준다 — 하네스가 판단하지 않는다
        return dict(wave.get_order(order_no).shipping.to_script_args())

    return fetch
