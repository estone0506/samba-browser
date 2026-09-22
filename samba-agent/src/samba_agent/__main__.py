"""`python -m samba_agent` — 실행 진입점. 배선만 한다(새 로직 없음, 스펙 §10-2).

순서: 설정 로딩 → 추적 설정 → 큐·등록부·브릿지·에이전트·그래프(gate=True) → 봇 → API.
`Worker.run_forever` 와 API 서버는 데몬 스레드로, `SambaBot.start()` 는 주 스레드에서 돈다.
"""

import functools
import logging
import threading

from langgraph.checkpoint.sqlite import SqliteSaver
from slack_bolt import App

from samba_agent.agents.contracts import OrderRef
from samba_agent.agents.factory import build_agents
from samba_agent.agents.registry import Registry
from samba_agent.api.server import build_app, serve
from samba_agent.bridge.client import BridgeClient
from samba_agent.gateway.slack_bot import SambaBot
from samba_agent.ops.diagnose import diagnose
from samba_agent.ops.events import EventLog
from samba_agent.ops.masking import mask_text
from samba_agent.ops.releases import ReleaseStore
from samba_agent.ops.tracing import configure_tracing
from samba_agent.queue.db import Job, JobQueue
from samba_agent.queue.worker import Worker, WorkerDeps
from samba_agent.settings import load_settings
from samba_agent.supervisor.graph import build_supervisor
from samba_agent.version import harness_version

log = logging.getLogger(__name__)


def _parse_order(job: Job) -> OrderRef:
    """큐 옵션 → OrderRef. 슬랙 명령에 없는 값은 등록부 조건에서 빠지지 않게 빈 문자열로 둔다."""
    o = job.options
    return OrderRef(
        order_no=job.order_no,
        source=str(o.get('source', '')),
        seller=str(o.get('seller', '')),
        sku=str(o.get('sku', '')),
        qty=int(o.get('qty', 1)),
    )


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

    def _decide(prompt: str, model):  # type: ignore[no-untyped-def]
        """구조화 판단. claude-agent-sdk 연결은 별도 작업 범위라 지금은 자리만 잡는다."""
        raise NotImplementedError('decide 함수는 claude-agent-sdk 배선 작업에서 채운다')

    agents = build_agents(reg, bridge, _decide)

    version_fn = functools.partial(harness_version, settings.root, {})
    checkpointer = SqliteSaver.from_conn_string(str(settings.root / 'checkpoints.sqlite'))
    if hasattr(checkpointer, '__enter__'):
        checkpointer = checkpointer.__enter__()
    graph = build_supervisor(reg, agents, checkpointer=checkpointer, gate=True)

    def _report(job: Job, line: str) -> None:
        """진행 보고 — 슬랙 원본 스레드에 남긴다. 개인정보는 슬랙에 닿기 전에 가린다."""
        if job.thread_ts is None or slack_app is None:
            log.info('%s', mask_text(line))
            return
        slack_app.client.chat_postMessage(
            channel=settings.slack_channel, thread_ts=job.thread_ts, text=mask_text(line)
        )

    worker = Worker(
        WorkerDeps(
            queue=queue,
            graph=graph,
            version=version_fn(),
            report=_report,
            parse_order=_parse_order,
            dry_run=settings.dry_run,
        )
    )

    def _diagnose_text(version: str | None) -> str:
        v = version or version_fn()
        return diagnose(events, version=v).to_markdown()

    slack_app: App | None = None
    if settings.slack_bot_token and settings.slack_app_token:
        slack_app = App(token=settings.slack_bot_token.get_secret_value())

    bot = SambaBot(slack_app, worker, queue, settings, _diagnose_text)

    app = build_app(reg=reg, queue=queue, releases=releases, root=settings.root, version=version_fn)

    stop = threading.Event()
    worker_thread = threading.Thread(
        target=worker.run_forever, args=(stop.is_set,), daemon=True, name='worker'
    )
    api_thread = threading.Thread(target=serve, args=(app,), daemon=True, name='api')
    worker_thread.start()
    api_thread.start()

    if slack_app is not None:
        from slack_bolt.adapter.socket_mode import SocketModeHandler

        bot.start()
        SocketModeHandler(slack_app, settings.slack_app_token.get_secret_value()).start()
    else:
        log.warning('슬랙 토큰이 없다 — 봇 없이 큐/API 만 돈다')
        stop_forever = threading.Event()
        stop_forever.wait()


if __name__ == '__main__':
    main()
