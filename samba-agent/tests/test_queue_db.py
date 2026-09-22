# 주문 큐 — 접수 / 중복 거절·병합 / 한 번에 1건 / 재시도 상한 / 취소 / 재시작 복구
import threading

import pytest

from samba_agent.queue.db import JobQueue


@pytest.fixture()
def q(tmp_path):
    return JobQueue(tmp_path / 'jobs.sqlite')


def test_접수하면_queued_다(q):
    job, created = q.enqueue('734501000740906', 'U1', {'card': '현대'}, 'ts1')
    assert created is True
    assert job.state == 'queued'
    assert job.options == {'card': '현대'}
    assert job.attempts == 0


def test_같은_주문_재요청은_거절하고_기존_건을_준다(q):
    first, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    again, created = q.enqueue('A1', 'U2', {}, 'ts2')
    assert created is False
    assert again.id == first.id
    assert again.requester == 'U1'  # 처음 사람이 임자다
    assert len(q.live()) == 1


def test_처리중인_주문도_재요청은_거절한다(q):
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    _, created = q.enqueue('A1', 'U2', {}, 'ts2')
    assert created is False


def test_끝난_주문은_같은_행을_되살린다(q):
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    q.finish(job.id, 'failed', error='out_of_stock')
    again, created = q.enqueue('A1', 'U2', {}, 'ts9')
    assert created is True
    assert again.id == job.id
    assert again.state == 'queued'
    assert again.thread_ts == 'ts9'


def test_한_번에_한_건만_집는다(q):
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.enqueue('A2', 'U1', {}, 'ts2')
    first = q.claim()
    assert first is not None and first.order_no == 'A1'
    assert q.claim() is None  # 손발이 하나라 동시에 못 돈다
    q.finish(first.id, 'done')
    second = q.claim()
    assert second is not None and second.order_no == 'A2'


def test_진행_상태를_기록한다(q):
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    q.progress(job.id, agent='buyer.musinsa', step='3/5 배송지')
    got = q.get('A1')
    assert got is not None
    assert (got.assignee_agent, got.step) == ('buyer.musinsa', '3/5 배송지')


def test_재시도는_상한을_넘지_못한다(q):
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    q.finish(job.id, 'needs_human', error='bridge_down')
    again = q.retry(job.id)
    assert (again.state, again.attempts) == ('queued', 1)
    q.claim()
    q.finish(job.id, 'needs_human', error='bridge_down')
    with pytest.raises(ValueError, match='재시도 상한'):
        q.retry(job.id)


def test_취소는_살아_있는_건만(q):
    q.enqueue('A1', 'U1', {}, 'ts1')
    cancelled = q.cancel('A1')
    assert cancelled is not None and cancelled.state == 'cancelled'
    assert q.cancel('A1') is None
    assert q.cancel('없는주문') is None


def test_재시작하면_running_은_queued_로_돌아온다(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    q1 = JobQueue(path)
    job, _ = q1.enqueue('A1', 'U1', {}, 'ts1')
    q1.claim()
    assert q1.get('A1').state == 'running'
    q2 = JobQueue(path)  # 실행기 재시작 — 끊긴 running 을 되살린다
    got = q2.get('A1')
    assert got.state == 'queued'
    assert got.id == job.id


def test_같은_주문을_두_연결이_동시에_접수해도_행은_하나(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    # 각 스레드가 자기 연결을 쓴다 — 실제 여러 프로세스/스레드가 동시에
    # enqueue 를 부를 때와 같은 조건으로 BEGIN IMMEDIATE 경합을 검증한다
    q1 = JobQueue(path)
    q2 = JobQueue(path)
    errors: list[BaseException] = []
    results: list[bool] = []

    def _enqueue(q: JobQueue, requester: str, thread_ts: str) -> None:
        try:
            _, created = q.enqueue('DUP1', requester, {}, thread_ts)
            results.append(created)
        except BaseException as exc:  # noqa: BLE001 — 스레드 예외를 모아서 검사한다
            errors.append(exc)

    t1 = threading.Thread(target=_enqueue, args=(q1, 'U1', 'ts1'))
    t2 = threading.Thread(target=_enqueue, args=(q2, 'U2', 'ts2'))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert errors == []
    assert sorted(results) == [False, True]  # 한쪽만 새로 만들고 한쪽은 거절
    assert len(q1.live()) == 1
