# 진단 표 — 에이전트별 실패율 / 상위 사유 / 재시도 / 소요 / 직전 대비 / 빈 기간
import pytest

from samba_agent.ops.diagnose import diagnose
from samba_agent.ops.events import EventLog


@pytest.fixture()
def events(tmp_path) -> EventLog:
    log = EventLog(tmp_path / 'events.sqlite')
    for i in range(8):
        log.write(
            job_id=i,
            version='v1',
            env='prod',
            agent='buyer.musinsa',
            kind='agent',
            payload={'ok': True, 'duration_ms': 1000 + i, 'status': 'ok'},
        )
    for i in range(2):
        log.write(
            job_id=100 + i,
            version='v1',
            env='prod',
            agent='buyer.musinsa',
            kind='agent',
            payload={
                'ok': False,
                'duration_ms': 5000,
                'status': 'fail',
                'fail_reason': 'out_of_stock',
                'retries': 1,
                'link': f'https://smith/{i}',
            },
        )
    log.write(
        job_id=200,
        version='v1',
        env='prod',
        agent='payer',
        kind='agent',
        payload={
            'ok': False,
            'duration_ms': 3000,
            'status': 'needs_human',
            'fail_reason': 'captcha',
        },
    )
    return log


def test_에이전트별_실패율과_상위_사유(events):
    d = diagnose(events, version='v1', since_days=7)
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.runs == 10
    assert buyer.failures == 2
    assert buyer.fail_rate == pytest.approx(0.2)
    assert buyer.top_reason == 'out_of_stock'
    assert buyer.retries == 1
    assert buyer.example_links  # 실패 예시 링크가 있다


def test_결제_에이전트_줄도_나온다(events):
    d = diagnose(events, version='v1', since_days=7)
    payer = next(r for r in d.rows if r.agent == 'payer')
    assert payer.top_reason == 'captcha'


def test_소요_분포가_계산된다(events):
    buyer = next(r for r in diagnose(events, version='v1').rows if r.agent == 'buyer.musinsa')
    assert buyer.p50_ms < buyer.p95_ms


def test_직전_버전_대비_차이(events):
    d = diagnose(events, version='v1', previous={'buyer.musinsa': 0.1})
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.delta_vs_prev == pytest.approx(0.1)  # 0.2 - 0.1


def test_검수_큐_미처리가_표에_실린다(events):
    d = diagnose(events, version='v1', review_queue_pending=3)
    assert '검수 큐 미처리: 3' in d.to_markdown()


def test_기록이_없으면_빈_표를_준다(tmp_path):
    d = diagnose(EventLog(tmp_path / 'e.sqlite'), version='v9')
    assert d.rows == ()
    assert '기록 없음' in d.to_markdown()


def test_마크다운_표에_모든_열이_있다(events):
    md = diagnose(events, version='v1').to_markdown()
    for head in ('에이전트', '실행', '실패율', '상위 사유', '재시도', 'p50', 'p95'):
        assert head in md


# --- 추가: 실패 케이스(이벤트 없음 / 손상된 payload / 모르는 사유 값) ---


def test_다른_버전_이벤트만_있으면_빈_표(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v0',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={'ok': True, 'duration_ms': 100, 'status': 'ok'},
    )
    d = diagnose(log, version='v1')
    assert d.rows == ()


def test_모르는_실패_사유는_문자열_그대로_집계된다(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={
            'ok': False,
            'duration_ms': 100,
            'status': 'fail',
            'fail_reason': 'totally_unknown_value',
        },
    )
    d = diagnose(log, version='v1')
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.top_reason == 'totally_unknown_value'


def test_fail_reason_없는_실패는_unknown으로_집계된다(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={'ok': False, 'duration_ms': 100, 'status': 'fail'},
    )
    d = diagnose(log, version='v1')
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.top_reason == 'unknown'


def test_kind가_agent가_아니면_집계에서_빠진다(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='tool',
        payload={'ok': True, 'duration_ms': 100},
    )
    d = diagnose(log, version='v1')
    assert d.rows == ()
