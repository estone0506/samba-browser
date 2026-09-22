"""에이전트 공통 계약(스펙 §4.3).

입력은 Assignment, 출력은 AgentResult 하나뿐이다 — 감독자는 이 둘만 본다.
모든 판단에 reason 을 요구한다. 채점기와 진단 표가 이 문장을 읽는다.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from samba_agent.failures import FailReason


class OrderRef(BaseModel):
    """처리 대상 주문. 고객 개인정보는 담지 않는다 — 마스킹 대상 자체를 안 들인다."""

    order_no: str
    source: str  # 소싱처: 무신사 · 29CM · ABC마트 · 롯데온
    seller: str  # 판매처: 포이즌 등
    sku: str
    qty: int = Field(default=1, gt=0)  # 0 이하 수량은 애초에 만들 수 없다


class Evidence(BaseModel):
    """판단의 근거 조각(화면 문구·금액·주문번호). 진단과 검수 큐가 본다."""

    label: str
    detail: str


class Assignment(BaseModel):
    """감독자 → 에이전트. allowed_tools 밖의 도구는 브릿지 클라이언트가 거절한다."""

    order: OrderRef
    options: dict[str, str] = Field(default_factory=dict)
    account_candidates: tuple[str, ...] = ()
    evidence_so_far: tuple[Evidence, ...] = ()
    allowed_tools: tuple[str, ...]
    rules: str
    # True 면 외부를 바꾸는 도구(결제·기록)를 부르지 않고 계획만 돌려준다
    dry_run: bool = True
    # 감독자가 아는 기대값(소싱주문번호·실구매가·배송비·플래그). 기록·검증이 '대조' 에 쓴다 —
    # 검증 에이전트가 이 키를 전부 소싱처·SAMBA 행과 맞춰보므로 대조 대상만 담는다
    expected: dict[str, object] = Field(default_factory=dict)
    # 앞 단계 에이전트가 넘긴 인계값(카드·원가·마진·계정·소싱주문번호). 대조 대상이 아니라
    # '다음 단계가 일을 하려면 필요한 값' 이다(리뷰 지적 — C3·I1·I2)
    handoff: dict[str, object] = Field(default_factory=dict)


class AgentResult(BaseModel):
    """에이전트 → 감독자. 이 모양 말고는 아무것도 돌려주지 않는다."""

    status: Literal['ok', 'fail', 'needs_human']
    payload: dict[str, object] = Field(default_factory=dict)
    reason: str = Field(min_length=1)
    fail_reason: FailReason | None = None
    evidence: tuple[Evidence, ...] = ()

    @model_validator(mode='after')
    def _check_fail_reason(self) -> 'AgentResult':
        """실패·사람 넘김에는 사유가 반드시 있고, 성공에는 없어야 한다."""
        if self.status == 'ok' and self.fail_reason is not None:
            raise ValueError('성공 결과에 fail_reason 이 있다')
        if self.status != 'ok' and self.fail_reason is None:
            raise ValueError('실패·사람 넘김에는 fail_reason 이 필요하다')
        return self
