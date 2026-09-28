"""샵마인 화면 드라이버 — pywinauto(UIA). ShopMineUi 규약을 실제 창에 대고 수행한다.

컨트롤은 automation id·이름·항목 목록으로 찾는다. 좌표는 쓰지 않는다.
못 하는 상황(창 없음·최소화·수집 시간 초과·낯선 대화상자)은 AdapterRetry 로 던진다.
"""

import functools
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
# 행별 선택 상태 셀 값이 '체크됨'으로 보이는 표시들(텍스트로만 읽을 수 있을 때)
_CHECKED_MARKERS = ('true', '1', '선택', '체크', 'checked')


def _new_windows(before: set[int], windows: list) -> list:
    """`before` 스냅숏(핸들 집합)에 없던 창만 남긴다 — 우리가 방금 띄운 창을 고르는 데 쓴다.

    순수 함수(pywinauto 를 부르지 않는다) — `windows` 는 `.handle` 속성만 있으면 된다.
    """
    return [w for w in windows if w.handle not in before]


def _guard_pywinauto_errors(fn):
    """pywinauto 가 던지는 '요소 없음·시간 초과' 를 AdapterRetry(BLOCKED) 로 감싼다.

    ShopMineUi 규약은 AdapterRetry/AdapterReject 만 밖으로 나가야 한다 — 원본 예외가
    그대로 새어 나가면 어댑터·CLI 가 처리하지 못하고 트레이스백으로 죽는다.
    """

    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        try:
            return fn(self, *args, **kwargs)
        except AdapterRetry:
            raise
        except (ElementNotFoundError, PwTimeoutError) as e:
            raise AdapterRetry(ExportFail.BLOCKED, f'{fn.__name__}: {e}') from e

    return wrapper


