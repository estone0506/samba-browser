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


@pytest.fixture(autouse=True)
def _no_coupon_download(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """구매 시험은 기본으로 '쿠폰 받기' 단계를 끈다(스크립트 호출 순서를 가정한 시험이 많다).

    쿠폰 받기 자체를 보는 시험은 `@pytest.mark.coupon_download` 로 켠다.
    """
    if request.node.get_closest_marker('coupon_download'):
        return
    from samba_agent.agents import buyer as buyer_mod

    real = buyer_mod.source_of

    def patched(name: str):
        src = real(name)
        return src.model_copy(update={'coupon_download': False}) if src.coupon_download else src

    monkeypatch.setattr(buyer_mod, 'source_of', patched)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line('markers', 'coupon_download: 구매의 쿠폰 받기 단계를 켠 채 시험한다')
