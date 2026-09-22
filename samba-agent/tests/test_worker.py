# 실행기 — 1건 처리 / 승인 대기 / 재개 / 거부 / 중복 요청 / 브릿지 죽음
import threading

import pytest
from langgraph.checkpoint.memory import MemorySaver

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.ops.events import EventLog
from samba_agent.ops.gate import _observe_ok
from samba_agent.queue.db import JobQueue
from samba_agent.queue.worker import Worker, WorkerDeps
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor


def order_of(job) -> OrderRef:
    return OrderRef(order_no=job.order_no, source='무신사', seller='포이즌', sku='S1', qty=1)


def agents(log, fail_at=None):
    def mk(name, **payload):
        def fn(_a):
            log.append(name)
            if fail_at == name:
                return AgentResult(
                    status='fail', reason='브릿지 끊김', fail_reason=FailReason.BRIDGE_DOWN
                )
            return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)

        return fn

    return {
        'buyer.musinsa': mk('buy', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5),
        'payer': mk('pay', paid=True),
        'recorder': mk('record', saved=True),
        'verifier': mk('verify'),
    }


@pytest.fixture()
def setup(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    log: list[str] = []
    sent: list[str] = []

    def make(gate: bool, fail_at=None) -> Worker:
        graph = build_supervisor(reg, agents(log, fail_at), checkpointer=MemorySaver(), gate=gate)
        return Worker(
            WorkerDeps(
                queue=q,
                graph=graph,
                version='vtest',
                report=lambda job, line: sent.append(line),
                parse_order=order_of,
            )
        )

    return q, log, sent, make


def test_게이트_없이_한_건을_끝까지_돌린다(setup):
    q, log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = make(gate=False).tick()
    assert job.state == 'done'
    assert log == ['buy', 'pay', 'record', 'verify']
    assert q.get('A1').state == 'done'
    assert q.get('A1').harness_version == 'vtest'
    assert any('vtest' in s for s in sent)
    assert any('done' in s or '완료' in s for s in sent)


def test_승인_대기에서_멈추고_요약을_보고한다(setup):
    q, log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = make(gate=True).tick()
    assert job.state == 'needs_human'
    assert '승인 대기' in q.get('A1').step
    assert any('승인 요청' in s for s in sent)
    assert log == ['buy']


def test_승인하면_이어서_끝난다(setup):
    q, log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    w.tick()
    w.resume('A1', approved=True, by='U9')  # 결제 승인
    job = w.resume('A1', approved=True, by='U9')  # 기록 승인
    assert job.state == 'done'
    assert log == ['buy', 'pay', 'record', 'verify']


def test_거부하면_사람에게_남는다(setup):
    q, log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    w.tick()
    job = w.resume('A1', approved=False, by='U9')
    assert job.state == 'needs_human'
    assert log == ['buy']


def test_끝난_주문의_재개는_무시한다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)
    w.tick()
    assert w.resume('A1', approved=True, by='U9') is None


def test_같은_주문을_두_번_넣어도_한_번만_돈다(setup):
    q, log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.enqueue('A1', 'U2', {}, 'ts2')  # 중복 — 새 행이 생기지 않는다
    w = make(gate=False)
    assert w.tick() is not None
    assert w.tick() is None
    assert log.count('buy') == 1


def test_브릿지가_죽으면_사람에게_넘기고_사유를_남긴다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = make(gate=False, fail_at='buy').tick()
    assert job.state == 'needs_human'
    assert 'bridge_down' in q.get('A1').error


def test_그래프가_예외를_던지면_needs_human으로_마감하고_사유를_가린다(setup):
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)

    def boom(*_a, **_k):
        raise RuntimeError('디비 연결 실패: hong@example.com')

    w.d.graph.invoke = boom  # type: ignore[method-assign]
    job = w.tick()

    assert job is not None
    assert job.state == 'needs_human'  # running 으로 남지 않는다
    assert q.get('A1').error == 'unknown'
    assert any('***' in s and 'hong@example.com' not in s for s in sent)