class PywinautoShopMineUi:
    """ShopMineUi 구현."""

    def __init__(self, *, poll_s: float = 0.5) -> None:
        self._poll_s = poll_s
        self._win = None

    # ---- 창 열거 공통 ----
    def _same_pid_windows(self, pid: int, exclude_handle: int | None = None) -> list:
        """같은 프로세스의 다른 최상위 창들(대화상자·팝업 후보)."""
        return [
            w
            for w in Desktop(backend='uia').windows()
            if w.process_id() == pid and w.handle != exclude_handle
        ]

    def _same_pid_handles(self, pid: int, exclude_handle: int | None = None) -> set[int]:
        return {w.handle for w in self._same_pid_windows(pid, exclude_handle)}

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

    @_guard_pywinauto_errors
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
        """메인 창이 모달 대화상자에 막혀 있으면 건드리지 않고 물러난다.

        같은 프로세스에 CS메모관리 등 다른 업무 창이 함께 떠 있는 것은 정상이다 — 그것만으로는
        막힌 게 아니다. 메인 창 자체가 비활성(모달에 막힘)일 때만 대화상자로 본다.
        """
        if win.is_enabled():
            return
        pid = win.process_id()
        title = '(제목 없음)'
        for w in self._same_pid_windows(pid, exclude_handle=win.handle):
            if w.is_enabled():
                title = w.window_text() or '(제목 없음)'
                break
        raise AdapterRetry(ExportFail.BLOCKED, f'샵마인에 대화상자가 떠 있다: {title!r}')

    # ---- 수집 ----
    @_guard_pywinauto_errors
    def collect(self) -> None:
        win = self._win
        win.child_window(auto_id='ComboBoxProcessStatus', control_type='ComboBox').select(
            NORMAL_ALL
        )
        win.child_window(auto_id='ButtonSearch', control_type='Button').click_input()

    @_guard_pywinauto_errors
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

    @_guard_pywinauto_errors
    def set_filters(self) -> None:
        self._filter_combo(FILTER_STATUS).select(FILTER_STATUS)
        self._filter_combo(FILTER_EXCEL).select(FILTER_EXCEL)
        time.sleep(self._poll_s)

    # ---- 그리드 ----
    def _grid(self):
        return self._win.child_window(auto_id='DataGridView1', control_type='Table')

    def _grid_rows(self) -> list:
        grid = self._grid()
        return [c for c in grid.children() if c.element_info.control_type in ('DataItem', 'Custom')]

    @_guard_pywinauto_errors
    def row_count(self) -> int:
        grid = self._grid()
        try:
            return int(grid.iface_grid.CurrentRowCount)
        except Exception:  # noqa: BLE001 — GridPattern 이 없으면 행 요소를 센다
            return len(self._grid_rows())

    def _cell_checked(self, cell) -> bool | None:
        """그 셀(행의 첫째 칸 = 체크박스 칸)이 체크됐는지. 읽을 방법이 없으면 None."""
        try:
            return cell.iface_toggle.CurrentToggleState == 1
        except Exception:  # noqa: BLE001, S110 — TogglePattern 이 없는 칸도 있다
            pass
        value = None
        try:
            value = cell.legacy_properties().get('Value')
        except Exception:  # noqa: BLE001, S110
            pass
        if not value:
            try:
                value = cell.window_text()
            except Exception:  # noqa: BLE001
                value = None
        if not value:
            return None
        return str(value).strip().lower() in _CHECKED_MARKERS

    def _count_checked_rows(self) -> int:
        """헤더 전체 선택을 믿지 않고, 행마다 첫째 칸의 체크 상태를 직접 센다."""
        any_checkable = False
        checked = 0
        for row in self._grid_rows():
            cells = row.children()
            if not cells:
                continue
            state = self._cell_checked(cells[0])
            if state is None:
                continue
            any_checkable = True
            if state:
                checked += 1
        if not any_checkable:
            log.warning('행별 선택 상태를 읽지 못해 헤더 체크 상태로 대신한다')
            return self.row_count()
        return checked

    @_guard_pywinauto_errors
    def select_all(self) -> int:
        box = self._win.child_window(auto_id='CheckBoxAll', control_type='CheckBox')
        if box.get_toggle_state() != 1:
            box.toggle()
            time.sleep(self._poll_s)
        if box.get_toggle_state() != 1:
            return 0
        return self._count_checked_rows()

    # ---- 완료됨 ----
    def _find_done_item(self, win, pid: int, before: set[int]):
        """완료됨 메뉴 항목 — 먼저 메인 창 안(하위 메뉴가 창 안에 펼쳐지는 경우)에서,

        없으면 메뉴를 연 뒤 새로 뜬 팝업 창(같은 프로세스의, 클릭 전 스냅숏에 없던 최상위 창)
        안에서 찾는다. 보이는(rectangle 너비 > 0) 첫 후보를 쓴다.
        """
        candidates = list(win.descendants(control_type='MenuItem', title=STATUS_DONE))
        for popup in _new_windows(before, self._same_pid_windows(pid, exclude_handle=win.handle)):
            candidates.extend(popup.descendants(control_type='MenuItem', title=STATUS_DONE))
        for item in candidates:
            try:
                if item.rectangle().width() > 0:
                    return item
            except Exception:  # noqa: BLE001, S112 — 이미 닫힌 메뉴 항목은 다음 후보로 넘어간다
                continue
        raise AdapterRetry(ExportFail.BLOCKED, '작업상태지정 메뉴에서 완료됨 항목을 찾지 못했다')

    @_guard_pywinauto_errors
    def set_status_done(self) -> None:
        win = self._win
        pid = win.process_id()
        toolbar = win.child_window(auto_id='ToolStripSub', control_type='ToolBar')
        before_submenu = self._same_pid_handles(pid, exclude_handle=win.handle)
        toolbar.child_window(control_type='MenuItem', title=STATUS_MENU).click_input()
        time.sleep(self._poll_s)
        done_item = self._find_done_item(win, pid, before_submenu)
        before_confirm = self._same_pid_handles(pid, exclude_handle=win.handle)
        done_item.click_input()
        self._confirm_own_dialog(win, pid, before_confirm)

    def _dialog_text(self, w) -> str:
        """대화상자 안내문(정적 텍스트) — 우리 대화상자라 그대로 로그에 남겨도 된다."""
        try:
            texts = [t.window_text() for t in w.descendants(control_type='Text')]
            return ' '.join(t for t in texts if t)[:80]
        except Exception:  # noqa: BLE001 — 로그용이라 못 읽어도 그냥 빈 문자열
            return ''

    def _confirm_own_dialog(self, win, pid: int, before: set[int], wait_s: float = 5.0) -> None:
        """우리가 방금 띄운 대화상자(클릭 전에는 없던 창)만 누른다. 없으면 그냥 지나간다."""
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            for w in _new_windows(before, self._same_pid_windows(pid, exclude_handle=win.handle)):
                title = (w.window_text() or '')[:40]
                text = self._dialog_text(w)
                for name in CONFIRM_BUTTONS:
                    try:
                        w.child_window(control_type='Button', title=name).click_input()
                        log.info('샵마인 확인 대화상자 %r(%r) 에서 %r 을 눌렀다', title, text, name)
                        time.sleep(self._poll_s)
                        return
                    except (ElementNotFoundError, PwTimeoutError):
                        continue
            time.sleep(self._poll_s)
