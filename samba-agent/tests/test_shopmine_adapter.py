# 샵마인 일괄 '완료됨' 절차 — 화면 드라이버는 가짜, 순서·되읽기·실패 분류를 본다
import pytest

from samba_agent.export.adapters import AdapterReject, AdapterRetry
from samba_agent.export.desktop.shopmine import ShopMineAdapter
from samba_agent.export.failures import ExportFail


class FakeUi:
    """샵마인 화면 가짜. rows 는 필터에 걸린 행 수, done 을 누르면 0 이 된다."""

    def __init__(self, rows: int = 3) -> None:
        self.rows = rows
        self.calls: list[str] = []
        self.ready_error: Exception | None = None
        self.wait_error: Exception | None = None
        # 완료됨을 눌러도 남는 행 수(되읽기 불일치 시험용)
        self.leftover = 0

    def ensure_ready(self) -> None:
        self.calls.append('ready')
        if self.ready_error is not None:
            raise self.ready_error

    def collect(self) -> None:
        self.calls.append('collect')

    def wait_collected(self, timeout_s: float) -> None:
        self.calls.append(f'wait {timeout_s:g}')
        if self.wait_error is not None:
            raise self.wait_error

    def set_filters(self) -> None:
        self.calls.append('filters')

    def row_count(self) -> int:
        self.calls.append('count')
        return self.rows

    def select_all(self) -> int:
        self.calls.append('select_all')
        return self.rows

    def set_status_done(self) -> None:
        self.calls.append('done')
        self.rows = self.leftover


def test_필터_결과를_전부_완료됨으로_바꾸고_되읽어_0을_확인한다():
    ui = FakeUi(rows=3)
    n = ShopMineAdapter(ui, collect_timeout_s=90).complete_pending()
    assert n == 3
    assert ui.calls == [
        'ready',
        'collect',
        'wait 90',
        'filters',
        'count',
        'select_all',
        'done',
        'filters',
        'count',
    ]


def test_필터_결과가_0이면_아무것도_누르지_않는다():
    ui = FakeUi(rows=0)
    assert ShopMineAdapter(ui).complete_pending() == 0
    assert 'select_all' not in ui.calls
    assert 'done' not in ui.calls


def test_dry_run_은_전체_선택까지만_한다():
    ui = FakeUi(rows=4)
    assert ShopMineAdapter(ui, dry_run=True).complete_pending() == 4
    assert ui.calls[-1] == 'select_all'
    assert 'done' not in ui.calls
    assert ui.rows == 4


def test_전체_선택_수가_행_수와_다르면_누르지_않고_거절한다():
    class Partial(FakeUi):
        def select_all(self) -> int:
            self.calls.append('select_all')
            return self.rows - 1

    ui = Partial(rows=3)
    with pytest.raises(AdapterReject) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.AMBIGUOUS
    assert 'done' not in ui.calls


def test_완료됨_뒤에도_행이_남으면_verify_mismatch():
    ui = FakeUi(rows=3)
    ui.leftover = 2
    with pytest.raises(AdapterReject) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.VERIFY_MISMATCH
    assert '2' in e.value.detail


def test_창이_없으면_AdapterRetry_가_그대로_나간다():
    ui = FakeUi()
    ui.ready_error = AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창 없음')
    with pytest.raises(AdapterRetry) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.WINDOW_MISSING
    assert ui.calls == ['ready']


def test_수집_시간_초과는_AdapterRetry_timeout():
    ui = FakeUi()
    ui.wait_error = AdapterRetry(ExportFail.TIMEOUT, '수집 120초 초과')
    with pytest.raises(AdapterRetry) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.TIMEOUT
    assert 'filters' not in ui.calls
