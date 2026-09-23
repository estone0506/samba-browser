"""자동 수집 — 삼바웨이브의 미이행 주문을 스스로 큐에 넣는다(계획 Task D).

한 바퀴(`run_once`)가 하는 일은 셋뿐이다.
1. 삼바웨이브에서 최근 `days` 일 미이행 주문을 받아 결제 시각이 오래된 것부터 본다.
2. 이미 살아 있는(큐에 있는) 주문은 건너뛴다 — 같은 주문을 두 번 사지 않는다.
3. 남은 주문은 슬랙에 최상위 메시지를 하나 올리고, 그 ts 를 스레드로 삼아 큐에 넣는다.

맡을 구매 에이전트가 없는 소싱처(KREAM 보류·수기·스니커덩크 등)도 일단 큐에 넣되 바로
`needs_human` 으로 닫고 스레드에 한 줄 남긴다 — 사람이 보게 하되 하네스는 손대지 않는다.
슬랙에 나가는 문구에는 개인정보(이름·전화·주소)를 넣지 않는다(계획 Global Constraints).
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from samba_agent.agents.contracts import OrderRef
from samba_agent.queue.db import LIVE_STATES, JobQueue
from samba_agent.wave.client import WaveClient, WaveError, WaveOrder

if TYPE_CHECKING:
    from datetime import datetime

log = logging.getLogger(__name__)

# 슬랙 최상위 메시지에 싣는 상품명 길이 — 길면 스레드 제목이 읽히지 않는다
SKU_LIMIT = 40
# run_forever 가 멈춤 신호를 확인하는 간격(초). 주기가 길어도 종료는 빠르게 한다
TICK_S = 0.5


@dataclass(frozen=True)
class IntakeReport:
    """한 바퀴 결과. 슬랙 `주문처리 전체` 답장이 이 숫자를 그대로 읽어 준다."""

    seen: int = 0
    enqueued: int = 0
    skipped_live: int = 0
    unsupported: int = 0

    def as_line(self) -> str:
        return (
            f'수집 {self.seen}건 · 접수 {self.enqueued}건 · '
            f'진행중 제외 {self.skipped_live}건 · 미지원 {self.unsupported}건'
        )


def _paid_key(order: WaveOrder) -> tuple[int, float]:
    """결제 시각 오름차순. 시각이 없는 건은 맨 뒤로 민다."""
    paid: datetime | None = order.paid_at
    if paid is None:
        return (1, 0.0)
    return (0, paid.timestamp())


def intake_line(order: OrderRef) -> str:
    """슬랙 최상위 메시지 한 줄. 개인정보는 애초에 OrderRef 에 없다."""
    return f'접수: {order.order_no} · {order.source} · {order.sku[:SKU_LIMIT]} · {order.qty}개'


class Intake:
    """삼바웨이브 → 큐 자동 수집 고리."""

    def __init__(
        self,
        wave: WaveClient,
        queue: JobQueue,
        registry_or_sources: object,
        post_new: Callable[[str], str | None],
        post_line: Callable[[str | None, str], bool],
        *,
        days: int,
        requester: str = 'intake',
    ) -> None:
        self._wave = wave
        self._queue = queue
        self._registry = registry_or_sources
        self._post_new = post_new
        self._post_line = post_line
        self._days = days
        self._requester = requester
        # 슬랙 `수집 중지` 가 세우는 깃발. 세워져 있으면 run_once 는 아무것도 하지 않는다
        self.paused = False

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def run_once(self) -> IntakeReport:
        """한 바퀴. 삼바웨이브가 응답하지 않으면 빈 보고를 돌려주고 다음 주기를 기다린다."""
        if self.paused:
            return IntakeReport()
        try:
            orders = self._wave.pending_orders(days=self._days)
        except WaveError as e:
            log.warning('자동 수집 실패 — 다음 주기에 다시 해본다: %s', e)
            return IntakeReport()

        seen = enqueued = skipped_live = unsupported = 0
        handled: set[str] = set()
        for wave_order in sorted(orders, key=_paid_key):
            seen += 1
            order = wave_order.to_order_ref()
            if order.order_no in handled or self._is_live(order.order_no):
                skipped_live += 1
                continue
            handled.add(order.order_no)
            ts = self._post_new(intake_line(order))
            job, _created = self._queue.enqueue(order.order_no, self._requester, {}, thread_ts=ts)
            if self._supported(order):
                enqueued += 1
                continue
            # 맡을 구매 에이전트가 없다 — 큐에 흔적만 남기고 바로 사람에게 넘긴다
            unsupported += 1
            self._queue.finish(job.id, 'needs_human', error=f'unsupported: {order.source}')
            self._post_line(ts, f'미지원 소싱처: {order.source} — 사람이 처리해야 합니다')
        return IntakeReport(
            seen=seen, enqueued=enqueued, skipped_live=skipped_live, unsupported=unsupported
        )

    def run_forever(self, stop: Callable[[], bool], interval_s: float) -> None:
        """주기 실행. 멈춤 신호는 대기 중에도 `TICK_S` 마다 확인한다."""
        while not stop():
            try:
                self.run_once()
            except Exception:  # 한 바퀴가 깨져도 고리는 계속 돈다
                log.exception('자동 수집 한 바퀴가 실패했다 — 다음 주기로 넘어간다')
            waited = 0.0
            while waited < interval_s and not stop():
                nap = min(TICK_S, interval_s - waited)
                time.sleep(nap)
                waited += nap

    def _is_live(self, order_no: str) -> bool:
        """이미 큐에 살아 있는 주문인가 — 같은 주문을 두 번 접수하지 않는다."""
        job = self._queue.get(order_no)
        return job is not None and job.state in LIVE_STATES

    def _supported(self, order: OrderRef) -> bool:
        """이 소싱처를 맡을 구매 에이전트가 있는가.

        등록부(`Registry.pick`)를 주면 그 판단을 그대로 쓰고, 소싱처 표(`Sources`)만 주면
        표에 있고 `hold` 가 아닌지로 본다. 둘 다 아니면 막지 않는다(판단할 근거가 없다).
        """
        pick = getattr(self._registry, 'pick', None)
        if callable(pick):
            return pick('buyer', order, {}) is not None
        by_id = getattr(self._registry, 'by_id', None)
        if callable(by_id):
            found = by_id(order.source)
            return found is not None and found.status != 'hold'
        return True
