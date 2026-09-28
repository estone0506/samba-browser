"""EMP(플레이오토) 주문관리 화면 드라이버 — pywinauto. 주문 그리드의 원가·배송비를 읽고 쓴다.

EMP 는 관리자 권한으로 돈다 — 이 드라이버도 관리자 권한 프로세스에서 불러야 한다(일반 권한
에서는 UIA 가 창을 못 보고 입력도 막힌다, 실기 2026-09-28).

화면 사실(실기 2026-09-28, EMP 1.1.0.458):
- 주문 그리드는 C1 FlexGrid(automation id `grid`). 행은 `Custom` 요소고 legacy Value 가 그 행의
  모든 열 값을 탭으로 이은 문자열이다(숨은 열 포함 82열). 첫 행(`Row 0`)이 열 이름이다.
- 셀 요소는 **화면에 보이는 열**만 있다. 원가 셀은 `wprice1 Row N`, 배송비 셀은 `deliv_price Row N`
  이고 둘 다 ValuePattern 으로 값을 넣을 수 있다(읽기 전용 아님).
- 컨트롤은 보이는 자식 창 핸들을 열거해 automation id 색인으로 찾는다(샵마인 드라이버와 같은 이유).
"""

import ctypes
import logging
import time
from ctypes import wintypes

from pywinauto import Desktop
from pywinauto.controls.uiawrapper import UIAWrapper
from pywinauto.uia_element_info import UIAElementInfo

from samba_agent.export.adapters import AdapterReject, AdapterRetry, CellValues
from samba_agent.export.desktop.emp import parse_won
from samba_agent.export.desktop.shopmine import order_matches
from samba_agent.export.failures import ExportFail

log = logging.getLogger(__name__)

WINDOW_TITLE_MARK = 'EMP 1.'
LOGIN_MARK = '로그인'
GRID_ID = 'grid'
COL_ORDER_NO = '주문번호'
COL_COST = '원가'
COL_SHIPPING = '배송비'
# 화면에 보이는 셀 요소의 이름 앞머리(열의 내부 이름)
CELL_COST = 'wprice1'
CELL_SHIPPING = 'deliv_price'
SAVE_BUTTON = '저장'
REFRESH_BUTTON = '새로고침'
TOOLBAR_ID = 'toolStrip2'
# 저장 뒤 안내창 문구('성공적으로 저장 되었습니다.')
SAVED_MARK = '저장 되었습니다'
# 새로고침 때 저장 안 된 편집이 있으면 뜨는 문구
UNSAVED_MARK = '저장하시겠습니까'
OK_BUTTONS = ('확인', 'OK')
NO_BUTTONS = ('아니요(N)', '아니오(N)', 'No')

_WM_SETTEXT, _WM_GETTEXT = 0x000C, 0x000D
_WM_KEYDOWN, _WM_KEYUP, _WM_CHAR = 0x0100, 0x0101, 0x0102
_WM_LBUTTONDOWN, _WM_LBUTTONUP, _WM_LBUTTONDBLCLK = 0x0201, 0x0202, 0x0203
_BM_CLICK = 0x00F5
_VK_RETURN, _VK_ESCAPE = 0x0D, 0x1B

_user32 = ctypes.windll.user32
_ENUM_PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class _GuiThreadInfo(ctypes.Structure):
    _fields_ = [
        ('cbSize', wintypes.DWORD),
        ('flags', wintypes.DWORD),
        ('hwndActive', wintypes.HWND),
        ('hwndFocus', wintypes.HWND),
        ('hwndCapture', wintypes.HWND),
        ('hwndMenuOwner', wintypes.HWND),
        ('hwndMoveSize', wintypes.HWND),
        ('hwndCaret', wintypes.HWND),
        ('rcCaret', wintypes.RECT),
    ]


def _visible_children(hwnd: int) -> list[int]:
    found: list[int] = []

    def collect(child, _lparam):
        if _user32.IsWindowVisible(child):
            found.append(child)
        return True

    _user32.EnumChildWindows(hwnd, _ENUM_PROC(collect), 0)
    return found


class GridRow:
    """그리드 한 행 — 요소와 열 이름 → 값."""

    def __init__(self, element, number: int, values: dict[str, str]) -> None:
        self.element = element
        # 셀 이름의 'Row N' 에 쓰이는 번호(헤더가 0)
        self.number = number
        self.values = values


