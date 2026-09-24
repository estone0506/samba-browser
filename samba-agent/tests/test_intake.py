# 자동 수집 — 중복 거절 / 미지원 소싱처 / 일시정지 / 삼바웨이브 오류 / 오래된 것부터
from datetime import UTC, datetime, timedelta

import pytest

from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.queue.db import JobQueue
from samba_agent.queue.intake import Intake, intake_line
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.wave.client import WaveError, WaveOrder

NOW = datetime(2026, 9, 23, 9, 0, tzinfo=UTC)


def wave_order(order_no: str, *, source: str = 'MUSINSA', minutes: int = 0, **over) -> WaveOrder:
    """미이행 주문 1건. 개인정보는 애초에 이 모델에 없다."""
    return WaveOrder(
        order_number=order_no,
        source_site=source,
        product_name=over.pop('product_name', '나이키 덩크 로우'),
        product_option=over.pop('product_option', '270'),
        quantity=over.pop('quantity', 1),
        paid_at=NOW - timedelta(minutes=minutes),
        **over,
    )


class _FakeWave:
    """WaveClient 중 intake 가 쓰는 메서드 하나만 흉내 낸다."""

    def __init__(self, orders, error: WaveError | None = None) -> None:
        self.orders = orders
        self.error = error
        self.calls: list[int] = []

    def pending_orders(self, days: int = 7, limit: int = 100):
        self.calls.append(days)
        if self.error is not None:
            raise self.error
        return list(self.orders)


class _Slack:
    """post_new / post 두 통로만 기록한다."""

    def __init__(self, ts: str | None = 'ts') -> None:
        self._ts = ts
        self.tops: list[str] = []
        self.lines: list[tuple[str | None, str]] = []
        self._n = 0

    def post_new(self, text: str) -> str | None:
        self.tops.append(text)
        self._n += 1
        return f'{self._ts}{self._n}' if self._ts else None

    def post_line(self, thread_ts, text) -> bool:
        self.lines.append((thread_ts, text))
        return True