def test_run_forever는_tick_예외에도_계속_돈다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)

    calls = {'n': 0}

    def tick_boom():
        calls['n'] += 1
        raise RuntimeError('예상 못한 오류')

    w.tick = tick_boom  # type: ignore[method-assign]
    ticks = iter([False, False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)

    assert calls['n'] == 2  # 프로세스가 살아서 다음 주기로 계속 돈다


def test_동시에_두번_resume해도_그래프는_한번만_불린다(setup):
    # 리뷰 지적 — Important 3: 읽기→running 전환을 트랜잭션으로 원자화했는지 확인
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    w.tick()
    assert q.get('A1').step == '승인 대기: pay'

    lock = threading.Lock()
    invoke_calls: list[int] = []
    real_invoke = w.d.graph.invoke

    def counting_invoke(state, config):
        with lock:
            invoke_calls.append(1)
        return real_invoke(state, config)

    w.d.graph.invoke = counting_invoke  # type: ignore[method-assign]

    barrier = threading.Barrier(2)
    results: list[object] = []
    results_lock = threading.Lock()

    def call_resume() -> None:
        barrier.wait()
        r = w.resume('A1', approved=True, by='U9', stage='pay')
        with results_lock:
            results.append(r)

    threads = [threading.Thread(target=call_resume) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(invoke_calls) == 1
    assert sum(1 for r in results if r is not None) == 1


def test_version이_콜러블이면_tick마다_다시_불러_새_버전을_기록한다(setup):
    # 리뷰 지적 — Important 1: 규칙 파일을 PUT 으로 고쳐 harness_version 이 바뀌면
    # 다음 tick 은 옛 버전이 아니라 새 버전을 큐에 남겨야 한다.
    q, _log, sent, _make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.enqueue('A2', 'U1', {}, 'ts2')
    reg = Registry.load(DEFAULT_ROOT)
    graph = build_supervisor(reg, agents([]), checkpointer=MemorySaver(), gate=False)
    versions = iter(['v1', 'v2'])
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version=lambda: next(versions),
            report=lambda job, line: sent.append(line),
            parse_order=order_of,
        )
    )
    w.tick()
    w.tick()
    assert q.get('A1').harness_version == 'v1'
    assert q.get('A2').harness_version == 'v2'


def test_dry_run_False로_주입하면_state에_반영된다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)
    seen = {}
    real_invoke = w.d.graph.invoke

    def spy(state, config):
        seen['dry_run'] = state.get('dry_run') if isinstance(state, dict) else None
        return real_invoke(state, config)

    w.d.graph.invoke = spy  # type: ignore[method-assign]
    w.d.dry_run = False
    w.tick()

    assert seen['dry_run'] is False


def test_승인_요청은_approval_report로_나간다(setup):
    # 리뷰 지적 — Critical 1: 승인 대기는 평문이 아니라 버튼을 달 수 있는 콜백으로 나간다
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    asked: list[tuple[str, str, str]] = []
    w.d.approval_report = lambda job, order_no, stage, summary: asked.append(
        (order_no, stage, summary)
    )
    w.tick()
    assert len(asked) == 1
    order_no, stage, summary = asked[0]
    assert (order_no, stage) == ('A1', 'pay')
    assert '승인 요청' in summary
    # 평문 보고로 중복해서 나가지 않는다
    assert not any('승인 요청' in s for s in sent)


def test_approval_report가_없으면_평문_보고로_떨어진다(setup):
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    make(gate=True).tick()
    assert any('승인 요청' in s for s in sent)


def test_결제_중_죽어도_재시작_뒤_결제를_다시_하지_않는다(tmp_path):
    # 리뷰 지적 — Critical 2: 폰 승인이 나간 뒤 프로세스가 죽어도 재결제 경로가 없어야 한다
    reg = Registry.load(DEFAULT_ROOT)
    path = tmp_path / 'jobs.sqlite'
    q = JobQueue(path)
    q.enqueue('A1', 'U1', {}, 'ts1')
    paid = {'n': 0}

    def dying_payer(_a):
        paid['n'] += 1
        raise KeyboardInterrupt('폰 승인 직후 프로세스 급사')

    log: list[str] = []
    w = Worker(
        WorkerDeps(
            queue=q, graph=None, version='vtest', report=lambda j, s: None, parse_order=order_of
        )
    )
    graph = build_supervisor(
        reg,
        agents(log) | {'payer': dying_payer},
        checkpointer=MemorySaver(),
        gate=False,
        on_stage_start=w.mark_stage,  # 결제 진입을 큐에 적는 배선
    )
    w.d.graph = graph
    with pytest.raises(KeyboardInterrupt):
        w.tick()

    restarted = JobQueue(path)  # 프로세스 재시작
    assert restarted.get('A1').state == 'needs_human'
    w2 = Worker(
        WorkerDeps(
            queue=restarted,
            graph=graph,
            version='vtest',
            report=lambda j, s: None,
            parse_order=order_of,
        )
    )
    assert w2.tick() is None  # 집을 게 없다 — payer 가 다시 불리지 않는다
    assert paid['n'] == 1


