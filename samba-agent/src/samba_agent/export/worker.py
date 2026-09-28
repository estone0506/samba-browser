"""입력 작업자 — 큐에서 한 건씩 꺼내 어댑터로 기입한다.

관리자 권한으로 따로 도는 프로세스다(EMP 가 관리자 권한이라 일반 권한으로는 입력이 막힌다).
규칙: 먼저 읽는다 → 같은 값이면 입력하지 않는다 → 다른 값이 있으면 덮어쓰지 않는다 →
입력한 뒤에는 되읽어 확인한다.
"""

import logging
import time
from collections.abc import Callable, Mapping

from samba_agent.export.adapters import Adapter, AdapterReject, AdapterRetry, CellValues
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue, ExportRequest

log = logging.getLogger(__name__)


def _same(current: CellValues, req: ExportRequest) -> bool:
    """이미 기입할 값이 들어 있는가. 빈 셀과 0 은 같게 본다."""
    return (current.cost or 0) == req.cost and (current.shipping_fee or 0) == req.shipping_fee


def _conflict(current: CellValues, req: ExportRequest) -> str | None:
    """덮어쓰면 안 되는 값이 있으면 그 설명. 비어 있거나 같은 값이면 None."""
    found: list[str] = []
    if (current.cost or 0) not in (0, req.cost):
        found.append(f'원가 {current.cost:,}(기입할 값 {req.cost:,})')
    if (current.shipping_fee or 0) not in (0, req.shipping_fee):
        found.append(f'배송비 {current.shipping_fee:,}(기입할 값 {req.shipping_fee:,})')
    return ' · '.join(found) or None


class ExportWorker:
    """외부 기입 작업자. 한 번에 1건만 처리한다(프로그램 창이 하나다)."""

    def __init__(
        self,
        queue: ExportQueue,
        adapters: Mapping[str, Adapter],
        *,
        user_idle_s: Callable[[], float],
        min_idle_s: float = 20.0,
        max_attempts: int = 5,
        retry_delay_s: float = 60.0,
    ) -> None:
        self._queue = queue
        self._adapters = dict(adapters)
        self._user_idle_s = user_idle_s
        self._min_idle_s = min_idle_s
        self._max_attempts = max_attempts
        self._retry_delay_s = retry_delay_s

    @property
    def targets(self) -> tuple[str, ...]:
        return tuple(self._adapters)

    def run_once(self) -> ExportRequest | None:
        """요청 1건을 처리하고 그 최종 상태를 돌려준다. 할 일이 없으면 None."""
        if not self._adapters:
            return None
        # 사람이 PC 를 쓰는 중이면 집지도 않는다 — 시도 횟수를 헛되이 쓰지 않는다
        if self._user_idle_s() < self._min_idle_s:
            return None
        req = self._queue.claim_next(self.targets)
        if req is None:
            return None
        self._process(req, self._adapters[req.target])
        return self._queue.get(req.id)

    def _process(self, req: ExportRequest, adapter: Adapter) -> None:
        try:
            current = adapter.read(req.order_no)
            if _same(current, req):
                self._queue.done(req.id, '이미 같은 값이 들어 있어 입력하지 않았다')
                return
            conflict = _conflict(current, req)
            if conflict is not None:
                self._queue.fail(req.id, ExportFail.VALUE_CONFLICT, f'덮어쓰지 않았다 — {conflict}')
                return
            adapter.write(req.order_no, req.cost, req.shipping_fee)
            after = adapter.read(req.order_no)
            if not _same(after, req):
                self._queue.fail(
                    req.id,
                    ExportFail.VERIFY_MISMATCH,
                    f'되읽은 값이 다르다 — 원가 {after.cost} · 배송비 {after.shipping_fee}',
                )
                return
            self._queue.done(req.id, f'원가 {req.cost:,} · 배송비 {req.shipping_fee:,} 기입 확인')
        except AdapterRetry as e:
            if req.attempts >= self._max_attempts:
                self._queue.fail(
                    req.id, e.reason, f'재시도 {req.attempts}회 모두 실패 — {e.detail}'
                )
            else:
                self._queue.retry_later(req.id, e.reason, e.detail, self._retry_delay_s)
        except AdapterReject as e:
            self._queue.fail(req.id, e.reason, e.detail)
        except Exception as e:
            # 입력이 어디까지 됐는지 모른다 — 자동으로 다시 하지 않고 사람이 본다
            log.exception('외부 기입 중 오류: %s(%s)', req.order_no, req.target)
            self._queue.fail(req.id, ExportFail.UNKNOWN, f'{type(e).__name__}: {e}'[:200])

    def run_forever(
        self,
        should_stop: Callable[[], bool],
        poll_s: float = 3.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """멈추라고 할 때까지 돈다. 일을 했으면 쉬지 않고 바로 다음 건을 본다."""
        while not should_stop():
            worked = False
            try:
                # 살아 있다는 표시는 실제로 집을 수 있을 때만 남긴다 — 사람이 PC 를 쓰는 중에도
                # beat 를 남기면 export 단계가 alive() 만 보고 주문마다 대기 시간을 통째로 쓴다
                if self._user_idle_s() >= self._min_idle_s:
                    self._queue.beat(self.targets)
                worked = self.run_once() is not None
            except Exception:
                log.exception('입력 작업자 고리 오류 — 계속한다')
            if not worked:
                sleep(poll_s)
