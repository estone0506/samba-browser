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
    config.addinivalue_line('markers', 'read_only_retry: 읽기 전용 스크립트 수리 전 재실행을 켠 채 시험한다')



@pytest.fixture(autouse=True)
def no_close_order_tabs(monkeypatch):
    """스냅샷 전 주문서 탭 정리(run_js)는 브릿지 목업에 없는 호출이다 — 테스트에서는 건너뛴다."""
    from samba_agent.agents.buyer import BuyerAgent

    monkeypatch.setattr(BuyerAgent, '_close_order_tabs', lambda self, account: None)


@pytest.fixture(autouse=True)
def no_read_only_retry(request, monkeypatch):
    """수리 전 재실행은 브릿지 목업의 호출 순서를 바꾼다 — 그 동작을 시험하는 테스트(read_only_retry 표시)만 켠다."""
    if request.node.get_closest_marker('read_only_retry'):
        return
    from samba_agent.agents import base

    monkeypatch.setattr(base, 'READ_ONLY_SCRIPT_SUFFIXES', ())
