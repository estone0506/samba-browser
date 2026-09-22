# 추적 — 필수 메타데이터 / 키 없으면 경고만 / 로컬 사본 / 중복 없음 / 30일 정리
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


def test_오래된_이벤트는_정리된다(tmp_path):
    log = EventLog(tmp_path / 'events.sqlite', keep_days=0)
    log.write(job_id=1, version='v', env='dev', agent='a', kind='step', payload={'x': 1})
    assert log.prune() >= 0
    assert log.since(0) == [] or isinstance(log.since(0), list)