def test_실행마다_추적_이벤트를_남긴다(tmp_path):
    # 리뷰 지적 — I3: Observe 가 실행 경로에 배선돼 있어야 gate 의 observe 조건이 선다
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    q.enqueue('A1', 'U1', {}, 'ts1')
    events = EventLog(tmp_path / 'events.sqlite')
    graph = build_supervisor(reg, agents([]), checkpointer=MemorySaver(), gate=False)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda j, s: None,
            parse_order=order_of,
            events=events,
            env='dev',
            prompt_commit='c0ffee',
        )
    )
    job = w.tick()
    rows = events.of_job(job.id)
    assert rows, '실행 경로에서 이벤트가 하나도 남지 않았다'
    assert _observe_ok(rows, version='vtest')


def test_이벤트_정리를_기동_시_1회와_주기마다_부른다(setup):
    # 리뷰 지적 — Minor: EventLog.prune() 을 아무도 부르지 않았다
    _q, _log, _sent, make = setup
    w = make(gate=False)
    calls = {'n': 0}

    def prune() -> int:
        calls['n'] += 1
        return 0

    w.d.prune = prune
    w.d.prune_interval_s = 0.0  # 매 주기 확인
    ticks = iter([False, False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)
    assert calls['n'] == 3  # 기동 1회 + 주기 2회


def test_이벤트_정리_주기가_안_됐으면_다시_부르지_않는다(setup):
    _q, _log, _sent, make = setup
    w = make(gate=False)
    calls = {'n': 0}
    w.d.prune = lambda: calls.__setitem__('n', calls['n'] + 1) or 0
    w.d.prune_interval_s = 3600.0
    ticks = iter([False, False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)
    assert calls['n'] == 1  # 기동 시 1회뿐


def test_이벤트_정리가_실패해도_고리는_계속_돈다(setup):
    _q, _log, _sent, make = setup
    w = make(gate=False)

    def boom() -> int:
        raise RuntimeError('디스크 오류')

    w.d.prune = boom
    ticks = iter([False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)  # 예외가 새지 않는다


def test_주문_조회가_실패하면_running으로_남기지_않고_사람에게_넘긴다(setup):
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)

    def bad_lookup(_job):
        raise ValueError('허용 목록 밖 도구: run_script (hong@example.com)')

    w.d.parse_order = bad_lookup  # type: ignore[method-assign]
    job = w.tick()

    assert job is not None
    assert job.state == 'needs_human'
    assert '주문 조회 실패' in (q.get('A1').error or '')
    assert all('hong@example.com' not in s for s in sent)


def test_같은_주문을_다시_접수하면_끝난_스레드를_지우고_새로_돈다(setup):
    q, _log, _sent, make = setup
    w = make(gate=False)
    wiped: list[str] = []
    w.d.reset_thread = wiped.append
    q.enqueue('A1', 'U1', {}, 'ts1')
    assert w.tick().state == 'done'
    # 끝난 주문을 다시 접수하면 같은 행(id) 이 되살아난다 — 스레드도 같다
    job, fresh = q.enqueue('A1', 'U1', {}, 'ts2')
    assert fresh and job.id == 1
    assert w.tick().state == 'done'
    assert wiped == ['job:1', 'job:1']


def test_승인_대기로_멈춘_스레드는_지우지_않는다(setup):
    q, _log, _sent, make = setup
    w = make(gate=True)
    wiped: list[str] = []
    w.d.reset_thread = wiped.append
    q.enqueue('A1', 'U1', {}, 'ts1')
    assert w.tick().state == 'needs_human'
    assert '승인 대기' in q.get('A1').step
    wiped.clear()
    w._reset_finished_thread(1)  # 다음 노드(승인 뒤 결제)가 남아 있다
    assert wiped == []
