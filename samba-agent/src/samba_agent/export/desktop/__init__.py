"""외부 프로그램 어댑터 등록 지점.

여기 등록된 대상만 입력 작업자가 큐에서 집는다 — 등록되지 않은 대상의 요청은 큐에 대기로 남는다.
드라이버(pywinauto)는 지연 import 한다 — 하네스 본체에는 그 의존성이 없다.
"""

from collections.abc import Collection

from samba_agent.export.adapters import Adapter, BatchAdapter
from samba_agent.export.desktop.emp import EmpAdapter
from samba_agent.export.desktop.shopmine import ShopMineAdapter


def _shopmine_ui():
    from samba_agent.export.desktop.shopmine_ui import PywinautoShopMineUi

    return PywinautoShopMineUi()


def _emp_ui():
    from samba_agent.export.desktop.emp_ui import PywinautoEmpUi

    return PywinautoEmpUi()


def build_adapters(targets: Collection[str]) -> dict[str, Adapter | BatchAdapter]:
    """설정에 적힌 대상만 만든다(대상 이름 → 어댑터). 모르는 이름은 거부한다."""
    made: dict[str, Adapter | BatchAdapter] = {}
    for target in targets:
        if target == 'shopmine':
            made[target] = ShopMineAdapter(_shopmine_ui())
        elif target == 'emp':
            # EMP 는 관리자 권한으로 돈다 — 작업자도 관리자 권한으로 띄워야 한다
            made[target] = EmpAdapter(_emp_ui())
        else:
            raise ValueError(f'모르는 외부 기입 대상: {target!r}')
    return made
