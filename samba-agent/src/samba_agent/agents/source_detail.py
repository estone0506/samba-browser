"""소싱처 주문 상세 읽기 — 기록·검증이 함께 쓴다.

결제가 끝난 뒤 실제 주문 상세에서 결제액·사용 적립금·후기 제외 적립·카드를 읽어 원가를 다시 계산한다.
결제 전 견적 원가는 적립금·적립을 빼먹는 일이 있다(실기 2026-09-24: 88,300 으로 기록, 실제 95,520).
스크립트가 없거나 틀리면 에이전트의 script_json 이 AI 수리로 이어 간다.
"""

from collections.abc import Callable

from samba_agent.agents.buyer import effective_cost
from samba_agent.agents.contracts import Assignment

SOURCE_DETAIL_SCRIPT = 'source_order_detail'


def detail_args(a: Assignment, source_order_no: object) -> dict[str, object]:
    """상세 스크립트 인자 — 삼바 주문번호·소싱처·소싱 주문번호·산 계정(프로필)."""
    args: dict[str, object] = {'orderNo': a.order.order_no, 'site': a.order.source}
    if source_order_no:
        args['source_order_no'] = source_order_no
    account = a.handoff.get('account') or a.order.account
    if account:
        args['profile'] = account
    return args


def detail_goal(site: str) -> str:
    return (
        f'소싱처({site}) 계정 profile 의 주문 상세에서 주문번호 source_order_no 의 주문을 열어 '
        '{source_order_no, status, paid(결제 금액 숫자), points_used(사용한 적립금 숫자, 없으면 0), '
        'reward(후기 적립을 뺀 이번 주문 적립 합계 숫자 — 머니 결제 적립·등급 적립 등, 없으면 0), '
        'card(결제 수단 글자, 예: 무신사페이 - 롯데카드)} 를 돌려준다. 주문을 바꾸거나 취소하지 않는다.'
    )


def detail_check(source_order_no: object) -> Callable[[dict[str, object]], str | None]:
    """주문번호가 같고 결제액을 읽었어야 통과."""

    def check(out: dict[str, object]) -> str | None:
        if source_order_no and str(out.get('source_order_no') or '') != str(source_order_no):
            return f'주문번호 {source_order_no} 의 상세를 읽지 못했다(읽은 번호 {out.get("source_order_no")})'
        if actual_cost(out) is None:
            return '결제 금액(paid)을 읽지 못했다'
        return None

    return check


def actual_cost(detail: dict[str, object]) -> float | None:
    """상세 값으로 원가(플레이북 §6): 결제액 × 카드 청구할인 − 후기 제외 적립 + 사용 적립금. 결제액을 모르면 None."""
    try:
        paid = float(detail.get('paid') or 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if paid <= 0:
        return None
    return float(
        effective_cost(
            {
                'cost': paid,
                'reward': detail.get('reward') or 0,
                'points_used': detail.get('points_used') or 0,
                'card': str(detail.get('card') or ''),
            }
        )
    )
