"""`python -m samba_agent` — 실행 진입점. 배선만 한다(새 로직 없음, 스펙 §10-2).

순서: 설정 로딩 → 추적 설정 → 큐·등록부·브릿지·에이전트·그래프(gate=True) → 봇 → API.
`Worker.run_forever` 와 API 서버는 데몬 스레드로, `SambaBot.start()` 는 주 스레드에서 돈다.
"""

import functools
import logging
import signal
import threading
from collections.abc import Callable

from langgraph.checkpoint.sqlite import SqliteSaver
from slack_bolt import App

from samba_agent.agents.factory import build_agents
from samba_agent.agents.registry import Registry
from samba_agent.api.server import build_app, serve
from samba_agent.bridge.client import BridgeClient
from samba_agent.gateway.slack_bot import SambaBot
from samba_agent.llm.decide import make_decide
from samba_agent.ops.diagnose import diagnose
from samba_agent.ops.events import EventLog
from samba_agent.ops.masking import mask_text
from samba_agent.ops.releases import ReleaseStore
from samba_agent.ops.tracing import configure_tracing
from samba_agent.queue.db import Job, JobQueue
from samba_agent.queue.orders import lookup_order
from samba_agent.queue.worker import Worker, WorkerDeps
from samba_agent.settings import load_settings
from samba_agent.supervisor.graph import build_supervisor
from samba_agent.version import harness_version

log = logging.getLogger(__name__)

ReportFn = Callable[[Job, str], None]
ApprovalReportFn = Callable[[Job, str, str, str], None]


def make_reporters(get_bot: 'Callable[[], SambaBot]') -> tuple[ReportFn, ApprovalReportFn]:
    """실행기가 쓸 보고 통로 두 개(진행 보고 · 승인 요청)를 만든다.

    승인 요청은 반드시 버튼이 달린 경로로 나가야 한다 — 버튼이 없으면 사람이 승인할 방법이
    없어 결제·기록 단계가 영구 정지한다(리뷰 지적 — Critical 1). 봇은 나중에 만들어지므로
    콜러블로 받아 호출 시점에 푼다.
    """

    def report(job: Job, line: str) -> None:
        if not get_bot().post(job.thread_ts, line):
            log.info('%s', mask_text(line))

    def approval_report(job: Job, order_no: str, stage: str, summary: str) -> None:
        if not get_bot().post_approval(job.thread_ts, order_no, stage, summary):
            log.info('승인 요청(슬랙 없음) %s %s\n%s', order_no, stage, mask_text(summary))

    return report, approval_report


def main() -> None:
    settings = load_settings()
    logging.basicConfig(level=logging.INFO)
    configure_tracing(settings)

    reg = Registry.load(settings.root)
    queue = JobQueue(settings.db_path)
    releases = ReleaseStore(settings.root / 'releases.sqlite')
    events = EventLog(settings.root / 'events.sqlite')

    bridge = BridgeClient(
        settings.bridge_url,
        settings.bridge_token.get_secret_value(),
        allowed=(),  # 최상위 클라이언트는 도구를 직접 부르지 않는다 — 에이전트마다 scoped() 로 좁힌다
    )

    # 모델명은 settings 에 없다 — llm.decide 의 상수(claude-sonnet-5) 를 그대로 쓴다
    decide = make_decide()

    agents = build_agents(reg, bridge, decide)

    version_fn = functools.partial(harness_version, settings.root, {})
    checkpointer = SqliteSaver.from_conn_string(str(settings.root / 'checkpoints.sqlite'))
    if hasattr(checkpointer, '__enter__'):
        checkpointer = checkpointer.__enter__()
    # 결제 진입 표시를 큐에 남기려면 실행기가 필요하다 — 아래에서 만들고 콜백으로 잇는다
    graph = build_supervisor(
        reg,
        agents,
        checkpointer=checkpointer,
        gate=True,
        on_stage_start=lambda state, stage: worker.mark_stage(state, stage),
    )

    _report, _approval_report = make_reporters(lambda: bot)

    worker = Worker(
        WorkerDeps(
            queue=queue,
            graph=graph,
            version=version_fn,  # 콜러블 그대로 넘긴다 — tick 마다 다시 불러 규칙 변경을 반영한다
            report=_report,
            parse_order=lambda job: lookup_order(bridge, job.order_no, job.options),
            approval_report=_approval_report,
            dry_run=settings.dry_run,
            # 관측 배선 — 실행 1건이 LangSmith span + 로컬 이벤트로 남는다(리뷰 지적 — I3)
            events=events,
            env=settings.harness_env,
            prompt_commit=settings.prompt_commit,
            prune=events.prune,
        )
    )

    def _diagnose_text(version: str | None) -> str:
        v = version or version_fn()
        return diagnose(events, version=v).to_markdown()

    slack_app: App | None = None
    if settings.slack_bot_token and settings.slack_app_token:
        slack_app = App(token=settings.slack_bot_token.get_secret_value())

    bot = SambaBot(slack_app, worker, queue, settings, _diagnose_text)

    app = build_app(
        reg=reg,
        queue=queue,
        releases=releases,
        root=settings.root,
        version=version_fn,
        report_dir=settings.report_dir,
    )

    # 이벤트 하나로 통일한다(리뷰 지적 — Minor) — SIGINT/SIGTERM 이 이걸 세우면
    # 워커 고리와(봇 없을 때의) 대기가 함께 풀린다.
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_a: stop.set())
    signal.signal(signal.SIGTERM, lambda *_a: stop.set())

    worker_thread = threading.Thread(
        target=worker.run_forever, args=(stop.is_set,), daemon=True, name='worker'
    )
    api_thread = threading.Thread(target=serve, args=(app,), daemon=True, name='api')
    worker_thread.start()
    api_thread.start()

    if slack_app is not None:
        # start() 안에서 Socket Mode 핸들러를 직접 띄운다 — 여기서 또 띄우지 않는다(리뷰 지적 — Minor)
        bot.start()
    else:
        log.warning('슬랙 토큰이 없다 — 봇 없이 큐/API 만 돈다')
        stop.wait()


if __name__ == '__main__':
    main()
