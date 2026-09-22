"""SAMBA Browser 브릿지 클라이언트.

규약은 docs/bridge.md — 127.0.0.1:47811, 헤더 X-Samba-Token,
POST /tool/{name} 본문 {"args": {...}} → {"ok", "result", "steps"}.

이 클라이언트가 지키는 두 가지:
1. 허용 목록 — 감독자가 에이전트마다 준 도구 이름 밖은 HTTP 로 나가지도 않는다(스펙 §4.4).
2. 오류를 FailReason 으로 바꾼다 — 진단 표가 이 enum 으로만 집계된다.
"""

import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Self

import httpx

from samba_agent.failures import FailReason

DEFAULT_TIMEOUT_S = 95.0  # 앱 쪽 도구 제한 90초보다 조금 길게
DEFAULT_BUSY_RETRIES = 3
DEFAULT_BUSY_WAIT_S = 1.0

# HTTP 상태 → 실패 사유. 409 는 재시도 뒤에 따로 정한다
_STATUS_REASON = {
    401: FailReason.PERMISSION_DENIED,
    403: FailReason.PERMISSION_DENIED,
    # 404 는 권한이 아니라 그 이름의 도구가 앱에 없다는 뜻이다 — 구현 누락으로 센다
    404: FailReason.UNKNOWN,
    504: FailReason.BRIDGE_DOWN,
}


class BridgeError(Exception):
    """브릿지 호출 실패. 사유는 FailReason 으로 고정한다."""

    def __init__(self, reason: FailReason, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.reason = reason
        self.status = status


@dataclass(frozen=True)
class BridgeResult:
    """도구 호출 결과. result 는 채팅 AI 가 보는 것과 같은 본문 문자열이다."""

    result: str
    steps: tuple[tuple[str, bool], ...]


class BridgeClient:
    """도구 1건을 부르는 클라이언트. 에이전트마다 scoped() 로 좁혀서 쓴다."""

    def __init__(
        self,
        url: str,
        token: str,
        *,
        allowed: Sequence[str],
        timeout_s: float = DEFAULT_TIMEOUT_S,
        busy_retries: int = DEFAULT_BUSY_RETRIES,
        busy_wait_s: float = DEFAULT_BUSY_WAIT_S,
        client: httpx.Client | None = None,
    ) -> None:
        self._url = url.rstrip('/')
        self._token = token
        self._allowed = tuple(allowed)
        self._timeout_s = timeout_s
        self._busy_retries = busy_retries
        self._busy_wait_s = busy_wait_s
        self._client = client or httpx.Client(timeout=timeout_s)

    def scoped(self, allowed: Sequence[str]) -> 'BridgeClient':
        """허용 목록만 좁힌 사본. 감독자가 에이전트마다 만들어 넘긴다."""
        return BridgeClient(
            self._url,
            self._token,
            allowed=allowed,
            timeout_s=self._timeout_s,
            busy_retries=self._busy_retries,
            busy_wait_s=self._busy_wait_s,
            client=self._client,
        )

    @property
    def allowed(self) -> tuple[str, ...]:
        return self._allowed

    def health(self) -> list[str]:
        """앱이 살아 있는지 + 부를 수 있는 도구 이름."""
        try:
            r = self._client.get(f'{self._url}/health', headers=self._headers())
        except httpx.HTTPError as e:
            raise BridgeError(
                FailReason.BRIDGE_DOWN, f'브릿지 연결 실패: {type(e).__name__}'
            ) from e
        if r.status_code != 200:
            raise BridgeError(*self._fail(r))
        tools = r.json().get('tools', [])
        return [str(t) for t in tools]

    def call(self, name: str, /, **args: object) -> BridgeResult:
        """도구 1건 호출. 허용 목록 밖이면 나가지 않고 바로 권한 부족이다.

        도구 이름은 위치 전용(`/`)이다 — args 안에 `name` 키를 넣는 도구
        호출(예: run_script)과 충돌하지 않게.
        """
        if name not in self._allowed:
            raise BridgeError(
                FailReason.PERMISSION_DENIED,
                f'허용 목록 밖 도구: {name} (허용: {", ".join(self._allowed)})',
            )
        attempts = self._busy_retries + 1
        for i in range(attempts):
            try:
                r = self._client.post(
                    f'{self._url}/tool/{name}',
                    headers=self._headers(),
                    json={'args': args},
                )
            except httpx.TimeoutException as e:
                raise BridgeError(FailReason.BRIDGE_DOWN, f'도구 시간 초과: {name}') from e
            except httpx.HTTPError as e:
                raise BridgeError(
                    FailReason.BRIDGE_DOWN, f'브릿지 연결 실패: {type(e).__name__}'
                ) from e
            if r.status_code == 200:
                body = r.json()
                steps = tuple(
                    (str(s.get('label', '')), bool(s.get('ok'))) for s in body.get('steps', [])
                )
                return BridgeResult(result=str(body.get('result', '')), steps=steps)
            if r.status_code == 409:
                if i < attempts - 1:
                    time.sleep(self._busy_wait_s)
                    continue
                # 채팅 실행 중이거나 앱이 읽기 전용 모드라 세션을 못 연다
                raise BridgeError(
                    FailReason.BRIDGE_DOWN, f'브릿지가 계속 busy 다({attempts}회 시도)', 409
                )
            raise BridgeError(*self._fail(r))
        # 고리는 항상 return 이나 raise 로 끝난다(409 마지막 시도도 raise) — 여기는 닿지 않는다

    def close(self) -> None:
        """HTTP 연결을 닫는다. scoped() 사본은 같은 커넥션을 공유하니 한 번만 닫는다."""
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _headers(self) -> dict[str, str]:
        return {'X-Samba-Token': self._token, 'content-type': 'application/json'}

    @staticmethod
    def _fail(r: httpx.Response) -> tuple[FailReason, str, int]:
        """응답 → (사유, 메시지, 상태). 메시지에 토큰은 들어가지 않는다(응답 본문만 쓴다)."""
        reason = _STATUS_REASON.get(r.status_code, FailReason.UNKNOWN)
        try:
            detail = str(r.json().get('error', ''))
        except ValueError:
            detail = ''
        return reason, f'브릿지 {r.status_code}: {detail}'.strip(), r.status_code
