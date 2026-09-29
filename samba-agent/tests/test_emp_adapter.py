# EMP 어댑터 — 부를 때마다 창 상태를 확인하고 드라이버에 넘긴다. 금액 글자 읽기
import pytest

from samba_agent.export.adapters import AdapterRetry, CellValues
from samba_agent.export.desktop.emp import EmpAdapter, parse_won
from samba_agent.export.failures import ExportFail


class FakeUi:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.rows = {'E1': CellValues(0, 0)}
        self.ready_error: Exception | None = None

    def ensure_ready(self) -> None:
        self.calls.append('ready')
        if self.ready_error is not None:
            raise self.ready_error

    def search(self) -> None:
        self.calls.append('search')

    def read(self, order_no: str) -> CellValues:
        self.calls.append(f'read {order_no}')
        return self.rows[order_no]

    def write(self, order_no: str, cost: int, shipping_fee: int) -> None:
        self.calls.append(f'write {order_no} {cost} {shipping_fee}')
        self.rows[order_no] = CellValues(cost, shipping_fee)


def test_읽기와_쓰기_앞에_창_상태를_확인한다():
    ui = FakeUi()
    adapter = EmpAdapter(ui)
    assert adapter.read('E1') == CellValues(0, 0)
    adapter.write('E1', 57131, 2300)
    assert adapter.read('E1') == CellValues(57131, 2300)
    assert ui.calls == [
        'ready',
        'search',
        'read E1',
        'ready',
        'write E1 57131 2300',
        'ready',
        'search',
        'read E1',
    ]


def test_창이_준비되지_않으면_드라이버를_부르지_않는다():
    ui = FakeUi()
    ui.ready_error = AdapterRetry(ExportFail.WINDOW_MISSING, 'EMP 창이 없다')
    with pytest.raises(AdapterRetry):
        EmpAdapter(ui).write('E1', 1000, 0)
    assert ui.calls == ['ready']


@pytest.mark.parametrize(
    ('text', 'want'),
    [
        ('33,440', 33440),
        ('0', 0),
        ('2,300', 2300),
        ('57131', 57131),
        ('', None),
        (None, None),
        (' 1,000 ', 1000),
    ],
)
def test_금액_글자를_원_단위_정수로_읽는다(text, want):
    assert parse_won(text) == want


def test_숫자가_아닌_금액은_오류다():
    with pytest.raises(ValueError):
        parse_won('무료')