@pytest.fixture()
def setup(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()

    def make(orders, error=None, days=7):
        wave = _FakeWave(orders, error)
        return (
            Intake(wave, q, reg, slack.post_new, slack.post_line, days=days),
            wave,
        )

    return q, slack, make


def test_새_주문마다_최상위_메시지_하나와_큐_한_행(setup):
    q, slack, make = setup
    intake, wave = make([wave_order('A1'), wave_order('A2')])
    report = intake.run_once()
    assert (report.seen, report.enqueued, report.unsupported) == (2, 2, 0)
    assert wave.calls == [7]
    assert len(slack.tops) == 2
    assert slack.tops[0].startswith('접수: A1 · MUSINSA · 나이키 덩크 로우 [270] · 1개')
    assert q.get('A1').thread_ts == 'ts1'
    assert q.get('A1').requester == 'intake'
    assert q.get('A2').state == 'queued'


def test_이미_큐에_살아있는_주문은_건너뛴다(setup):
    q, slack, make = setup
    q.enqueue('A1', 'U1', {}, 'ts0')
    intake, _w = make([wave_order('A1'), wave_order('A2')])
    report = intake.run_once()
    assert (report.seen, report.enqueued, report.skipped_live) == (2, 1, 1)
    assert slack.tops == [intake_line(wave_order('A2').to_order_ref())]
    assert q.get('A1').thread_ts == 'ts0'  # 남의 스레드를 덮어쓰지 않는다


def test_같은_주문이_두_번_실려_와도_한_번만_접수한다(setup):
    _q, slack, make = setup
    intake, _w = make([wave_order('A1'), wave_order('A1')])
    report = intake.run_once()
    assert (report.enqueued, report.skipped_live) == (1, 1)
    assert len(slack.tops) == 1


@pytest.mark.parametrize('state', ['needs_human', 'failed', 'cancelled', 'done'])
def test_큐에_한_번_들어온_주문은_어떤_상태든_다시_접수하지_않는다(setup, state):
    # 사람 확인 대기 건이 매 주기 되살아나 무한 반복되면 안 된다 — 다시 돌리는 건 슬랙 `이어서`
    q, slack, make = setup
    job, _ = q.enqueue('A1', 'U1', {}, 'ts0')
    if state == 'cancelled':
        q.cancel('A1')
    else:
        q.finish(job.id, state)
    intake, _w = make([wave_order('A1')])
    report = intake.run_once()
    assert (report.enqueued, report.skipped_live) == (0, 1)
    assert q.get('A1').state == state
    assert slack.tops == []


def test_한_바퀴에_새로_접수하는_건수는_상한이_있다(setup):
    _q, slack, make = setup
    intake, _w = make([wave_order(f'A{i}') for i in range(8)])
    report = intake.run_once()
    assert report.enqueued == 5 and len(slack.tops) == 5
    # 다음 바퀴에 나머지를 받는다
    assert intake.run_once().enqueued == 3


def test_미지원_소싱처는_접수_뒤_바로_사람에게_넘긴다(setup):
    q, slack, make = setup
    # KREAM 은 sources.yaml 에서 hold — 등록부에 구매 에이전트가 없다
    intake, _w = make([wave_order('K1', source='KREAM'), wave_order('S1', source='SNKRDUNK')])
    report = intake.run_once()
    assert (report.enqueued, report.unsupported) == (0, 2)
    assert q.get('K1').state == 'needs_human'
    assert q.get('K1').error == 'unsupported: KREAM'
    assert len(slack.lines) == 2  # 스레드마다 한 줄씩만
    assert slack.lines[0][0] == 'ts1'
    assert 'KREAM' in slack.lines[0][1]


def test_일시정지하면_삼바웨이브를_부르지도_않는다(setup):
    _q, slack, make = setup
    intake, wave = make([wave_order('A1')])
    intake.pause()
    assert intake.paused is True
    assert intake.run_once() == intake.run_once().__class__()
    assert wave.calls == [] and slack.tops == []
    intake.resume()
    assert intake.run_once().enqueued == 1


def test_삼바웨이브_오류는_다음_주기로_미룬다(setup):
    q, slack, make = setup
    intake, _w = make([], error=WaveError(FailReason.BRIDGE_DOWN, '연결 실패'))
    report = intake.run_once()
    assert report.seen == 0 and report.enqueued == 0
    assert slack.tops == [] and q.live() == []


def test_결제가_오래된_주문부터_접수한다(setup):
    _q, slack, make = setup
    intake, _w = make(
        [wave_order('NEW', minutes=1), wave_order('OLD', minutes=600), wave_order('NONE')]
    )
    intake.run_once()
    posted = [t.split(' · ')[0] for t in slack.tops]
    assert posted[0].endswith('OLD') and posted[1].endswith('NEW')
    assert posted[2].endswith('NONE')  # 결제 시각이 없는 건은 맨 뒤


def test_슬랙이_없으면_스레드_없이_큐에만_쌓인다(tmp_path):
    q = JobQueue(tmp_path / 'jobs.sqlite')
    reg = Registry.load(DEFAULT_ROOT)
    slack = _Slack(ts=None)
    intake = Intake(_FakeWave([wave_order('A1')]), q, reg, slack.post_new, slack.post_line, days=7)
    assert intake.run_once().enqueued == 1
    assert q.get('A1').thread_ts is None


def test_run_forever_는_멈춤_신호에서_끝난다(setup):
    _q, _slack, make = setup
    intake, wave = make([wave_order('A1')])
    calls = {'n': 0}

    def stop() -> bool:
        calls['n'] += 1
        return calls['n'] > 2

    intake.run_forever(stop, interval_s=0)
    assert wave.calls  # 최소 한 바퀴는 돌았다


def test_접수_문구에는_개인정보가_없다():
    line = intake_line(wave_order('A1').to_order_ref())
    assert '접수: A1' in line
    for personal in ('010', '서울', '님'):
        assert personal not in line


def test_플래그가_있으면_접수_문구에_덧붙인다():
    line = intake_line(wave_order('A1', action_tag='no_price,staff_b').to_order_ref())
    assert line.endswith(' · ⚠ 가격X, 직원B')
    assert '⚠' not in intake_line(wave_order('A2').to_order_ref())


def test_플래그가_있어도_제외하지_않고_접수한다(setup):
    # 가격X·재고X·구매보류·다른 작업자는 오류일 수 있다 — 접수·구매는 진행하고 결제 승인에서 본다
    q, slack, make = setup
    intake, _w = make([wave_order('A1', action_tag='no_stock,staff_a')])
    report = intake.run_once()
    assert report.enqueued == 1
    assert q.get('A1').state == 'queued'
    assert '재고X, 직원A' in slack.tops[0]


def test_수집_범위는_소싱처와_포이즌_판매만():
    from samba_agent.queue.intake import Intake
    from samba_agent.wave.client import WaveOrder

    it = Intake.__new__(Intake)
    it._sources = frozenset({'MUSINSA', '29CM'})
    it._poison_only = True
    it._all_sellers = frozenset()

    def o(site, seller):
        return WaveOrder.model_validate({'order_number': 'X', 'source_site': site, 'seller': seller})

    assert it._in_scope(o('MUSINSA', 'poison(a@b.com)'))
    assert it._in_scope(o('29CM', '포이즌'))
    assert not it._in_scope(o('ABCmart', 'poison'))
    assert not it._in_scope(o('MUSINSA', '쿠팡(seller02)'))


def test_무신사는_판매처와_무관하게_이행한다():
    from samba_agent.queue.intake import Intake
    from samba_agent.wave.client import WaveOrder

    it = Intake.__new__(Intake)
    it._sources = frozenset({'MUSINSA', '29CM'})
    it._poison_only = True
    it._all_sellers = frozenset()
    it._all_sellers = frozenset({'MUSINSA'})

    def o(site, seller):
        return WaveOrder.model_validate({'order_number': 'X', 'source_site': site, 'seller': seller})

    assert it._in_scope(o('MUSINSA', '쿠팡(seller02)'))
    assert it._in_scope(o('29CM', 'poison'))
    assert not it._in_scope(o('29CM', '롯데홈쇼핑'))