class PywinautoEmpUi:
    """EMP 주문 그리드 읽기·쓰기."""

    def __init__(self, *, poll_s: float = 0.5) -> None:
        self._poll_s = poll_s
        self._main = None
        self._index: dict[str, UIAElementInfo] = {}

    # ---- 창·색인 ----
    def _find_main(self):
        for w in Desktop(backend='win32').windows():
            title = w.window_text() or ''
            if WINDOW_TITLE_MARK in title and LOGIN_MARK not in title:
                return w
        raise AdapterRetry(ExportFail.WINDOW_MISSING, 'EMP 창이 없다')

    def _refresh(self) -> None:
        index: dict[str, UIAElementInfo] = {}
        for hwnd in _visible_children(self._main.handle):
            try:
                info = UIAElementInfo(hwnd)
                auto_id = info.automation_id
            except Exception:  # noqa: BLE001, S112 — 열거 사이에 사라진 창은 건너뛴다
                continue
            if auto_id and auto_id not in index:
                index[auto_id] = info
        self._index = index

    def _el(self, auto_id: str) -> UIAWrapper:
        if auto_id not in self._index:
            self._refresh()
        info = self._index.get(auto_id)
        if info is None:
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP 화면에서 {auto_id!r} 요소를 찾지 못했다')
        return UIAWrapper(info)

    def ensure_ready(self) -> None:
        """창이 있고 최소화가 풀려 있으며 모달 대화상자에 막히지 않았다."""
        self._main = self._find_main()
        if self._main.is_minimized():
            self._main.restore()
            time.sleep(self._poll_s * 2)
        if not self._main.is_enabled():
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 에 대화상자가 떠 있다')
        self._refresh()
        if GRID_ID not in self._index:
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 주문관리 그리드가 화면에 없다')

    # ---- 그리드 ----
    def rows(self) -> list[GridRow]:
        """지금 그리드에 보이는 데이터 행들."""
        elements = [
            c for c in self._el(GRID_ID).children() if c.element_info.control_type == 'Custom'
        ]
        if not elements:
            return []
        header = (elements[0].legacy_properties().get('Value') or '').split('\t')
        out: list[GridRow] = []
        for number, el in enumerate(elements[1:], start=1):
            cells = (el.legacy_properties().get('Value') or '').split('\t')
            values = {name: cells[i] for i, name in enumerate(header) if name and i < len(cells)}
            out.append(GridRow(el, number, values))
        return out

    def find_row(self, order_no: str) -> GridRow:
        """주문번호가 맞는 행 하나. 없으면 거절(NOT_FOUND), 여러 개면 거절(AMBIGUOUS)."""
        hits = [r for r in self.rows() if order_matches(order_no, r.values.get(COL_ORDER_NO, ''))]
        if not hits:
            raise AdapterReject(ExportFail.NOT_FOUND, 'EMP 그리드에 그 주문번호가 없다')
        if len(hits) > 1:
            raise AdapterReject(
                ExportFail.AMBIGUOUS, f'EMP 그리드에 그 주문번호 행이 {len(hits)}개다'
            )
        return hits[0]

    def read(self, order_no: str) -> CellValues:
        row = self.find_row(order_no)
        return CellValues(
            parse_won(row.values.get(COL_COST)), parse_won(row.values.get(COL_SHIPPING))
        )

    def _cell(self, row: GridRow, prefix: str):
        """행의 보이는 셀 중 이름이 '<prefix> Row N' 인 것."""
        want = f'{prefix} Row {row.number}'
        for cell in row.element.children():
            if (cell.element_info.name or '') == want:
                return cell
        raise AdapterRetry(ExportFail.BLOCKED, f'EMP 그리드에 {prefix!r} 열이 화면에 보이지 않는다')

    # ---- 쓰기 ----
    def _focus(self) -> tuple[int, str]:
        """EMP 화면 스레드에서 키보드 포커스를 가진 창과 그 창 종류."""
        info = _GuiThreadInfo()
        info.cbSize = ctypes.sizeof(_GuiThreadInfo)
        thread = _user32.GetWindowThreadProcessId(self._main.handle, None)
        _user32.GetGUIThreadInfo(thread, ctypes.byref(info))
        hwnd = info.hwndFocus or 0
        name = ctypes.create_unicode_buffer(256)
        if hwnd:
            _user32.GetClassNameW(hwnd, name, 256)
        return hwnd, name.value

    def _window_text(self, hwnd: int) -> str:
        buf = ctypes.create_unicode_buffer(128)
        _user32.SendMessageW(hwnd, _WM_GETTEXT, 128, buf)
        return buf.value

    def _wait_focus(self, want_edit: bool, timeout_s: float = 3.0) -> int:
        """포커스가 편집 상자로 가거나(want_edit) 그리드로 돌아올 때까지 기다린다."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            hwnd, cls = self._focus()
            if hwnd and ('EDIT' in cls.upper()) == want_edit:
                return hwnd
            time.sleep(0.1)
        what = '편집 상자가 열리지' if want_edit else '편집이 끝나지'
        raise AdapterRetry(ExportFail.TIMEOUT, f'EMP 칸 {what} 않았다')

    def _edit_cell(self, order_no: str, prefix: str, column: str, value: int) -> None:
        """그리드 칸 하나에 값을 넣는다(저장 전).

        실제 마우스·전역 키 입력은 쓰지 않는다 — 다른 창이 앞에 있으면 글자가 그 창으로 샌다
        (실기 2026-09-28: 채팅창에 입력됨). 그리드 창 핸들에 메시지를 직접 보낸다:
        칸 더블클릭 → 숫자 한 글자(편집 상자가 열린다) → 편집 상자에 값을 통째로 넣고 되읽기 →
        Enter → 행 값 확인. 글자를 하나씩 보내면 기존 값과 섞인다(실기: 57131 → 507131).
        """
        row = self.find_row(order_no)
        cell = self._cell(row, prefix)
        grid = self._el(GRID_ID).element_info.handle
        rect = cell.rectangle()
        area = self._el(GRID_ID).rectangle()
        if not (area.left <= rect.left and rect.right <= area.right and area.top < rect.top):
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP 그리드에서 {column} 칸이 화면 밖이다')
        if rect.bottom > area.bottom:
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 그리드에서 그 주문 행이 화면 밖이다')
        point = wintypes.POINT((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
        _user32.ScreenToClient(grid, ctypes.byref(point))
        lparam = (point.y << 16) | (point.x & 0xFFFF)
        for message, wparam in (
            (_WM_LBUTTONDOWN, 1),
            (_WM_LBUTTONUP, 0),
            (_WM_LBUTTONDBLCLK, 1),
            (_WM_LBUTTONUP, 0),
        ):
            _user32.PostMessageW(grid, message, wparam, lparam)
            time.sleep(0.05)
        time.sleep(self._poll_s)
        hwnd, cls = self._focus()
        if hwnd != grid:
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP 그리드가 포커스를 받지 못했다({cls})')
        text = str(value)
        _user32.PostMessageW(grid, _WM_CHAR, ord(text[0]), 0)
        editor = self._wait_focus(want_edit=True)
        _user32.SendMessageW(editor, _WM_SETTEXT, 0, ctypes.c_wchar_p(text))
        if self._window_text(editor) != text:
            _user32.PostMessageW(editor, _WM_KEYDOWN, _VK_ESCAPE, 0)
            _user32.PostMessageW(editor, _WM_KEYUP, _VK_ESCAPE, 0)
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH, f'EMP 편집 상자에 {column} 값이 들어가지 않았다'
            )
        _user32.PostMessageW(editor, _WM_KEYDOWN, _VK_RETURN, 0)
        _user32.PostMessageW(editor, _WM_KEYUP, _VK_RETURN, 0)
        self._wait_focus(want_edit=False)
        time.sleep(self._poll_s)
        got = parse_won(self.find_row(order_no).values.get(column))
        if got != value:
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH,
                f'EMP {column} 칸에 {value:,} 을 넣었는데 {got} 로 읽힌다',
            )

    def _toolbar_button(self, name: str):
        for item in self._el(TOOLBAR_ID).children():
            if item.element_info.name == name:
                return item
        raise AdapterRetry(ExportFail.BLOCKED, f'EMP 툴바에 {name!r} 버튼이 없다')

    def _press_toolbar(self, name: str) -> None:
        """툴바 버튼을 누른다 — 툴바 창에 클릭 메시지를 보낸다(UIA invoke 는 대화상자가 뜨면 막힌다)."""
        button = self._toolbar_button(name)
        if not button.is_enabled():
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP {name!r} 버튼이 꺼져 있다')
        toolbar = self._el(TOOLBAR_ID).element_info.handle
        rect = button.rectangle()
        point = wintypes.POINT((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
        _user32.ScreenToClient(toolbar, ctypes.byref(point))
        lparam = (point.y << 16) | (point.x & 0xFFFF)
        _user32.PostMessageW(toolbar, _WM_LBUTTONDOWN, 1, lparam)
        time.sleep(0.05)
        _user32.PostMessageW(toolbar, _WM_LBUTTONUP, 0, lparam)

    def dialogs(self) -> list[tuple[int, str, str, list]]:
        """EMP 가 띄운 보이는 대화상자들 — (핸들, 제목, 문구, 버튼 요소들)."""
        found = []
        pid = self._main.process_id()
        for w in Desktop(backend='win32').windows():
            try:
                if w.process_id() != pid or not w.is_visible() or w.class_name() != '#32770':
                    continue
                dialog = UIAWrapper(UIAElementInfo(w.handle))
                message = ' '.join(t.window_text() for t in dialog.descendants(control_type='Text'))
                buttons = dialog.descendants(control_type='Button')
            except Exception:  # noqa: BLE001, S112 — 이미 닫힌 창
                continue
            found.append((w.handle, w.window_text() or '', message, buttons))
        return found

    def _click_dialog_button(self, buttons: list, names: tuple[str, ...]) -> str | None:
        for b in buttons:
            if b.window_text() in names:
                label = b.window_text()
                _user32.PostMessageW(b.element_info.handle, _BM_CLICK, 0, 0)
                return label
        return None

    def _wait_dialog(self, timeout_s: float) -> tuple[int, str, str, list] | None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            found = self.dialogs()
            if found:
                return found[0]
            time.sleep(self._poll_s)
        return None

    def save(self) -> None:
        """저장을 누르고 '저장완료' 안내창을 닫는다. 다른 창이 뜨면 건드리지 않고 거절한다."""
        self._press_toolbar(SAVE_BUTTON)
        dialog = self._wait_dialog(30.0)
        if dialog is None:
            raise AdapterRetry(ExportFail.TIMEOUT, 'EMP 저장 뒤 안내창이 뜨지 않았다')
        _handle, title, message, buttons = dialog
        if SAVED_MARK not in message:
            raise AdapterReject(
                ExportFail.UNKNOWN, f'EMP 저장 뒤 모르는 창이 떴다: {title[:20]!r} {message[:60]!r}'
            )
        self._click_dialog_button(buttons, OK_BUTTONS)
        self._wait_enabled()

    def _wait_enabled(self, timeout_s: float = 10.0) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self._main.is_enabled() and not self.dialogs():
                return
            time.sleep(self._poll_s)
        raise AdapterRetry(ExportFail.BLOCKED, 'EMP 대화상자가 닫히지 않았다')

    def reload(self) -> None:
        """새로고침 — 서버에 저장된 값으로 그리드를 다시 채운다.

        저장 안 된 편집이 남아 있으면 EMP 가 '저장하시겠습니까?' 를 묻는다. 우리가 넣은 값은
        save() 로 이미 저장했으므로 여기서 묻는다면 뜻하지 않은 편집이다 — '아니요'로 버린다.
        """
        self._press_toolbar(REFRESH_BUTTON)
        dialog = self._wait_dialog(3.0)
        if dialog is not None:
            _handle, title, message, buttons = dialog
            if UNSAVED_MARK not in message:
                raise AdapterReject(
                    ExportFail.UNKNOWN,
                    f'EMP 새로고침 뒤 모르는 창이 떴다: {title[:20]!r} {message[:60]!r}',
                )
            self._click_dialog_button(buttons, NO_BUTTONS)
            log.warning('EMP 에 저장 안 된 편집이 남아 있어 버렸다')
            self._wait_enabled()
        time.sleep(self._poll_s * 4)
        self._refresh()

    def write(self, order_no: str, cost: int, shipping_fee: int) -> None:
        """원가·배송비 칸에 값을 넣고 저장한 뒤 새로고침한다. 이미 같은 값인 칸은 건드리지 않는다."""
        current = self.read(order_no)
        if (current.cost or 0) != cost:
            self._edit_cell(order_no, CELL_COST, COL_COST, cost)
        if (current.shipping_fee or 0) != shipping_fee:
            self._edit_cell(order_no, CELL_SHIPPING, COL_SHIPPING, shipping_fee)
        self.save()
        self.reload()
