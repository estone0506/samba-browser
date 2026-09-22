"""실행기 — 큐에서 1건 집어 감독자 그래프를 돌리고, 결과를 큐와 슬랙에 쓴다.

손발(앱)이 하나라 한 번에 1건이다. 승인 대기(interrupt)에서 멈추면 큐 상태를
needs_human 으로 두고 사람이 슬랙에서 승인할 때까지 기다린다(스펙 §10-1).
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from samba_agent.agents.contracts import OrderRef
from samba_agent.failures import FailReason
from samba_agent.ops.events import EventLog
from samba_agent.ops.masking import mask_text
from samba_agent.ops.tracing import run_metadata, traced
from samba_agent.queue.db import PAY_STARTED_STEP, Job, JobQueue
from samba_agent.supervisor.approval import resume_command

THREAD_PREFIX = 'job:'

_log = logging.getLogger(__name__)


@dataclass
class WorkerDeps:
    """실행기가 쓰는 것들. 테스트는 여기에 가짜를 넣는다.

    ``version`` 은 tick 마다 다시 불러야 한다 — 규칙 파일을 PUT 으로 고치면
    harness_version 이 바뀌는데, 기동 시점 문자열로 고정하면 워커가 옛 버전을
    계속 기록한다(리뷰 지적 — Important 1). 기존 테스트 호환을 위해 문자열이
    오면 ``__post_init__`` 에서 상수를 돌려주는 콜러블로 감싼다.
    """

    queue: JobQueue
    graph: object  # CompiledGraph
    version: Callable[[], str] | str
    report: Callable[[Job, str], None]
    parse_order: Callable[[Job], OrderRef]
    # 승인 요청 전용 통로 — 슬랙 버튼을 달아 보낸다(리뷰 지적 — Critical 1).
    # 주입하지 않으면 평문 보고(report)로 떨어진다.
    approval_report: Callable[[Job, str, str, str], None] | None = None
    # settings.dry_run 이 아직 여기까지 안 들어와서 당장은 기본값 True 로 주입한다.
    dry_run: bool = True
    # dry-run 에서 결제 비밀번호를 몇 자리만 눌러 보고 취소할지(0 이면 결제창까지만)
    dry_run_digits: int = 0
    # 관측(스펙 §4.5 1단계) — 주입하면 실행 1건이 LangSmith span + 로컬 이벤트로 남는다.
    # 없으면 추적 없이 그냥 돈다(테스트·오프라인)
    events: EventLog | None = None
    env: str = 'dev'
    prompt_commit: str = '-'
    # 보관 기간 지난 이벤트 정리(EventLog.prune). 기동 시 1회 + 주기마다 부른다(리뷰 지적 — Minor)
    prune: Callable[[], int] | None = None
    prune_interval_s: float = 6 * 60 * 60

    def __post_init__(self) -> None:
        if isinstance(self.version, str):
            fixed = self.version
            self.version = lambda: fixed


class Worker:
    """큐 ↔ 감독자 그래프."""

    def __init__(self, deps: WorkerDeps) -> None:
        self.d = deps
        self._last_prune: float | None = None

    def tick(self) -> Job | None:
        """queued 1건을 집어 끝까지(또는 승인 대기까지) 돌린다. 없으면 None."""
        job = self.d.queue.claim()
        if job is None:
            return None
        version = self.d.version()
        self.d.queue.set_version(job.id, version)
        self.d.report(job, f'접수: {job.order_no} 처리 시작(하네스 {version})')
        # 주문 조회(브릿지)도 예외가 날 수 있다 — running 으로 남기지 않고 사람에게 넘긴다
        try:
            order = self.d.parse_order(job)
        except Exception as e:  # noqa: BLE001 — 조회 실패 사유는 다양하다(브릿지·JSON·누락 필드)
            msg = mask_text(str(e))[:300]
            self.d.queue.finish(job.id, 'needs_human', error=f'주문 조회 실패: {msg}')
            self.d.report(job, f'주문 조회 실패 — 사람 확인 필요: {msg}')
            return self.d.queue.get(job.order_no)
        state = {
            'order': order,
            'options': {str(k): str(v) for k, v in job.options.items()},
            'job_id': job.id,
            'dry_run': self.d.dry_run,
            'dry_run_digits': self.d.dry_run_digits,
        }
        return self._invoke(job, state)

    def resume(
        self, order_no: str, approved: bool, by: str, stage: str | None = None
    ) -> Job | None:
        """슬랙 승인 버튼 → 멈춘 그래프를 깨운다.

        끝난 주문이거나(중복 클릭 등) 이미 다른 단계로 넘어갔으면 None.
        ``stage`` 를 주면 지금 큐가 그 단계(``승인 대기: {stage}``)에 멈춰 있을 때만 재개한다 —
        같은 버튼을 두 번 눌러도 두 번째는 여기서 걸린다(스펙 리뷰 지적 — Critical 2).
        읽기→running 전환은 JobQueue 트랜잭션으로 원자화돼 있어 동시 호출도 하나만 통과한다.
        """
        job = self.d.queue.try_start_resume(order_no, stage=stage)
        if job is None:
            return None
        return self._invoke(job, resume_command(approved, by))

    def run_forever(self, stop: Callable[[], bool], interval_s: float = 2.0) -> None:
        """봇과 함께 도는 고리. stop() 이 참이 될 때까지 큐를 본다."""
        self._maybe_prune()  # 기동 시 1회
        while not stop():
            self._maybe_prune()
            try:
                caught_none = self.tick() is None
            except Exception:  # noqa: BLE001 — 고리는 개별 tick 예외로 멈추지 않는다
                _log.exception('tick 처리 중 예외 — 다음 주기로 계속한다')
                caught_none = True
            if caught_none:
                time.sleep(interval_s)

    def _maybe_prune(self) -> None:
        """보관 기간이 지난 이벤트를 치운다. 정리 실패가 실행 고리를 멈추지는 않는다."""
        if self.d.prune is None:
            return
        now = time.monotonic()
        if self._last_prune is not None and now - self._last_prune < self.d.prune_interval_s:
            return
        self._last_prune = now
        try:
            removed = self.d.prune()
        except Exception:  # noqa: BLE001 — 정리 실패는 로그만 남기고 계속 돈다
            _log.exception('이벤트 정리 실패 — 계속 돈다')
            return
        if removed:
            _log.info('오래된 이벤트 %d줄 정리', removed)

    def mark_stage(self, state: object, stage: str) -> None:
        """감독자가 단계에 들어갈 때 부른다 — 결제 진입만 큐에 적는다.

        이 표시가 남은 채로 프로세스가 죽으면 큐가 그 행을 다시 집지 않고 사람에게 넘긴다
        (리뷰 지적 — Critical 2 ①②). 결제 이외 단계는 부수효과가 없어 적지 않는다.
        """
        if stage != 'pay' or not isinstance(state, dict):
            return
        job_id = state.get('job_id')
        if job_id is None:
            return
        self.d.queue.progress(int(job_id), agent='payer', step=PAY_STARTED_STEP)

    def _config(self, job_id: int) -> dict[str, object]:
        return {'configurable': {'thread_id': f'{THREAD_PREFIX}{job_id}'}}

    def _source_of(self, job: Job, arg: object) -> str:
        """추적 메타데이터용 소싱처. 새 실행은 입력 state 에, 재개는 체크포인트에 있다."""
        if isinstance(arg, dict):
            order = arg.get('order')
            if order is not None:
                return str(getattr(order, 'source', '-'))
        get_state = getattr(self.d.graph, 'get_state', None)
        if callable(get_state):
            try:
                values = get_state(self._config(job.id)).values
                return str(getattr(values.get('order'), 'source', '-'))
            except Exception:  # noqa: BLE001 — 추적 메타데이터 때문에 실행을 막지 않는다
                _log.debug('체크포인트에서 소싱처를 읽지 못했다', exc_info=True)
        return '-'

    def _runner(self, job: Job, arg: object) -> Callable[..., object]:
        """그래프 호출을 추적으로 감싼다(리뷰 지적 — I3). events 가 없으면 그대로 부른다."""
        if self.d.events is None:
            return self.d.graph.invoke
        metadata = run_metadata(
            job_id=job.id,
            order_no=job.order_no,
            source=self._source_of(job, arg),
            requester=job.requester,
            agent='supervisor',
            version=self.d.version(),
            env=self.d.env,
            prompt_commit=self.d.prompt_commit,
        )
        return traced('supervisor.run', metadata=metadata, events=self.d.events)(
            self.d.graph.invoke
        )

    def _invoke(self, job: Job, arg: object) -> Job:
        """그래프를 부르고, 예외가 나면 사람에게 넘긴다(스펙 리뷰 지적 — Important 1)."""
        try:
            out = self._runner(job, arg)(arg, self._config(job.id))
        except Exception as exc:  # noqa: BLE001 — 그래프 내부 예외는 감독자가 아니라 여기서 받는다
            return self._on_exception(job, exc)
        return self._apply(job, out)

    def _on_exception(self, job: Job, exc: Exception) -> Job:
        """그래프가 예외를 던지면 큐를 needs_human 으로 마감하고 사유를 남긴다."""
        masked = mask_text(str(exc))
        _log.exception('그래프 실행 중 예외 — %s', job.order_no)
        self.d.queue.progress(job.id, agent=None, step=None)
        self.d.queue.finish(job.id, 'needs_human', error=str(FailReason.UNKNOWN))
        self.d.report(job, f'{job.order_no} 처리 중 오류로 사람에게 넘긴다 — {masked}')
        return self.d.queue.get(job.order_no)  # type: ignore[return-value]

    def _apply(self, job: Job, out: dict) -> Job:
        """그래프 결과를 큐와 슬랙에 옮긴다."""
        interrupts = out.get('__interrupt__') or []
        if interrupts:
            req = interrupts[0].value
            stage = str(req['stage'])
            summary = str(req['summary'])
            order_no = str(req.get('order_no') or job.order_no)
            self.d.queue.progress(job.id, agent=f'approval.{stage}', step=f'승인 대기: {stage}')
            self.d.queue.finish(job.id, 'needs_human')
            if self.d.approval_report is not None:
                self.d.approval_report(job, order_no, stage, summary)
            else:
                # 버튼을 달 통로가 없을 때의 폴백 — 사람이 `@삼바` 명령으로 이어가야 한다
                self.d.report(job, f'승인 요청\n{summary}')
            return self.d.queue.get(job.order_no)  # type: ignore[return-value]
        outcome = out['outcome']
        fail = out.get('fail_reason')
        self.d.queue.progress(job.id, agent=None, step=None)
        self.d.queue.finish(job.id, outcome, error=str(fail) if fail else None)
        self.d.report(
            job,
            f'{job.order_no} {outcome}' + (f' — 사유 {fail}' if fail else ' — 완료'),
        )
        return self.d.queue.get(job.order_no)  # type: ignore[return-value]
