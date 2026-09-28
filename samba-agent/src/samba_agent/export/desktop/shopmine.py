"""샵마인 어댑터 — 통합주문관리의 '미지정 · 엑셀생성안됨' 주문을 전부 작업상태 '완료됨'으로(스펙 §6.1).

절차만 있다. 화면을 실제로 만지는 일은 ShopMineUi 드라이버(shopmine_ui.py, pywinauto)가 한다 —
그래서 절차는 가짜 드라이버로 시험하고, 드라이버는 실기로 시험한다.
"""

from typing import Protocol

from samba_agent.export.adapters import AdapterReject
from samba_agent.export.failures import ExportFail


class ShopMineUi(Protocol):
    """샵마인 통합주문관리 화면 조작. 못 하는 상황은 AdapterRetry 로 던진다."""

    def ensure_ready(self) -> None:
        """창이 있고 통합주문관리 탭이 앞에 있으며 낯선 대화상자가 없다."""
        ...

    def collect(self) -> None:
        """상태 콤보를 (정상전체) 로 두고 수집하기(F5)."""
        ...

    def wait_collected(self, timeout_s: float) -> None:
        """수집이 끝날 때까지 기다린다. 넘기면 AdapterRetry(TIMEOUT)."""
        ...

    def set_filters(self) -> None:
        """작업상태 = 미지정, 엑셀생성여부 = 엑셀생성안됨."""
        ...

    def row_count(self) -> int:
        """지금 필터에 걸린 행 수."""
        ...

    def select_all(self) -> int:
        """헤더 전체 선택을 켜고, 선택된 행 수를 돌려준다."""
        ...

    def set_status_done(self) -> None:
        """작업상태지정 → 완료됨(우리 조작이 띄운 확인 대화상자는 누른다)."""
        ...


class ShopMineAdapter:
    """BatchAdapter 구현. complete_pending 한 번이 필터에 걸린 주문 전부를 처리한다."""

    def __init__(
        self,
        ui: ShopMineUi,
        *,
        collect_timeout_s: float = 120.0,
        dry_run: bool = False,
    ) -> None:
        self._ui = ui
        self._collect_timeout_s = collect_timeout_s
        # 실기 시험용 — 전체 선택까지만 하고 완료됨은 누르지 않는다
        self._dry_run = dry_run

    def complete_pending(self) -> int:
        ui = self._ui
        ui.ensure_ready()
        ui.collect()
        ui.wait_collected(self._collect_timeout_s)
        ui.set_filters()
        rows = ui.row_count()
        if rows == 0:
            return 0
        selected = ui.select_all()
        if selected != rows:
            # 일부만 선택된 채 완료됨을 누르면 어느 행이 바뀌었는지 알 수 없다 — 누르지 않는다
            raise AdapterReject(
                ExportFail.AMBIGUOUS,
                f'전체 선택 {selected}건 ≠ 필터 행 {rows}건 — 누르지 않았다',
            )
        if self._dry_run:
            return rows
        ui.set_status_done()
        # 되읽기 — 같은 필터에 아무것도 남지 않아야 한다
        ui.set_filters()
        left = ui.row_count()
        if left != 0:
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH,
                f'완료됨 지정 뒤에도 필터에 {left}건 남음(처리 대상 {rows}건)',
            )
        return rows
