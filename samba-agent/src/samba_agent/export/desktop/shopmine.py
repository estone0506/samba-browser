"""샵마인 어댑터 — 통합주문관리의 '미지정 · 엑셀생성안됨' 주문 중 하네스가 이행한 주문을 '완료됨'으로(스펙 §6.1).

절차만 있다. 화면을 실제로 만지는 일은 ShopMineUi 드라이버(shopmine_ui.py, pywinauto)가 한다 —
그래서 절차는 가짜 드라이버로 시험하고, 드라이버는 실기로 시험한다.
"""

from collections.abc import Mapping, Sequence
from typing import Protocol

from samba_agent.export.adapters import AdapterReject
from samba_agent.export.failures import ExportFail


def order_matches(order_no: str, cell: str) -> bool:
    """하네스 주문번호와 샵마인 주문번호 칸이 같은 주문인가.

    실기 2026-09-28: SSG 는 하네스 `20260928B68241:1136399342` ↔ 샵마인 `20260928B68241`(`:` 앞),
    GS이숍은 하네스가 두 토큰 `3474596476 2904713019`. 그 밖은 정확히 같아야 한다.
    """
    o = (order_no or '').strip()
    c = (cell or '').strip()
    if not o or not c:
        return False
    if o == c or o.split(':', 1)[0] == c:
        return True
    return c in o.split()


class ShopMineUi(Protocol):
    """샵마인 통합주문관리 화면 조작. 못 하는 상황은 AdapterRetry 로 던진다."""

    def ensure_ready(self) -> None:
        """창이 있고 통합주문관리 탭이 앞에 있으며 낯선 대화상자가 없다."""
        ...

    def set_period(self) -> None:
        """검색 기간에 오늘이 들어가게 한다(이미 들어 있으면 그대로)."""
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

    def filtered_order_nos(self) -> list[str]:
        """지금 필터에 걸린 행들을 알아보는 값들 — 주문번호, 쿠팡은 배송번호도(헤더 제외)."""
        ...

    def select_orders(self, order_nos: Sequence[str]) -> Mapping[str, int]:
        """전체 선택을 풀고, 목록의 주문번호와 맞는 행만 체크한다. 주문번호 → 체크한 행 수."""
        ...

    def set_status_done(self, expected_rows: int) -> None:
        """작업상태지정 → 완료됨. 확인 대화상자의 '선택한 N개' 가 expected_rows 와 같을 때만 누른다."""
        ...


class ShopMineAdapter:
    """BatchAdapter 구현. complete_pending 한 번이 넘겨받은 주문 중 화면에 있는 것을 처리한다."""

    def __init__(
        self,
        ui: ShopMineUi,
        *,
        collect_timeout_s: float = 300.0,
        dry_run: bool = False,
    ) -> None:
        self._ui = ui
        self._collect_timeout_s = collect_timeout_s
        # 실기 시험용 — 행 체크까지만 하고 완료됨은 누르지 않는다
        self._dry_run = dry_run

    def complete_pending(self, order_nos: Sequence[str]) -> set[str]:
        ui = self._ui
        wanted = [o for o in dict.fromkeys(order_nos) if o]
        if not wanted:
            return set()
        ui.ensure_ready()
        # 조건이 먼저다 — 오늘이 빠진 기간으로 수집하면 오늘 주문이 목록에 없다
        ui.set_period()
        ui.collect()
        ui.wait_collected(self._collect_timeout_s)
        ui.set_filters()
        present = ui.filtered_order_nos()
        found = [o for o in wanted if any(order_matches(o, c) for c in present)]
        if not found:
            return set()
        checked = ui.select_orders(found)
        missing = [o for o in found if not checked.get(o)]
        if missing:
            # 찾았는데 체크가 안 된 행이 있다 — 일부만 완료됨으로 바꾸면 무엇이 바뀌었는지 알 수 없다
            raise AdapterReject(
                ExportFail.AMBIGUOUS, f'{len(missing)}건은 행을 체크하지 못했다 — 누르지 않았다'
            )
        if self._dry_run:
            return set(found)
        ui.set_status_done(sum(checked.get(o, 0) for o in found))
        # 되읽기 — 처리한 주문은 같은 필터에 남아 있으면 안 된다
        ui.set_filters()
        after = ui.filtered_order_nos()
        left = [o for o in found if any(order_matches(o, c) for c in after)]
        if left:
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH,
                f'완료됨 지정 뒤에도 {len(left)}건이 필터에 남음(처리 대상 {len(found)}건)',
            )
        return set(found)
