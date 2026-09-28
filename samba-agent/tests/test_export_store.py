# 외부 기입 큐 — 중복 방지 · 상태 전이 · 재시도 예약 · 작업자 생존 표시
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportConflict, ExportQueue


class Clock:
    """시험용 시계 — 마음대로 앞으로 돌린다."""

    def __init__(self) -> None:
        self.now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def forward(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture()
def clock() -> Clock:
    return Clock()


@pytest.fixture()
def queue(tmp_path: Path, clock: Clock) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite', clock=clock)


def test_새_요청은_pending_으로_들어간다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    assert (req.order_no, req.target, req.cost, req.shipping_fee) == ('A1', 'emp', 62470, 2300)
    assert req.status == 'pending'
    assert req.attempts == 0
    assert req.notified is False


def test_같은_요청은_새_행을_만들지_않는다(queue):
    first = queue.enqueue('A1', 'emp', 62470, 2300)
    second = queue.enqueue('A1', 'emp', 62470, 2300)
    assert second.id == first.id
    assert len(queue.recent()) == 1


def test_대상이_다르면_다른_요청이다(queue):
    a = queue.enqueue('A1', 'emp', 62470, 2300)
    b = queue.enqueue('A1', 'shopmine', 62470, 2300)
    assert a.id != b.id


def test_done_인_요청과_값이_다른_재요청은_거절한다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    with pytest.raises(ExportConflict):
        queue.enqueue('A1', 'emp', 70000, 2300)
    assert queue.get(req.id).cost == 62470


def test_running_중에는_값을_바꿀_수_없다(queue):
    queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    with pytest.raises(ExportConflict):
        queue.enqueue('A1', 'emp', 70000, 2300)


def test_실패한_요청은_새_값으로_다시_넣을_수_있다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    queue.mark_notified(req.id)
    again = queue.enqueue('A1', 'emp', 70000, 2300)
    assert again.id == req.id
    assert again.status == 'pending'
    assert again.cost == 70000
    assert again.attempts == 0
    assert again.fail_reason is None
    assert again.notified is False


def test_claim_은_오래된_것부터_running_으로_바꾼다(queue, clock):
    first = queue.enqueue('A1', 'emp', 1000, 0)
    clock.forward(1)
    queue.enqueue('A2', 'emp', 2000, 0)
    got = queue.claim_next(['emp'])
    assert got is not None
    assert got.id == first.id
    assert got.status == 'running'
    assert got.attempts == 1


def test_claim_은_맡은_대상만_집는다(queue):
    queue.enqueue('A1', 'shopmine', 1000, 0)
    assert queue.claim_next(['emp']) is None
    assert queue.claim_next([]) is None
    assert queue.claim_next(['shopmine']) is not None


def test_재시도_예약은_시간이_지나야_다시_집힌다(queue, clock):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.retry_later(req.id, ExportFail.BUSY, '창 사용 중', delay_s=60)
    assert queue.get(req.id).status == 'pending'
    assert queue.get(req.id).fail_reason == 'busy'
    assert queue.claim_next(['emp']) is None
    clock.forward(61)
    got = queue.claim_next(['emp'])
    assert got is not None
    assert got.attempts == 2


def test_done_과_fail_은_결과를_남긴다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'emp', 2000, 0)
    queue.claim_next(['emp'])
    queue.done(a.id, '기입 완료')
    queue.claim_next(['emp'])
    queue.fail(b.id, ExportFail.VERIFY_MISMATCH, '되읽기 불일치')
    assert queue.get(a.id).status == 'done'
    assert queue.get(a.id).detail == '기입 완료'
    assert queue.get(a.id).fail_reason is None
    assert queue.get(b.id).status == 'failed'
    assert queue.get(b.id).fail_reason == 'verify_mismatch'


def test_죽은_작업자가_남긴_running_은_되돌린다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    queue.claim_next(['emp'])
    queue.claim_next(['shopmine'])
    assert queue.recover_running(['emp']) == 1
    assert queue.get(a.id).status == 'pending'
    assert queue.get(b.id).status == 'running'


def test_requeue_는_실패한_요청만_되살린다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    assert queue.requeue('A1', 'emp') is None  # pending 은 건드리지 않는다
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    again = queue.requeue('A1', 'emp')
    assert again is not None
    assert again.status == 'pending'
    assert again.attempts == 0
    assert queue.requeue('A9', 'emp') is None


def test_wait_는_끝난_요청을_바로_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    slept: list[float] = []
    out = queue.wait(req.id, 10, sleep=slept.append)
    assert out.status == 'done'
    assert slept == []


def test_wait_는_기다리는_동안_끝나면_결과를_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)

    def sleep(_s: float) -> None:
        queue.claim_next(['emp'])
        queue.done(req.id, '기입 완료')

    ticks = iter([0.0, 0.0, 1.0, 2.0])
    out = queue.wait(req.id, 10, sleep=sleep, monotonic=lambda: next(ticks))
    assert out.status == 'done'


def test_wait_는_시간이_지나면_pending_그대로_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    ticks = iter([0.0, 5.0, 11.0])
    slept: list[float] = []
    out = queue.wait(req.id, 10, sleep=slept.append, monotonic=lambda: next(ticks))
    assert out.status == 'pending'
    assert slept == [1.0]


def test_wait_시간이_0_이면_한_번만_본다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    slept: list[float] = []
    out = queue.wait(req.id, 0, sleep=slept.append)
    assert out.status == 'pending'
    assert slept == []


def test_알림_대상은_알리지_않은_실패뿐이다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'emp', 2000, 0)
    queue.enqueue('A3', 'emp', 3000, 0)
    queue.claim_next(['emp'])
    queue.fail(a.id, ExportFail.NOT_FOUND, '주문 없음')
    queue.claim_next(['emp'])
    queue.done(b.id, '기입 완료')
    assert [r.id for r in queue.unnotified_failed()] == [a.id]
    queue.mark_notified(a.id)
    assert queue.unnotified_failed() == []


def test_작업자_생존_표시는_시간이_지나면_꺼진다(queue, clock):
    assert queue.alive('emp') is False
    queue.beat(['emp'])
    assert queue.alive('emp') is True
    assert queue.alive('shopmine') is False
    clock.forward(31)
    assert queue.alive('emp') is False


def test_두_연결이_같은_파일을_본다(tmp_path: Path, clock):
    path = tmp_path / 'exports.sqlite'
    harness = ExportQueue(path, clock=clock)
    worker = ExportQueue(path, clock=clock)
    req = harness.enqueue('A1', 'emp', 1000, 0)
    got = worker.claim_next(['emp'])
    assert got is not None
    worker.done(got.id, '기입 완료')
    assert harness.get(req.id).status == 'done'


def test_없는_요청을_찾으면_KeyError(queue):
    with pytest.raises(KeyError):
        queue.get(999)
    assert queue.find('A1', 'emp') is None
