"""테스트 공통 설정.

테스트는 로컬 `.env` 를 읽지 않는다 — 개발자 기계의 슬랙 토큰·채널·허용 사용자에 따라
결과가 달라지면 안 되고, 실수로 실제 토큰이 테스트 경로로 흘러들어도 안 된다.
"""

import pytest

from samba_agent.settings import Settings


@pytest.fixture(autouse=True)
def _no_local_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """`Settings()` 가 `.env` 파일을 소스로 쓰지 않게 한다(환경변수만 본다)."""
    monkeypatch.setitem(Settings.model_config, 'env_file', None)
