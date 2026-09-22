# 추적 — 필수 메타데이터 / 키 없으면 경고만 / 로컬 사본 / 중복 없음 / 30일 정리
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from samba_agent.ops.events import EventLog
from samba_agent.ops.tracing import REQUIRED_METADATA, configure_tracing, run_metadata, traced
from samba_agent.settings import Settings


def test_키가_없으면_경고만_하고_계속_돈다(caplog):
    s = Settings(SAMBA_BRIDGE_TOKEN='a' * 64, LANGSMITH_API_KEY=None)
    assert configure_tracing(s) is False
    assert any('LangSmith' in r.message for r in caplog.records)


def test_필수_메타데이터가_전부_있다():
    md = run_metadata(
        job_id=1,
        order_no='A1',
        source='무신사',
        requester='U1',
        agent='buyer.musinsa',
        version='vtest',
        env='dev',
        prompt_commit='c1',
    )
    assert set(REQUIRED_METADATA) <= set(md)
    assert md['harness_version'] == 'vtest'


def test_로컬_사본이_남고_개인정보는_가려진다(tmp_path):
    log = EventLog(tmp_path / 'events.sqlite')

    @traced('buy', metadata={'job_id': '1'}, events=log)
    def step() -> str:
        return '수취인 홍길동 010-1234-5678'

    step()
    rows = log.of_job(1)
    assert len(rows) == 1
    assert '홍길동' not in str(rows[0])
    assert '010-1234' not in str(rows[0])


def test_같은_호출이_두_번_기록되지_않는다(tmp_path):
    log = EventLog(tmp_path / 'events.sqlite')

    @traced('buy', metadata={'job_id': '1'}, events=log)
    def step() -> str:
        return 'ok'

    step()
    step()
    assert len(log.of_job(1)) == 2  # 호출 2번 = 이벤트 2건. 한 호출이 두 줄이 되지는 않는다


def test_예외_메시지도_마스킹되어_전파되고_기록된다(tmp_path):
    log = EventLog(tmp_path / 'events.sqlite')

    @traced('buy', metadata={'job_id': '1'}, events=log)
    def step() -> str:
        raise ValueError('연락처 010-1234-5678 로 연결 실패')

    with pytest.raises(ValueError) as exc_info:
        step()

    # 전파된 예외 메시지에는 전화번호가 없고, 원래 예외가 원인(__cause__)으로 남는다.
    assert '010' not in str(exc_info.value)
    assert exc_info.value.__cause__ is not None

    rows = log.of_job(1)
    assert len(rows) == 1
    assert rows[0]['payload']['ok'] is False
    assert '010' not in str(rows[0])


def test_직렬화_불가_payload도_기록되고_쓰기_실패는_삼킨다(tmp_path):
    log = EventLog(tmp_path / 'events.sqlite')

    class Weird:
        """json.dumps 가 기본으로는 못 다루는 임의 객체."""

        def __str__(self) -> str:
            return 'weird-repr'

    log.write(
        job_id=1,
        version='v',
        env='dev',
        agent='a',
        kind='step',
        payload={'obj': Weird(), 'at': datetime.now(UTC), 'path': Path('x')},
    )

    rows = log.of_job(1)
    assert len(rows) == 1
    assert rows[0]['payload']['obj'] == 'weird-repr'


def test_오래된_이벤트는_정리된다(tmp_path, monkeypatch):
    """정책: DELETE 조건이 `at < cut` 이므로 경계(at == cut)는 지워지지 않고 남는다."""
    import samba_agent.ops.events as events_mod

    fixed_now = datetime(2026, 1, 31, tzinfo=UTC)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now

    monkeypatch.setattr(events_mod, 'datetime', _FixedDatetime)

    log = EventLog(tmp_path / 'events.sqlite', keep_days=30)
    cut = fixed_now - timedelta(days=30)
    rows = (
        (cut - timedelta(seconds=1), 'old'),  # cut 이전 — 지워진다
        (cut, 'boundary'),  # cut 과 같음 — 남는다
        (fixed_now, 'fresh'),  # cut 이후 — 남는다
    )
    for at, kind in rows:
        log._db.execute(
            'INSERT INTO events(at, job_id, version, env, agent, kind, payload) '
            'VALUES(?,?,?,?,?,?,?)',
            (at.isoformat(timespec='seconds'), 1, 'v', 'dev', 'a', kind, '{}'),
        )

    assert len(log.since(3650)) == 3

    deleted = log.prune()

    assert deleted == 1
    remaining_kinds = {row['kind'] for row in log.since(3650)}
    assert remaining_kinds == {'boundary', 'fresh'}
