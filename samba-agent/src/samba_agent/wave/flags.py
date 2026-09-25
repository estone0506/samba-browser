"""이행하지 못한 주문에 삼바웨이브 표시(가격X·재고X)를 붙인다 — 사용자 지시 2026-09-25.

- 마진 미달로 결제를 멈춘 주문 → 가격X
- 품절·옵션 없음·삭제된 상품(무신사 '유효하지 않은 상품') → 재고X

삼바웨이브 주문 행의 버튼은 누를 때마다 켜고 끄는 토글이다. 그래서 누르기 전에 내부 API 로 태그를
읽어 이미 붙어 있으면 누르지 않고, 누른 뒤에는 다시 읽어 붙었는지 확인한다.
"""

import json
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
    """주문 행의 가격X·재고X 버튼을 누른다. run_script 는 앱 저장 스크립트를 부르는 함수다."""

    def __init__(self, wave: WaveClient, run_script: Callable[[str, dict[str, object]], str]) -> None:
        self._wave = wave
        self._run = run_script

    def _has(self, order_no: str, token: str) -> bool:
        return token in self._wave.get_order(order_no).flags

    def mark(self, order_no: str, error: str | None) -> str | None:
        """붙였으면 결과 한 줄, 붙일 게 없으면 None. 실패해도 예외를 내지 않는다(작업 결과는 이미 정해졌다)."""
        flag = flag_for(error)
        if flag is None:
            return None
        token, label = flag
        try:
            if self._has(order_no, token):
                return f'{label} 이미 표시됨'
            raw = self._run(FLAG_SCRIPT, {'orderNo': order_no, 'label': label})
            try:
                out = json.loads(raw)
            except ValueError:
                out = {'ok': False, 'note': raw[:120]}
            if not out.get('ok'):
                return f'{label} 표시 실패: {out.get("note")}'
            if not self._has(order_no, token):
                return f'{label} 눌렀지만 삼바웨이브 태그에 없다 — 확인 필요'
            return f'{label} 표시함'
        except WaveError as e:
            return f'{label} 표시 실패(삼바웨이브 조회): {e}'
        except Exception as e:  # 앱 꺼짐·브릿지 오류 — 작업 결과에는 영향이 없다
            log.exception('가격X·재고X 표시 실패')
            return f'{label} 표시 실패: {type(e).__name__}'
