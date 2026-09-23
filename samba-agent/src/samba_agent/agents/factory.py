"""등록부 → 실제 에이전트 객체. 감독자는 이 사전만 받는다."""

from samba_agent.agents.base import AgentFailure, DecideFn
from samba_agent.agents.buyer import BuyerAgent, ScriptsPendingBuyer, ShippingFn
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.recorder import RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.agents.verifier import VerifierAgent
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.supervisor.graph import AgentFn
from samba_agent.wave.client import WaveClient

_CLASSES = {
    'buyer': BuyerAgent,
    'payer': PayerAgent,
    'recorder': RecorderAgent,
    'verifier': VerifierAgent,
}


def build_agents(
    reg: Registry,
    bridge: BridgeClient,
    decide: DecideFn,
    wave: WaveClient | None = None,
    ship_phone: str | None = None,
) -> dict[str, AgentFn]:
    """이름 → 호출 가능한 에이전트. 새 소싱처는 sources.yaml 1행이면 여기 자동으로 생긴다.

    저장 스크립트가 없는 소싱처(status: scripts_pending)도 만들어 둔다 — 부르면 곧바로
    needs_human('스크립트 미작성: <id>') 이다.

    ``wave`` 를 주면 구매는 배송지를, 기록·검증은 삼바웨이브 행을 앱 화면 대신 내부 API 로 본다.
    """
    shipping_fn = _shipping_provider(wave, ship_phone)
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


def _shipping_provider(wave: WaveClient | None, ship_phone: str | None = None) -> ShippingFn | None:
    """(주문번호, 배송 종류) → 배송지 사전. 개인정보라 여기서 만들어 바로 넘기고 아무 데도 담지 않는다.

    - 고객 전화번호는 어디에도 입력하지 않는다(사용자 지시) — 연락처는 삼바웨이브 contact_phone,
      없으면 설정 SAMBA_SHIP_PHONE. 둘 다 없으면 사람에게 넘긴다.
    - 까대기를 요청했는데 삼바웨이브가 다른 종류(고객 주소)를 주면 그대로 쓰지 않고 멈춘다 —
      고객 집으로 보내는 사고보다 낫다.
    """
    if wave is None:
        return None

    def fetch(order_no: str, order_type: str) -> dict[str, object]:
        detail = wave.get_order(order_no, order_type=order_type)  # type: ignore[arg-type]
        if order_type == 'kkadaegi' and detail.order_type != 'kkadaegi':
            raise AgentFailure(
                'needs_human',
                '사무실 배송지를 받지 못했다 — 삼바웨이브 상세 API 가 order_type 요청을 지원해야 한다',
                FailReason.UNKNOWN,
            )
        phone = (detail.contact_phone or '').strip() or (ship_phone or '').strip()
        if not phone:
            raise AgentFailure(
                'needs_human',
                '배송 연락처가 없다 — SAMBA_SHIP_PHONE 설정 또는 삼바웨이브 contact_phone 필요',
                FailReason.UNKNOWN,
            )
        args = dict(detail.shipping.to_script_args())
        args['phone'] = phone  # 고객 번호를 덮어쓴다 — 어떤 경우에도 고객 전화번호는 넣지 않는다
        return args

    return fetch
