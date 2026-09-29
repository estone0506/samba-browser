"""EMP 어댑터 — 주문 한 건의 원가·배송비를 EMP 주문 그리드에 읽고 쓴다(스펙 §6).

작업자의 셀형 규약(Adapter: read · write)을 따른다. 덮어쓰기 금지·되읽기 비교는 작업자가 한다.
화면을 만지는 일은 드라이버(emp_ui.py)가 한다. 관리자 권한 프로세스에서만 동작한다.
"""

from typing import Protocol

from samba_agent.export.adapters import CellValues


def parse_won(text: str | None) -> int | None:
    """'33,440' → 33440. 빈 칸은 None, 숫자가 아니면 ValueError."""
    raw = (text or '').replace(',', '').strip()
    if not raw:
        return None
    return round(float(raw))


class EmpUi(Protocol):
    """EMP 주문 그리드 조작. 못 하는 상황은 AdapterRetry, 다시 해도 같은 것은 AdapterReject."""

    def ensure_ready(self) -> None: ...

    def search(self) -> None:
        """검색 기간에 오늘이 들어가게 하고 검색시작을 누른다."""
        ...

    def read(self, order_no: str) -> CellValues: ...

    def write(self, order_no: str, cost: int, shipping_fee: int) -> None: ...


class EmpAdapter:
    """Adapter 구현 — 부를 때마다 창 상태를 다시 확인한다(사이에 최소화·대화상자가 생길 수 있다)."""

    def __init__(self, ui: EmpUi) -> None:
        self._ui = ui

    def read(self, order_no: str) -> CellValues:
        self._ui.ensure_ready()
        # 조건이 먼저다 — 오늘이 빠진 기간이면 오늘 주문이 그리드에 없다
        self._ui.search()
        return self._ui.read(order_no)

    def write(self, order_no: str, cost: int, shipping_fee: int) -> None:
        self._ui.ensure_ready()
        self._ui.write(order_no, cost, shipping_fee)
