"""샵마인 화면 드라이버 — pywinauto(UIA). ShopMineUi 규약을 실제 창에 대고 수행한다.

컨트롤은 automation id·이름·항목 목록으로 찾는다. 좌표는 쓰지 않는다.
못 하는 상황(창 없음·최소화·수집 시간 초과·낯선 대화상자)은 AdapterRetry 로 던진다.
"""

import logging
import time

from pywinauto import Desktop
from pywinauto.findwindows import ElementNotFoundError
from pywinauto.timings import TimeoutError as PwTimeoutError

from samba_agent.export.adapters import AdapterRetry
from samba_agent.export.failures import ExportFail

log = logging.getLogger(__name__)

WINDOW_TITLE_MARK = 'ShopMine::'
ORDER_TAB = '통합주문관리'
NORMAL_ALL = '(정상전체)'
FILTER_STATUS = '미지정'
FILTER_EXCEL = '엑셀생성안됨'
STATUS_MENU = '작업상태지정'
STATUS_DONE = '완료됨'
# 우리가 완료됨을 누른 뒤 뜨는 확인 대화상자에서 눌러도 되는 버튼 이름
CONFIRM_BUTTONS = ('예(Y)', '확인', 'OK', 'Yes')


class PywinautoShopMineUi:
    """ShopMineUi 구현."""

    def __init__(self, *, poll_s: float = 0.5) -> None:
        self._poll_s = poll_s
        self._win = None

    # ---- 창·탭 ----
    def _window(self):
        """통합주문관리 탭이 있는 ShopMine 창. 없으면 AdapterRetry(WINDOW_MISSING)."""
        for w in Desktop(backend='uia').windows():
            title = w.window_text() or ''
            if not title.startswith(WINDOW_TITLE_MARK):
                continue
            if w.descendants(control_type='TabItem', title=ORDER_TAB):
                return w
        raise AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 통합주문관리 창이 없다')

    def ensure_ready(self) -> None:
        win = self._window()
        if win.is_minimized():
            win.restore()
            time.sleep(self._poll_s)
        self._refuse_if_dialog(win)
        tab = win.child_window(control_type='TabItem', title=ORDER_TAB)
        try:
            tab.select()
        except Exception:  # noqa: BLE001 — 일부 탭은 select 패턴이 없어 클릭으로 고른다
            tab.click_input()
        self._win = win

    def _refuse_if_dialog(self, win) -> None:
        """같은 프로세스의 다른 최상위 창(인증·오류 대화상자)이 있으면 건드리지 않고 물러난다."""
        pid = win.process_id()
        for w in Desktop(backend='uia').windows():
            if w.process_id() != pid or w.handle == win.handle:
                continue
            title = w.window_text() or ''
            # 다른 업무 창(CS메모관리 등)은 대화상자가 아니다 — 확인·취소 버튼만 있는 작은 창을 본다
            if w.rectangle().width() > 900:
                continue
            raise AdapterRetry(ExportFail.BLOCKED, f'샵마인에 대화상자가 떠 있다: {title[:40]!r}')

    # ---- 수집 ----
    def collect(self) -> None:
        win = self._win
        win.child_window(auto_id='ComboBoxProcessStatus', control_type='ComboBox').select(
            NORMAL_ALL
        )
        win.child_window(auto_id='ButtonSearch', control_type='Button').click_input()

    def wait_collected(self, timeout_s: float) -> None:
        """수집 안내 패널이 사라지고 수집 버튼이 다시 눌리게 될 때까지 기다린다."""
        win = self._win
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            loading = win.child_window(auto_id='PanelLoading', control_type='Pane')
            button = win.child_window(auto_id='ButtonSearch', control_type='Button')
            try:
                busy = loading.exists(timeout=0.1) and loading.is_visible()
                if not busy and button.is_enabled():
                    return
            except ElementNotFoundError:
                pass
            time.sleep(self._poll_s)
        raise AdapterRetry(ExportFail.TIMEOUT, f'수집이 {timeout_s:g}초 안에 끝나지 않았다')

    # ---- 필터 ----
    def _filter_combo(self, item: str):
        """주문필터 툴바에서 그 항목을 가진 콤보 상자(id 가 숫자라 항목 목록으로 찾는다)."""
        toolbar = self._win.child_window(auto_id='ToolStripOrderFilter', control_type='ToolBar')
        for combo in toolbar.children(control_type='ComboBox'):
            try:
                if item in combo.texts():
                    return combo
            except Exception:  # noqa: BLE001, S112 — 열리지 않은 콤보는 목록을 못 줄 수 있다
                continue
        raise AdapterRetry(ExportFail.BLOCKED, f'주문필터에 {item!r} 항목을 가진 콤보 상자가 없다')

    def set_filters(self) -> None:
        self._filter_combo(FILTER_STATUS).select(FILTER_STATUS)
        self._filter_combo(FILTER_EXCEL).select(FILTER_EXCEL)
        time.sleep(self._poll_s)

    # ---- 그리드 ----
    def _grid(self):
        return self._win.child_window(auto_id='DataGridView1', control_type='Table')

    def row_count(self) -> int:
        grid = self._grid()
        try:
            return int(grid.iface_grid.CurrentRowCount)
        except Exception:  # noqa: BLE001 — GridPattern 이 없으면 행 요소를 센다
            rows = [
                c for c in grid.children() if c.element_info.control_type in ('DataItem', 'Custom')
            ]
            return len(rows)

    def select_all(self) -> int:
        box = self._win.child_window(auto_id='CheckBoxAll', control_type='CheckBox')
        if box.get_toggle_state() != 1:
            box.toggle()
            time.sleep(self._poll_s)
        if box.get_toggle_state() != 1:
            return 0
        return self.row_count()

    # ---- 완료됨 ----
    def set_status_done(self) -> None:
        win = self._win
        toolbar = win.child_window(auto_id='ToolStripSub', control_type='ToolBar')
        toolbar.child_window(control_type='MenuItem', title=STATUS_MENU).click_input()
        time.sleep(self._poll_s)
        # 펼쳐진 메뉴는 창 밖 팝업일 수 있다 — 바탕화면 전체에서 찾는다
        Desktop(backend='uia').window(control_type='MenuItem', title=STATUS_DONE).click_input()
        self._confirm_own_dialog(win)

    def _confirm_own_dialog(self, win, wait_s: float = 5.0) -> None:
        """우리가 방금 띄운 확인 대화상자만 누른다. 없으면 그냥 지나간다."""
        pid = win.process_id()
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            for w in Desktop(backend='uia').windows():
                if w.process_id() != pid or w.handle == win.handle or w.rectangle().width() > 900:
                    continue
                for name in CONFIRM_BUTTONS:
                    try:
                        w.child_window(control_type='Button', title=name).click_input()
                        log.info(
                            '샵마인 확인 대화상자 %r 에서 %r 을 눌렀다', w.window_text()[:40], name
                        )
                        time.sleep(self._poll_s)
                        return
                    except (ElementNotFoundError, PwTimeoutError):
                        continue
            time.sleep(self._poll_s)
