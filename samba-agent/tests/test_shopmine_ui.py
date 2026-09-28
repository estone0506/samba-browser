"""샵마인 드라이버(shopmine_ui)의 순수 로직만 — 실제 창은 전혀 건드리지 않는다.

드라이버 나머지는 실제 창이 있어야 시험할 수 있어(실기 시험, task-3-report.md 참고) 단위
시험 대상이 아니다. 여기서는 pywinauto 를 부르지 않는 헬퍼만 골라 시험한다.
"""

from dataclasses import dataclass

from samba_agent.export.desktop.shopmine_ui import _new_windows


@dataclass
class _FakeWindow:
    handle: int


def test_new_windows_는_스냅숏에_없던_핸들만_돌려준다():
    before = {1, 2}
    windows = [_FakeWindow(1), _FakeWindow(2), _FakeWindow(3), _FakeWindow(4)]
    result = _new_windows(before, windows)
    assert [w.handle for w in result] == [3, 4]


def test_new_windows_는_스냅숏이_비어_있으면_전부_돌려준다():
    result = _new_windows(set(), [_FakeWindow(5), _FakeWindow(6)])
    assert [w.handle for w in result] == [5, 6]


def test_new_windows_는_전부_기존_핸들이면_빈_목록():
    before = {1, 2, 3}
    assert _new_windows(before, [_FakeWindow(1), _FakeWindow(2)]) == []
