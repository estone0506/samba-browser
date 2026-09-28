# 입력 작업자 — 읽기 → (필요하면) 쓰기 → 되읽기. 덮어쓰지 않고, 한 번에 한 건만
from pathlib import Path

import pytest

from samba_agent.export.adapters import AdapterReject, AdapterRetry, CellValues
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker


class FakeAdapter:
    """메모리 위의 주문 표. 실제 화면 대신 쓴다."""

    def __init__(self, rows: dict[str, CellValues] | None = None) -> None:
        self.rows = dict(rows or {})
        self.calls: list[str] = []
        self.read_error: Exception | None = None
        self.write_error: Exception | None = None
        # 쓰기가 값을 다르게 저장하는 고장(되읽기 불일치 시험용)
        self.corrupt = False

    def read(self, order_no: str) -> CellValues:
        self.calls.append(f'read {order_no}')
        if self.read_error is not None:
            raise self.read_error
        if order_no not in self.rows:
            raise AdapterReject(ExportFail.NOT_FOUND, f'{order_no} 없음')
        return self.rows[order_no]

    def write(self, order_no: str, cost: int, shipping_fee: int) -> None:
        self.calls.append(f'write {order_no} {cost} {shipping_fee}')
        if self.write_error is not None:
            raise self.write_error
        self.rows[order_no] = CellValues(cost + 1 if self.corrupt else cost, shipping_fee)


EMPTY = CellValues(None, None)


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


def worker(queue, adapter, idle: float = 999.0, **kw) -> ExportWorker:
    return ExportWorker(queue, {'emp': adapter}, user_idle_s=lambda: idle, **kw)


def test_빈_셀에_기입하고_되읽어_확인한다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out is not None
    assert out.id == req.id
    assert out.status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)
    assert adapter.calls == ['read A1', 'write A1 62470 2300', 'read A1']


def test_0_은_빈_셀로_본다(queue):
    adapter = FakeAdapter({'A1': CellValues(0, 0)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter).run_once().status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)


def test_이미_같은_값이면_입력하지_않는다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, 2300)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert adapter.calls == ['read A1']
    assert '이미' in (out.detail or '')


def test_배송비_0_과_빈_셀은_같은_값이다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, None)})
    queue.enqueue('A1', 'emp', 62470, 0)
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert adapter.calls == ['read A1']


def test_한쪽만_비어_있으면_기입한다(queue):
    adapter = FakeAdapter({'A1': CellValues(None, 2300)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter).run_once().status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)


@pytest.mark.parametrize(
    'current', [CellValues(50000, 2300), CellValues(62470, 3000), CellValues(50000, None)]
)
def test_다른_값이_있으면_덮어쓰지_않는다(queue, current):
    adapter = FakeAdapter({'A1': current})
    queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'value_conflict'
    assert adapter.rows['A1'] == current
    assert adapter.calls == ['read A1']


def test_되읽은_값이_다르면_실패하고_재시도하지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.corrupt = True
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'verify_mismatch'
    assert w.run_once() is None  # 다시 집히지 않는다


def test_주문이_없으면_실패하고_재시도하지_않는다(queue):
    adapter = FakeAdapter({})
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'not_found'
    assert w.run_once() is None


def test_창이_없으면_나중에_다시_한다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.read_error = AdapterRetry(ExportFail.WINDOW_MISSING, 'EMP 창 없음')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0)
    out = w.run_once()
    assert out.status == 'pending'
    assert out.fail_reason == 'window_missing'
    adapter.read_error = None
    assert w.run_once().status == 'done'


def test_재시도_한도를_넘으면_실패로_끝낸다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.read_error = AdapterRetry(ExportFail.BLOCKED, '인증 대화상자')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0, max_attempts=3)
    assert w.run_once().status == 'pending'
    assert w.run_once().status == 'pending'
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'blocked'
    assert out.attempts == 3
    assert '재시도' in (out.detail or '')


def test_쓰기_도중_모르는_오류는_재시도하지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.write_error = RuntimeError('알 수 없는 오류')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'unknown'
    assert w.run_once() is None


def test_사람이_쓰는_중이면_집지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter, idle=3.0).run_once() is None
    assert queue.get(req.id).status == 'pending'
    assert queue.get(req.id).attempts == 0
    assert adapter.calls == []


def test_어댑터가_없는_대상은_집지_않는다(queue):
    req = queue.enqueue('A1', 'shopmine', 62470, 2300)
    assert worker(queue, FakeAdapter({'A1': EMPTY})).run_once() is None
    assert queue.get(req.id).status == 'pending'


def test_어댑터가_하나도_없으면_아무것도_하지_않는다(queue):
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = ExportWorker(queue, {}, user_idle_s=lambda: 999.0)
    assert w.run_once() is None


def test_한_번에_한_건만_처리한다(queue):
    adapter = FakeAdapter({'A1': EMPTY, 'A2': EMPTY})
    queue.enqueue('A1', 'emp', 1000, 0)
    queue.enqueue('A2', 'emp', 2000, 0)
    w = worker(queue, adapter)
    assert w.run_once().order_no == 'A1'
    assert adapter.rows['A2'] == EMPTY
    assert w.run_once().order_no == 'A2'
    assert w.run_once() is None


def test_run_forever_는_생존_표시를_남기고_멈춘다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, False, True])
    slept: list[float] = []
    worker(queue, adapter).run_forever(lambda: next(stops), poll_s=3.0, sleep=slept.append)
    assert queue.alive('emp') is True
    assert queue.find('A1', 'emp').status == 'done'
    assert slept == [3.0]  # 첫 바퀴는 일을 했으니 쉬지 않고, 둘째 바퀴는 할 일이 없어 쉰다


def test_run_forever_는_사람이_바쁘면_생존_표시도_남기지_않는다(queue):
    # 리뷰 지적 — I4 (a): alive() 는 '처리 가능'이 아니라 '살아 있음'이다 — 집을 수 없을 때
    # beat 를 남기면 export 단계가 alive() 만 보고 기다려 주문마다 대기 시간을 통째로 쓴다
    adapter = FakeAdapter({'A1': EMPTY})
    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, True])
    slept: list[float] = []
    worker(queue, adapter, idle=3.0).run_forever(
        lambda: next(stops), poll_s=3.0, sleep=slept.append
    )
    assert queue.alive('emp') is False
    assert queue.find('A1', 'emp').status == 'pending'  # 바빠서 집지도 않았다


def test_run_forever_는_고리_오류로_죽지_않는다(queue):
    class Broken(FakeAdapter):
        def read(self, order_no: str) -> CellValues:
            raise AdapterRetry(ExportFail.TIMEOUT, '응답 없음')

    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, True])
    worker(queue, Broken(), retry_delay_s=0).run_forever(lambda: next(stops), sleep=lambda _s: None)
    assert queue.find('A1', 'emp').status == 'pending'
