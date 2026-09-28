"""외부 기입 실패 알림 — 실패한 요청을 그 주문의 슬랙 스레드에 한 번만 알린다.

하네스 프로세스에서 돈다(슬랙 봇이 거기 있다). 입력 작업자는 큐에 결과만 적는다.
"""

import logging
import time
from collections.abc import Callable

from samba_agent.export.store import ExportQueue, ExportRequest

log = logging.getLogger(__name__)


def _text(req: ExportRequest) -> str:
    return (
        f'{req.order_no} 외부 기입 실패({req.target}) — {req.fail_reason}: {req.detail or ""}\n'
        f'기입하려던 값: 원가 {req.cost:,} · 배송비 {req.shipping_fee:,} '
        '(주문은 완료 상태 그대로다. 직접 기입이 필요하다)'
    )


class ExportNotifier:
    """실패 알림 고리."""

    def __init__(
        self,
        queue: ExportQueue,
        thread_of: Callable[[str], str | None],
        post: Callable[[str | None, str], bool],
    ) -> None:
        self._queue = queue
        self._thread_of = thread_of
        self._post = post

    def tick(self) -> int:
        """알리지 않은 실패를 알린다. 이번에 알린 건수를 돌려준다."""
        sent = 0
        for req in self._queue.unnotified_failed():
            try:
                delivered = self._post(self._thread_of(req.order_no), _text(req))
            except Exception:
                # 표시하지 않는다 — 다음 바퀴에 다시 알린다
                log.exception('외부 기입 실패 알림 전송 오류: %s', req.order_no)
                continue
            if not delivered:
                # 슬랙이 없는 실행 — 로그에 남기고 되풀이하지 않는다
                log.warning('%s', _text(req))
            self._queue.mark_notified(req.id)
            sent += 1
        return sent

    def run_forever(
        self,
        should_stop: Callable[[], bool],
        interval_s: float = 15.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        while not should_stop():
            try:
                self.tick()
            except Exception:
                log.exception('외부 기입 알림 고리 오류 — 계속한다')
            sleep(interval_s)
