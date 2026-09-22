"""전문 에이전트 공통 껍데기(스펙 §4.3).

에이전트가 밖으로 낼 수 있는 것은 AgentResult 하나다. 도중의 실패는 AgentFailure 로 던지고
run_agent 가 그것을 결과로 바꾼다 — 감독자는 예외를 보지 않는다.
"""

import json
from collections.abc import Callable
from typing import Literal

from pydantic import BaseModel, Field

from samba_agent.agents.contracts import AgentResult, Evidence
from samba_agent.agents.refusal import classify_refusal
from samba_agent.agents.registry import AgentSpec
from samba_agent.bridge.client import BridgeClient, BridgeError
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text

# 앱 도구가 캡차·2단계 인증에서 돌려주는 표시(docs/bridge.md)
NEEDS_USER_MARKERS = ('needs_user', '캡차', 'captcha')
# 표식 검사에서 뺄 결과 머리 — login 도구의 정상 응답 'submitted: check the page for success or
# captcha/2FA' 가 'captcha' 글자만으로 캡차로 읽혀 로그인마다 사람에게 넘어갔다(실기)
_MARKER_EXEMPT_PREFIXES = ('submitted:',)
# 구조화 출력은 한 번만 다시 묻는다(스펙 §6)
DECIDE_RETRIES = 1


class Decision(BaseModel):
    """LLM 판단의 공통 모양. reason 없는 판단은 만들 수 없다."""

    choice: str
    reason: str = Field(min_length=1)


DecideFn = Callable[[str, type[BaseModel]], BaseModel]


class AgentFailure(Exception):
    """에이전트 중단. 감독자가 보는 것은 이걸 바꾼 AgentResult 다."""

    def __init__(
        self, status: Literal['fail', 'needs_human'], reason: str, fail_reason: FailReason
    ) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason
        self.fail_reason = fail_reason


class AgentBase:
    """도구 호출과 LLM 판단의 공통 부분."""

    def __init__(self, spec: AgentSpec, bridge: BridgeClient, decide: DecideFn) -> None:
        self.spec = spec
        # 등록부의 허용 목록으로 좁힌 클라이언트만 쥔다 — 목록 밖은 나가지도 않는다
        self.bridge = bridge.scoped(spec.tools)
        self._decide = decide
        self.evidence: list[Evidence] = []
        # 진행 보고 횟수 — 앱 progress 도구는 done/total 정수가 필수다(실기: label 만 보내 거절당함)
        self._steps = 0

    def tool(self, name: str, /, **args: object) -> str:
        """도구 1건. 캡차 표시는 사람에게, 브릿지 오류는 사유 그대로 실패로 바꾼다."""
        try:
            out = self.bridge.call(name, **args)
        except BridgeError as e:
            # 항상 fail 로 던진다. 권한 부족·중복은 감독자의 NO_RETRY_REASONS 가
            # 재시도 없이 바로 needs_human 으로 넘긴다(스펙 §6) — 여기서 판단하지 않는다
            raise AgentFailure('fail', str(e), e.reason) from e
        if not out.result.lstrip().startswith(_MARKER_EXEMPT_PREFIXES) and any(
            m in out.result for m in NEEDS_USER_MARKERS
        ):
            raise AgentFailure('needs_human', f'사람 확인 필요: {name}', FailReason.CAPTCHA)
        # 앱은 거절을 HTTP 오류가 아니라 200 + 'refused: …' 로 돌려준다 — 성공으로 읽으면
        # 잠긴 금고·읽기 전용 모드에서도 다음 단계로 넘어간다(리뷰 지적 — I5)
        verdict = classify_refusal(out.result)
        if verdict is not None:
            status, reason = verdict
            raise AgentFailure(
                status, f'{name} 거절: {mask_text(out.result.strip()[:120])}', reason
            )
        return out.result

    def json_tool(self, name: str, /, **args: object) -> dict[str, object]:
        """결과가 JSON 인 저장 스크립트용. 형식이 깨지면 unknown 실패다."""
        raw = self.tool(name, **args)
        try:
            parsed = json.loads(raw)
        except ValueError as e:
            raise AgentFailure('fail', f'{name} 결과가 JSON 이 아니다', FailReason.UNKNOWN) from e
        if not isinstance(parsed, dict):
            raise AgentFailure('fail', f'{name} 결과가 객체가 아니다', FailReason.UNKNOWN)
        return parsed

    def decide_once(self, prompt: str, model: type[BaseModel]) -> BaseModel:
        """구조화 출력. 실패하면 한 번만 다시 묻고, 또 실패하면 사람에게 넘긴다."""
        last: Exception | None = None
        for _ in range(DECIDE_RETRIES + 1):
            try:
                return self._decide(prompt, model)
            except Exception as e:  # noqa: BLE001 — 판단 함수가 던지는 형식은 정해져 있지 않다
                last = e
        raise AgentFailure('needs_human', f'구조화 출력 실패: {last}', FailReason.UNKNOWN) from last

    def note(self, label: str, detail: str) -> None:
        """근거 조각을 남긴다. 결과에 함께 실려 진단·검수 큐가 본다."""
        self.evidence.append(Evidence(label=label, detail=detail))

    def step(self, label: str) -> None:
        """진행 보고 — 슬랙 스레드에 한 줄로 뜬다.

        앱의 progress 도구는 0 <= done <= total, total >= 1 을 요구한다. 단계 총수는 미리 모르니
        n번째 보고를 'n-1 / n'(n번째 진행 중)으로 보낸다.
        """
        if 'progress' in self.spec.tools:
            self._steps += 1
            self.tool('progress', label=label, done=self._steps - 1, total=self._steps)


def run_agent(
    fn: Callable[[], AgentResult], evidence: Callable[[], list[Evidence]] | None = None
) -> AgentResult:
    """AgentFailure 를 AgentResult 로 바꾼다. 감독자는 예외를 보지 않는다.

    ``evidence`` 를 주면 실패 결과에도 그때까지의 근거를 싣는다 — 실기에서 실패 사유만 남고
    어느 단계까지 갔는지(옵션 목록·계정·배송지) 알 수 없어 진단이 막혔다.
    """
    try:
        return fn()
    except AgentFailure as e:
        return AgentResult(
            status=e.status,
            reason=e.reason,
            fail_reason=e.fail_reason,
            evidence=tuple(evidence()) if evidence is not None else (),
        )
