"""사용자가 마지막으로 키보드·마우스를 만진 뒤 지난 시간.

작업자는 사람이 PC 를 쓰는 동안 화면을 건드리지 않는다 — 키 입력이 섞이면 엉뚱한 셀에 값이 들어간다.
삼바브라우저의 페이지 조작(CDP)과 폰 조작(adb)은 Windows 입력으로 잡히지 않는다.
"""

import ctypes
import sys


class _LastInputInfo(ctypes.Structure):
    _fields_ = [('cbSize', ctypes.c_uint), ('dwTime', ctypes.c_uint)]


def user_idle_seconds() -> float:
    """마지막 입력 뒤 지난 초. Windows 가 아니거나 못 읽으면 0(사용 중으로 본다 — 안전한 쪽)."""
    if sys.platform != 'win32':
        return 0.0
    info = _LastInputInfo()
    info.cbSize = ctypes.sizeof(_LastInputInfo)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    # 둘 다 부팅 뒤 밀리초(32비트)다 — 49일마다 0 으로 돌아가므로 차이를 32비트로 자른다
    elapsed_ms = (ctypes.windll.kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF
    return elapsed_ms / 1000.0
