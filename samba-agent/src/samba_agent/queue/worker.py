"""실행기 — 큐에서 1건 집어 감독자 그래프를 돌리고, 결과를 큐와 슬랙에 쓴다.

손발(앱)이 하나라 한 번에 1건이다. 승인 대기(interrupt)에서 멈추면 큐 상태를
needs_human 으로 두고 사람이 슬랙에서 승인할 때까지 기다린다(스펙 §10-1).
"""

import time
from collections.abc import Callable
from dataclasses import dataclass

from samba_agent.agents.contracts import OrderRef
from samba_agent.queue.db import Job, JobQueue
from samba_agent.supervisor.approval import resume_command

THREAD_PREFIX = 'job:'


@dataclass
class WorkerDeps:
    """실행기가 쓰는 것들. 테스트는 여기에 가짜를 넣는다."""

    queue: JobQueue
    graph: object  # CompiledGraph
    version: str
    report: Callable[[Job, str], None]
    parse_order: Callable[[Job], OrderRef]


class Worker:
    """큐 ↔ 감독자 그래프."""

    def __init__(self, deps: WorkerDeps) -> None:
        self.d = deps

    def tick(self) -> Job | None:
        """queued 1건을 집어 끝까지(또는 승인 대기까지) 돌린다. 없으면 None."""
        job = self.d.queue.claim()
        if job is None:
            return None
        # queue/db.py(Task 9) 에는 harness_version 을 저장하는 메서드가 없다 — 보고 문구에만 남긴다.
        self.d.report(job, f'접수: {job.order_no} 처리 시작(하네스 {self.d.version})')
        state = {
            'order': self.d.parse_order(job),
            'options': {str(k): str(v) for k, v in job.options.items()},
            'job_id': job.id,
            'dry_run': True,
        }
        out = self.d.graph.invoke(state, self._config(job.id))
        return self._apply(job, out)

    def resume(self, order_no: str, approved: bool, by: str) -> Job | None:
        """슬랙 승인 버튼 → 멈춘 그래프를 깨운다. 끝난 주문이면 None."""
        job = self.d.queue.get(order_no)
        if (
            job is None
            or job.state != 'needs_human'
            or not (job.step or '').startswith('승인 대기')
        ):
            return None
        self.d.queue.finish(job.id, 'running')
        out = self.d.graph.invoke(resume_command(approved, by), self._config(job.id))
        return self._apply(job, out)

    def run_forever(self, stop: Callable[[], bool], interval_s: float = 2.0) -> None:
        """봇과 함께 도는 고리. stop() 이 참이 될 때까지 큐를 본다."""
        while not stop():
            if self.tick() is None:
                time.sleep(interval_s)

    def _config(self, job_id: int) -> dict[str, object]:
        return {'configurable': {'thread_id': f'{THREAD_PREFIX}{job_id}'}}

    def _apply(self, job: Job, out: dict) -> Job:
        """그래프 결과를 큐와 슬랙에 옮긴다."""
        interrupts = out.get('__interrupt__') or []
        if interrupts:
            req = interrupts[0].value
            self.d.queue.progress(
                job.id, agent=f'approval.{req["stage"]}', step=f'승인 대기: {req["stage"]}'
            )
            self.d.queue.finish(job.id, 'needs_human')
            self.d.report(job, f'승인 요청\n{req["summary"]}')
            return self.d.queue.get(job.order_no)  # type: ignore[return-value]
        outcome = out.get('outcome') or 'failed'
        fail = out.get('fail_reason')
        self.d.queue.progress(job.id, agent=None, step=None)
        self.d.queue.finish(job.id, outcome, error=str(fail) if fail else None)
        self.d.report(
            job,
            f'{job.order_no} {outcome}' + (f' — 사유 {fail}' if fail else ' — 완료'),
        )
        return self.d.queue.get(job.order_no)  # type: ignore[return-value]
