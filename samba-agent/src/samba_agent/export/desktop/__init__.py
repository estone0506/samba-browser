"""외부 프로그램 어댑터 등록 지점.

어댑터는 프로그램마다 실제 화면을 읽기 전용으로 탐색한 뒤 따로 만든다
(샵마인·EMP 어댑터 계획). 여기 등록된 대상만 입력 작업자가 큐에서 집는다 —
등록되지 않은 대상의 요청은 큐에 대기로 남는다.
"""

from samba_agent.export.adapters import Adapter


def build_adapters() -> dict[str, Adapter]:
    """이 PC 에서 쓸 어댑터(대상 이름 → 어댑터)."""
    return {}
