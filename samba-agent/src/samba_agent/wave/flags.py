"""이행하지 못한 주문에 삼바웨이브 표시(가격X·재고X)를 붙이고 취소요청으로 바꾼다 — 사용자 지시 2026-09-25.

- 마진 미달로 결제를 멈춘 주문 → 가격X
- 품절·옵션 없음·삭제된 상품(무신사 '유효하지 않은 상품') → 재고X

삼바웨이브 주문 행의 버튼은 누를 때마다 켜고 끄는 토글이다. 그래서 누르기 전에 내부 API 로 태그를
읽어 이미 붙어 있으면 누르지 않고, 누른 뒤에는 다시 읽어 붙었는지 확인한다.
"""

import logging
from collections.abc import Callable

from samba_agent.failures import FailReason
from samba_agent.wave.client import WaveClient, WaveError

log = logging.getLogger(__name__)

FLAG_SCRIPT = 'samba_set_flag'

# 실패 사유 → (삼바웨이브 태그 토큰, 버튼 글자)
FLAG_FOR_REASON: dict[str, tuple[str, str]] = {
    str(FailReason.MARGIN): ('no_price', '가격X'),
    str(FailReason.OUT_OF_STOCK): ('no_stock', '재고X'),
}


def flag_for(error: str | None) -> tuple[str, str] | None:
    """작업 오류(실패 사유) → 붙일 표시. 해당 없으면 None."""
    return FLAG_FOR_REASON.get((error or '').strip())


class FlagMarker:
    """이행 불가 주문에 표시(가격X·재고X)를 붙이고 취소요청으로 바꾼다.

    표시는 삼바웨이브 내부 API 로 action_tag 에 붙인다 — 주문 행 버튼이 하는 일과 같다. 화면 검색은 쓰지 않는다
    (실기 2026-09-25: 주문번호에 ':' 이 든 주문을 화면 검색이 못 찾아 가격X 가 빠졌다). run_script 는 옛 배선
    호환용으로만 받는다.
    """

    def __init__(
        self, wave: WaveClient, run_script: Callable[[str, dict[str, object]], str] | None = None
    ) -> None:
        self._wave = wave
        self._run = run_script

    def mark(self, order_no: str, error: str | None) -> str | None:
        """표시 + 취소요청. 결과 한 줄(해당 없으면 None). 실패해도 예외를 내지 않는다(작업 결과는 이미 정해졌다)."""
        flag = flag_for(error)
        if flag is None:
            return None
        token, label = flag
        try:
            changed = self._wave.set_cancel_requested(order_no, str(error), flag=token)
            tagged = token in self._wave.get_order(order_no).flags
        except WaveError as e:
            return f'{label}·취소요청 실패: {e}'
        except Exception as e:  # 연결 오류 등 — 작업 결과에는 영향이 없다
            log.exception('가격X·재고X·취소요청 실패')
            return f'{label}·취소요청 실패: {type(e).__name__}'
        status = '취소요청으로 바꿈' if changed else '이미 취소요청'
        return f'{label} 표시함 · {status}' if tagged else f'{label} 태그 확인 안 됨 · {status}'
