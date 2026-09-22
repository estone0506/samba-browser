# 실행기 — 1건 처리 / 승인 대기 / 재개 / 거부 / 중복 요청 / 브릿지 죽음
import pytest
from langgraph.checkpoint.memory import MemorySaver

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
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
