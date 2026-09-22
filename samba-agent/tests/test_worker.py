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
    # queue/db.py(Task 9) 는 harness_version 을 저장하는 메서드를 아직 제공하지 않는다 —
    # 실행기는 대신 보고 문구에 버전을 남긴다(아래 assert).
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
