"""샵마인 화면 드라이버 — pywinauto(UIA). ShopMineUi 규약을 실제 창에 대고 수행한다.

컨트롤은 automation id·이름·항목 목록으로 찾는다. 좌표는 쓰지 않는다.
못 하는 상황(창 없음·최소화·수집 시간 초과·낯선 대화상자)은 AdapterRetry 로 던진다.
"""

import functools
import logging
import time
from collections.abc import Sequence

from pywinauto import Desktop
from pywinauto.findwindows import ElementNotFoundError
from pywinauto.timings import TimeoutError as PwTimeoutError
from pywinauto.uia_defines import NoPatternInterfaceError

from samba_agent.export.adapters import AdapterRetry
from samba_agent.export.desktop.shopmine import order_matches
from samba_agent.export.failures import ExportFail

log = logging.getLogger(__name__)

WINDOW_TITLE_MARK = 'ShopMine::'
ORDER_TAB = '통합주문관리'
NORMAL_ALL = '(정상전체)'
FILTER_STATUS = '미지정'
FILTER_EXCEL = '엑셀생성안됨'
STATUS_MENU = '작업상태지정'
STATUS_DONE = '완료됨'
ORDER_NO_COLUMN = '주문번호'
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
        started = time.monotonic()
        try:
            return fn(self, *args, **kwargs)
        except AdapterRetry:
            raise
        except (ElementNotFoundError, PwTimeoutError, NoPatternInterfaceError) as e:
            raise AdapterRetry(ExportFail.BLOCKED, f'{fn.__name__}: {e}') from e
        finally:
            # 단계별 소요 — 실기에서 어느 단계가 느린지 본다
            log.info('샵마인 %s %.1f초', fn.__name__, time.monotonic() - started)

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
        """ShopMine 메인 창(메뉴 막대가 있는 창). 없으면 AdapterRetry(WINDOW_MISSING).

        래퍼(UIAWrapper)를 그대로 쓴다 — WindowSpecification 은 접근할 때마다 창을 다시 찾아
        느리고 COM 오류("가입자를 불러낼 수 없습니다")가 났다(실기 2026-09-28).
        """
        for w in Desktop(backend='uia').windows():
            title = w.window_text() or ''
            if not title.startswith(WINDOW_TITLE_MARK):
                continue
            # 최소화된 창은 자식 요소를 돌려주지 않는다(실기 2026-09-28) — 먼저 복원한다
            if w.is_minimized():
                w.restore()
                time.sleep(self._poll_s)
            if w.descendants(control_type='MenuBar'):
                return w
        raise AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창이 없다')

    def _open_order_tab(self) -> None:
        """통합주문관리 탭이 안 열려 있으면(재시작 직후) 메뉴 주문관리(O) → 통합주문관리(I) 로 연다."""
        if self._win.descendants(control_type='TabItem', title=ORDER_TAB):
            return
        menubar = next(
            (m for m in self._win.descendants(control_type='MenuBar') if m.rectangle().width() > 0),
            None,
        )
        if menubar is None:
            raise AdapterRetry(ExportFail.BLOCKED, '샵마인 메뉴 막대를 찾지 못했다')
        top = next(
            (m for m in menubar.children(control_type='MenuItem') if '주문관리' in m.window_text()),
            None,
        )
        if top is None:
            raise AdapterRetry(ExportFail.BLOCKED, '샵마인 메뉴에 주문관리 가 없다')
        top.click_input()
        time.sleep(self._poll_s)
        item = next(
            (
                m
                for m in self._win.descendants(control_type='MenuItem')
                if m.window_text().startswith(ORDER_TAB) and m.rectangle().width() > 0
            ),
            None,
        )
        if item is None:
            self._win.type_keys('{ESC}')
            raise AdapterRetry(
                ExportFail.BLOCKED, '주문관리 메뉴에서 통합주문관리 항목을 찾지 못했다'
            )
        item.click_input()
        time.sleep(self._poll_s * 4)
        if not self._win.descendants(control_type='TabItem', title=ORDER_TAB):
            raise AdapterRetry(ExportFail.BLOCKED, '통합주문관리 탭을 열지 못했다')

    def _find(self, control_type: str, *, auto_id: str | None = None, title: str | None = None):
        """메인 창 안에서 지금 화면에 보이는 요소 하나.

        child_window 는 창의 모든 요소(주문 500행 × 칸 = 1만 개 이상)를 파이썬으로 훑어 수십 초가
        걸리고, 다른 탭 화면(신규주문·취소주문…)이 같은 automation id 로 숨어 있어 여러 개가
        잡힌다(실기 2026-09-28). UIA 조건 검색(descendants 에 조건)은 네이티브라 빠르고, 그중
        창 사각형 안에 있는 것이 지금 보이는 탭의 요소다.
        """
        # UIA 조건은 control_type·title 만 받는다(automation id 조건은 없다) — id 는 파이썬에서 거른다
        criteria: dict[str, str] = {'control_type': control_type}
        if title is not None:
            criteria['title'] = title
        area = self._win.rectangle()
        for el in self._win.descendants(**criteria):
            try:
                if auto_id is not None and el.element_info.automation_id != auto_id:
                    continue
                r = el.rectangle()
            except Exception:  # noqa: BLE001, S112 — 사라진 요소는 건너뛴다
                continue
            if r.width() <= 0 or r.height() <= 0:
                continue
            if r.left < area.left or r.top < area.top or r.right > area.right + 1:
                continue
            return el
        what = auto_id or title or control_type
        raise AdapterRetry(ExportFail.BLOCKED, f'샵마인 화면에서 {what!r} 요소를 찾지 못했다')

    @_guard_pywinauto_errors
    def ensure_ready(self) -> None:
        t0 = time.monotonic()
        win = self._window()
        log.info('샵마인 창 찾기 %.1f초', time.monotonic() - t0)
        self._refuse_if_dialog(win)
        self._win = win
        t1 = time.monotonic()
        self._open_order_tab()
        log.info('샵마인 탭 확인 %.1f초', time.monotonic() - t1)
        tab = self._find('TabItem', title=ORDER_TAB)
        # select() 가 예외 없이 조용히 실패한다(실기: 홈 탭 그대로) — 선택 여부를 확인하고 클릭한다
        try:
            tab.select()
        except Exception:  # noqa: BLE001, S110 — 일부 탭은 select 패턴이 없다
            pass
        time.sleep(self._poll_s)
        if not self._order_page_shown():
            tab.click_input()
            time.sleep(self._poll_s * 2)
        if not self._order_page_shown():
            raise AdapterRetry(ExportFail.BLOCKED, '통합주문관리 탭으로 전환하지 못했다')

    def _order_page_shown(self) -> bool:
        """통합주문관리 페이지가 앞에 있는가 — TabItem.is_selected() 는 항상 0 이라(실기) 페이지 제목표로 본다.

        숨은 탭 페이지의 요소는 창 밖 좌표(예: x=691)를 돌려주므로 _find 의 창 안 필터로 걸러진다.
        """
        try:
            self._find('Text', auto_id='LabelTitle', title=ORDER_TAB)
        except AdapterRetry:
            return False
        return True

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

    # ---- 콤보 상자 ----
    def _select_combo(self, combo, item: str) -> None:
        """WinForms 콤보 상자에서 항목을 고른다.

        pywinauto 의 select() 는 펼치기 패턴이나 'Open' 버튼을 찾는데, 이 프로그램 콤보는 둘 다
        없고 '열기' 버튼뿐이다(실기 2026-09-28). 이미 그 값이면 손대지 않는다.
        """
        if (combo.selected_text() or '').strip() == item:
            return
        opened = False
        for b in combo.children(control_type='Button'):
            if b.window_text() in ('열기', 'Open'):
                b.click_input()
                opened = True
                break
        if not opened:
            combo.click_input()
        time.sleep(self._poll_s)
        # 펼쳐진 목록은 콤보 안의 List 로 잡힌다. 아니면 바탕화면의 팝업 목록에서 찾는다
        candidates = []
        for lst in combo.children(control_type='List'):
            candidates.extend(lst.children(control_type='ListItem'))
        if not candidates:
            for w in Desktop(backend='uia').windows():
                if w.process_id() == self._win.process_id() and w.handle != self._win.handle:
                    candidates.extend(w.descendants(control_type='ListItem', title=item))
        target = next((c for c in candidates if c.window_text() == item), None)
        if target is None:
            combo.type_keys('{ESC}')
            raise AdapterRetry(ExportFail.BLOCKED, f'콤보 상자 목록에 {item!r} 이 없다')
        target.click_input()
        time.sleep(self._poll_s)
        if (combo.selected_text() or '').strip() != item:
            raise AdapterRetry(
                ExportFail.BLOCKED,
                f'콤보 상자를 {item!r} 로 바꾸지 못했다({combo.selected_text()!r})',
            )

    # ---- 수집 ----
    @_guard_pywinauto_errors
    def collect(self) -> None:
        self._select_combo(self._find('ComboBox', auto_id='ComboBoxProcessStatus'), NORMAL_ALL)
        time.sleep(self._poll_s)
        self._find('Button', auto_id='ButtonSearch').click_input()

    @_guard_pywinauto_errors
    def wait_collected(self, timeout_s: float) -> None:
        """수집 안내 패널이 사라지고 수집 버튼이 다시 눌리게 될 때까지 기다린다."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                busy = any(
                    p.is_visible() and p.rectangle().width() > 0
                    for p in self._win.descendants(control_type='Pane')
                    if p.element_info.automation_id == 'PanelLoading'
                )
                if not busy and self._find('Button', auto_id='ButtonSearch').is_enabled():
                    return
            except (ElementNotFoundError, AdapterRetry):
                pass
            time.sleep(self._poll_s)
        raise AdapterRetry(ExportFail.TIMEOUT, f'수집이 {timeout_s:g}초 안에 끝나지 않았다')

    # ---- 필터 ----
    def _filter_combo(self, item: str):
        """주문필터 툴바에서 그 항목을 가진 콤보 상자(id 가 숫자라 항목 목록으로 찾는다)."""
        toolbar = self._find('ToolBar', auto_id='ToolStripOrderFilter')
        for combo in toolbar.children(control_type='ComboBox'):
            try:
                if item in combo.texts():
                    return combo
            except Exception:  # noqa: BLE001, S112 — 열리지 않은 콤보는 목록을 못 줄 수 있다
                continue
        raise AdapterRetry(ExportFail.BLOCKED, f'주문필터에 {item!r} 항목을 가진 콤보 상자가 없다')

    @_guard_pywinauto_errors
    def set_filters(self) -> None:
        self._select_combo(self._filter_combo(FILTER_STATUS), FILTER_STATUS)
        self._select_combo(self._filter_combo(FILTER_EXCEL), FILTER_EXCEL)
        time.sleep(self._poll_s)

    # ---- 그리드 ----
    def _grid(self):
        return self._find('Table', auto_id='DataGridView1')

    def _grid_rows(self, grid=None) -> list:
        """데이터 행(헤더 행 '상위 행' 제외). 실기: 행은 Custom, 첫 행이 헤더다."""
        grid = grid if grid is not None else self._grid()
        rows = []
        for c in grid.children():
            if c.element_info.control_type not in ('DataItem', 'Custom'):
                continue
            cells = c.children()
            if cells and cells[0].element_info.control_type == 'Header':
                continue
            rows.append(c)
        return rows

    def _column_index(self, grid, name: str) -> int:
        """헤더 행에서 열 이름의 위치."""
        for c in grid.children():
            if c.element_info.control_type not in ('DataItem', 'Custom'):
                continue
            cells = c.children()
            if cells and cells[0].element_info.control_type == 'Header':
                for i, h in enumerate(cells):
                    if h.window_text() == name:
                        return i
                break
        raise AdapterRetry(ExportFail.BLOCKED, f'그리드에 {name!r} 열이 없다')

    def _cell_value(self, cell) -> str:
        """셀 값 — window_text 는 '주문번호 행 0' 같은 이름표라 legacy Value 를 먼저 본다(실기)."""
        try:
            value = cell.legacy_properties().get('Value')
        except Exception:  # noqa: BLE001
            value = None
        if value is None:
            try:
                value = cell.window_text()
            except Exception:  # noqa: BLE001
                value = ''
        return str(value or '').strip()

    def _cell_checked(self, cell) -> bool | None:
        """그 셀(행의 첫째 칸 = 체크박스 칸)이 체크됐는지. 읽을 방법이 없으면 None."""
        try:
            return cell.iface_toggle.CurrentToggleState == 1
        except Exception:  # noqa: BLE001, S110 — TogglePattern 이 없는 칸도 있다
            pass
        value = self._cell_value(cell)
        if not value:
            return None
        return value.lower() in _CHECKED_MARKERS

    @_guard_pywinauto_errors
    def filtered_order_nos(self) -> list[str]:
        grid = self._grid()
        col = self._column_index(grid, ORDER_NO_COLUMN)
        out = []
        for row in self._grid_rows(grid):
            cells = row.children()
            out.append(self._cell_value(cells[col]) if col < len(cells) else '')
        return out

    def _uncheck_all(self) -> None:
        """헤더 전체 선택을 끈다 — 이전 실행이 켜 둔 체크가 남아 있을 수 있다."""
        box = self._find('CheckBox', auto_id='CheckBoxAll')
        if box.get_toggle_state() == 1:
            box.toggle()
            time.sleep(self._poll_s)
        for row in self._grid_rows():
            cells = row.children()
            if cells and self._cell_checked(cells[0]):
                cells[0].click_input()
                time.sleep(self._poll_s / 2)

    @_guard_pywinauto_errors
    def select_orders(self, order_nos: Sequence[str]) -> dict[str, int]:
        """목록의 주문번호와 맞는 행만 체크한다(첫째 칸 클릭 → 체크 확인)."""
        self._uncheck_all()
        grid = self._grid()
        col = self._column_index(grid, ORDER_NO_COLUMN)
        checked: dict[str, int] = dict.fromkeys(order_nos, 0)
        for row in self._grid_rows(grid):
            cells = row.children()
            if col >= len(cells):
                continue
            value = self._cell_value(cells[col])
            hit = next((o for o in order_nos if order_matches(o, value)), None)
            if hit is None:
                continue
            for _ in range(2):
                if self._cell_checked(cells[0]):
                    break
                cells[0].click_input()
                time.sleep(self._poll_s)
            if self._cell_checked(cells[0]):
                checked[hit] += 1
        return checked

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
        toolbar = self._find('ToolBar', auto_id='ToolStripSub')
        before_submenu = self._same_pid_handles(pid, exclude_handle=win.handle)
        menu = next(
            (
                m
                for m in toolbar.children(control_type='MenuItem')
                if m.window_text() == STATUS_MENU
            ),
            None,
        )
        if menu is None:
            raise AdapterRetry(ExportFail.BLOCKED, f'{STATUS_MENU!r} 메뉴를 찾지 못했다')
        menu.click_input()
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
                    buttons = w.descendants(control_type='Button', title=name)
                    if not buttons:
                        continue
                    buttons[0].click_input()
                    log.info('샵마인 확인 대화상자 %r(%r) 에서 %r 을 눌렀다', title, text, name)
                    time.sleep(self._poll_s)
                    return
            time.sleep(self._poll_s)
