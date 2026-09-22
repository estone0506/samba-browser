# 판정 — 6개 조건 / 승인 없으면 improve / 안전 0점이면 improve / 기록과 리포트
import pytest

from samba_agent.ops import gate as gate_mod
from samba_agent.ops.diagnose import Diagnosis
from samba_agent.ops.events import EventLog
from samba_agent.ops.gate import GATE_RULES, _observe_ok, evaluate_gate
from samba_agent.ops.releases import Release, ReleaseStore
from samba_agent.ops.tracing import REQUIRED_METADATA

GOOD_EVAL = {
    'version': 'v2',
    'gate_eligible': True,
    'datasets': {
        'ds.buyer.musinsa': {
            'count': 12,
            'scores': {
                'exact_match': 1.0,
                'cost_within_1pct': 1.0,
                'safety': 1.0,
                'reason_quality': 1.0,
                'no_regression': 1.0,
            },
        }
    },
}
EMPTY_DIAG = Diagnosis(version='v2', since_days=7, rows=(), review_queue_pending=0)

# `_observe_ok()` 가 요구하는 필수 메타데이터를 전부 채운 값 — 컬럼(4개) + payload.metadata(나머지)
_FULL_METADATA = {
    'harness_version': 'v2',
    'env': 'prod',
    'order_no': 'A1',
    'source': '무신사',
    'agent': 'buyer.musinsa',
    'requester': 'U1',
    'job_id': 1,
    'prompt_commit': 'c1',
}


def _event_row(*, version='v2', payload=None, **over):
    row = {
        'at': '2026-09-22T00:00:00+00:00',
        'job_id': 1,
        'version': version,
        'env': 'prod',
        'agent': 'buyer.musinsa',
        'kind': 'agent',
        'payload': payload if payload is not None else {'ok': True},
    }
    row.update(over)
    return row


def gate(**over):
    kwargs = {
        'version': 'v2',
        'eval_summary': GOOD_EVAL,
        'diagnosis': EMPTY_DIAG,
        'observe_ok': True,
        'dry_run_ok': True,
        'review_queue_blocking': 0,
        'approved_by': 'U1',
        'baseline': {'ds.buyer.musinsa': 1.0},
    }
    kwargs.update(over)
    return evaluate_gate(**kwargs)


def test_여섯_조건이_전부_참이면_promote():
    got = gate()
    assert got.verdict == 'promote'
    assert set(got.checks) == set(GATE_RULES)
    assert all(got.checks.values())


def test_승인이_없으면_무조건_improve():
    got = gate(approved_by=None)
    assert got.verdict == 'improve'
    assert got.checks['approval'] is False
    assert any('승인' in r for r in got.reasons)


def test_안전_점수가_100_이_아니면_improve():
    bad = {
        'version': 'v2',
        'gate_eligible': True,
        'datasets': {
            'ds.buyer.musinsa': {
                'count': 12,
                'scores': {
                    'exact_match': 1.0,
                    'cost_within_1pct': 1.0,
                    'safety': 0.9,
                    'reason_quality': 1.0,
                    'no_regression': 1.0,
                },
            }
        },
    }
    got = gate(eval_summary=bad)
    assert got.verdict == 'improve'
    assert got.checks['accuracy'] is False


def test_직전_운영보다_정확도가_떨어지면_improve():
    got = gate(
        baseline={'ds.buyer.musinsa': 1.0},
        eval_summary={
            'version': 'v2',
            'gate_eligible': True,
            'datasets': {
                'ds.buyer.musinsa': {
                    'count': 12,
                    'scores': {
                        'exact_match': 0.8,
                        'cost_within_1pct': 1.0,
                        'safety': 1.0,
                        'reason_quality': 1.0,
                        'no_regression': 1.0,
                    },
                }
            },
        },
    )
    assert got.verdict == 'improve'


def test_회귀가_있으면_improve():
    got = gate(
        eval_summary={
            'version': 'v2',
            'gate_eligible': True,
            'datasets': {
                'ds.buyer.musinsa': {
                    'count': 12,
                    'scores': {
                        'exact_match': 1.0,
                        'cost_within_1pct': 1.0,
                        'safety': 1.0,
                        'reason_quality': 1.0,
                        'no_regression': 0.5,
                    },
                }
            },
        }
    )
    assert got.checks['regression'] is False


def test_dry_run_과_검수_큐():
    assert gate(dry_run_ok=False).checks['dry_run'] is False
    assert gate(review_queue_blocking=2).checks['review_queue'] is False


def test_데이터셋이_10건_미만이면_accuracy가_막는다():
    # Task 15 리뷰 지적 7: 최소 건수(MIN_EXAMPLES)는 observe 가 아니라 accuracy 조건이다
    got = gate(
        eval_summary={
            'version': 'v2',
            'gate_eligible': True,
            'datasets': {
                'ds.buyer.musinsa': {
                    'count': 3,
                    'scores': {
                        'exact_match': 1.0,
                        'cost_within_1pct': 1.0,
                        'safety': 1.0,
                        'reason_quality': 1.0,
                        'no_regression': 1.0,
                    },
                }
            },
        }
    )
    assert got.verdict == 'improve'
    assert got.checks['observe'] is True  # observe 는 더 이상 데이터셋 건수를 보지 않는다
    assert got.checks['accuracy'] is False


def test_데이터셋이_비어있으면_accuracy가_막는다():
    got = gate(eval_summary={'version': 'v2', 'gate_eligible': True, 'datasets': {}})
    assert got.verdict == 'improve'
    assert got.checks['accuracy'] is False


def test_gate_eligible이_false면_promote가_나오지_않는다():
    # eval.py 는 아직 buyer.* 만 실제 에이전트라 참조 재생기 결과는 승격 근거가 못 된다
    bad = {
        'version': 'v2',
        'gate_eligible': False,
        'datasets': {
            'ds.buyer.musinsa': {
                'count': 12,
                'scores': {
                    'exact_match': 1.0,
                    'cost_within_1pct': 1.0,
                    'safety': 1.0,
                    'reason_quality': 1.0,
                    'no_regression': 1.0,
                },
            }
        },
    }
    got = gate(eval_summary=bad)
    assert got.verdict == 'improve'
    assert got.checks['accuracy'] is False


def test_gate_eligible_키가_없으면_기본값_False라서_promote가_나오지_않는다():
    # Task 15 리뷰 지적 3: 키가 없는 요약(직접 만든 요약 등)은 승격 근거가 못 된다 — 기본 False
    summary_without_key = {
        'version': 'v2',
        'datasets': {
            'ds.buyer.musinsa': {
                'count': 12,
                'scores': {
                    'exact_match': 1.0,
                    'cost_within_1pct': 1.0,
                    'safety': 1.0,
                    'reason_quality': 1.0,
                    'no_regression': 1.0,
                },
            }
        },
    }
    got = gate(eval_summary=summary_without_key)
    assert got.verdict == 'improve'
    assert got.checks['accuracy'] is False
    assert any('gate_eligible' in r for r in got.reasons)


def test_이전_운영_버전이_없으면_baseline_없이도_판정한다():
    # 첫 배포 — current_prod() 가 None 이라 baseline 도 None. 하락 비교를 생략하고 넘어간다
    got = gate(baseline=None)
    assert got.verdict == 'promote'
    assert got.checks['accuracy'] is True


# ── observe: 대상 버전 이벤트만 + 필수 메타데이터 + 마스킹(Task 15 리뷰 지적 1) ──


def test_observe_대상_버전에_이벤트가_없으면_거짓():
    other_version_rows = [_event_row(version='v1', payload={'metadata': _FULL_METADATA})]
    assert _observe_ok(other_version_rows, version='v2') is False


def test_observe_이벤트가_아예_없으면_거짓():
    assert _observe_ok([], version='v2') is False


def test_observe_필수_메타데이터와_마스킹이_다_괜찮으면_참():
    rows = [_event_row(payload={'metadata': _FULL_METADATA, 'ok': True})]
    assert _observe_ok(rows, version='v2') is True


def test_observe_필수_메타데이터가_하나라도_없으면_거짓():
    missing = dict(_FULL_METADATA)
    del missing['order_no']
    rows = [_event_row(payload={'metadata': missing, 'ok': True})]
    assert _observe_ok(rows, version='v2') is False


def test_observe_마스킹_누락_이벤트가_1건이면_거짓():
    # 요구사항 Critical 1: 마스킹 누락 이벤트 1건이면 observe=False → improve
    leaking = dict(_FULL_METADATA)
    rows = [
        _event_row(payload={'metadata': leaking, 'ok': True}),
        _event_row(payload={'metadata': leaking, 'ok': True, 'note': '연락처 010-1234-5678'}),
    ]
    assert _observe_ok(rows, version='v2') is False


def test_observe_거짓이면_gate_전체가_improve():
    got = gate(observe_ok=False)
    assert got.verdict == 'improve'
    assert got.checks['observe'] is False


def test_observe_필수_메타데이터_이름이_전부_커버된다():
    # _FULL_METADATA 픽스처가 REQUIRED_METADATA 를 빠짐없이 채우고 있는지 스스로 검증
    assert set(REQUIRED_METADATA) <= set(_FULL_METADATA)


def test_실험_요약_파일이_없으면_gate_가_죽지_않고_improve로_떨어진다(tmp_path, monkeypatch):
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    rc = gate_mod.main(['--version', 'v-no-summary'])
    assert rc == 0
    report = tmp_path / 'v-no-summary.md'
    assert report.exists()
    assert 'improve' in report.read_text(encoding='utf-8')


def test_실험_요약_파일이_손상돼도_gate_가_죽지_않고_improve로_떨어진다(tmp_path, monkeypatch):
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    (tmp_path / 'v-broken.eval.json').write_text('{이건 json 이 아니다', encoding='utf-8')
    rc = gate_mod.main(['--version', 'v-broken'])
    assert rc == 0
    report = tmp_path / 'v-broken.md'
    assert report.exists()
    assert 'improve' in report.read_text(encoding='utf-8')


# ── --version 새니타이즈(Task 15 리뷰 지적 6) ──


def test_version에_경로_구분자가_있으면_argparse_오류(tmp_path, monkeypatch):
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    with pytest.raises(SystemExit):
        gate_mod.main(['--version', '../evil'])


def test_version이_허용된_형식이면_통과한다(tmp_path, monkeypatch):
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    rc = gate_mod.main(['--version', 'v1.2.3_test-ok'])
    assert rc == 0


# ── --rollback: 직전 promote 버전 출력 + releases 에 'rollback' 행 기록(Task 15 리뷰 지적 2) ──


def test_rollback은_직전_promote_버전을_출력하고_releases에_기록한다(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    store = ReleaseStore(tmp_path / 'releases.sqlite')
    store.record(
        Release(
            version='v1',
            verdict='promote',
            decided_by='U1',
            decided_at='2026-09-22T10:00:00+00:00',
            report_path='ops/reports/v1.md',
            prompt_commits={},
        )
    )

    rc = gate_mod.main(['--version', 'v2', '--rollback'])

    assert rc == 0
    out = capsys.readouterr().out
    assert 'v1' in out

    history = store.history()
    assert history[0].verdict == 'rollback'
    assert history[0].version == 'v1'
    # 자동으로 태그를 옮기지 않는다 — current_prod() 는 여전히 마지막 promote(v1) 다
    assert store.current_prod().version == 'v1'


def test_rollback은_태그를_자동으로_옮기지_않는다_직전_promote가_없으면_요청한_버전을_남긴다(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))

    rc = gate_mod.main(['--version', 'v9', '--rollback'])

    assert rc == 0
    store = ReleaseStore(tmp_path / 'releases.sqlite')
    history = store.history()
    assert history[0].verdict == 'rollback'
    assert history[0].version == 'v9'
    assert store.current_prod() is None


# ── --plan: 실제 태그 이동 없이 "무엇을 바꿀지"만 출력(브리프 41행) ──


def test_plan은_실제_이동_없이_대상_버전과_현재_prod만_출력한다(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    store = ReleaseStore(tmp_path / 'releases.sqlite')
    store.record(
        Release(
            version='v1',
            verdict='promote',
            decided_by='U1',
            decided_at='2026-09-22T10:00:00+00:00',
            report_path='ops/reports/v1.md',
            prompt_commits={},
        )
    )

    rc = gate_mod.main(['--version', 'v2', '--plan'])

    assert rc == 0
    out = capsys.readouterr().out
    assert 'v2' in out
    assert 'v1' in out
    # 실제 이동을 하지 않았다 — releases 에 새 행이 남지 않는다(promote 기록 1건뿐)
    assert len(store.history()) == 1


def test_releases_에_기록하고_현재_운영을_읽는다(tmp_path):
    store = ReleaseStore(tmp_path / 'releases.sqlite')
    assert store.current_prod() is None
    store.record(
        Release(
            version='v1',
            verdict='promote',
            decided_by='U1',
            decided_at='2026-09-22T10:00:00+00:00',
            report_path='ops/reports/v1.md',
            prompt_commits={'payer': 'c1'},
        )
    )
    store.record(
        Release(
            version='v2',
            verdict='improve',
            decided_by='U1',
            decided_at='2026-09-22T11:00:00+00:00',
            report_path='ops/reports/v2.md',
            prompt_commits={},
        )
    )
    assert store.current_prod().version == 'v1'  # improve 는 운영이 아니다
    assert len(store.history()) == 2


def test_같은_버전을_두_번_기록해도_각각_남는다_중복_판정_허용(tmp_path):
    # releases 는 판정 이력이다 — 같은 버전을 다시 판정하면 새 행으로 쌓이고
    # current_prod() 는 가장 최근 promote 를 돌려준다(중복 판정 자체를 막지 않는다)
    store = ReleaseStore(tmp_path / 'releases.sqlite')
    store.record(
        Release(
            version='v1',
            verdict='improve',
            decided_by='U1',
            decided_at='2026-09-22T09:00:00+00:00',
            report_path='ops/reports/v1.md',
            prompt_commits={},
        )
    )
    store.record(
        Release(
            version='v1',
            verdict='promote',
            decided_by='U1',
            decided_at='2026-09-22T10:00:00+00:00',
            report_path='ops/reports/v1.md',
            prompt_commits={},
        )
    )
    assert len(store.history()) == 2
    assert store.current_prod().version == 'v1'
    assert store.current_prod().decided_at == '2026-09-22T10:00:00+00:00'


def test_release_verdict에_rollback도_기록된다(tmp_path):
    # Task 15 리뷰 지적(코디네이터 추가): Release.verdict Literal 에 'rollback' 추가
    store = ReleaseStore(tmp_path / 'releases.sqlite')
    store.record(
        Release(
            version='v1',
            verdict='rollback',
            decided_by='U1',
            decided_at='2026-09-22T10:00:00+00:00',
            report_path='-',
            prompt_commits={},
        )
    )
    history = store.history()
    assert len(history) == 1
    assert history[0].verdict == 'rollback'
    # rollback 은 태그를 옮기지 않았으므로 운영(prod)으로 치지 않는다
    assert store.current_prod() is None


def test_EventLog와_함께_돌아가는_observe_통합(tmp_path):
    # _observe_ok() 가 실제 EventLog.since() 가 돌려주는 행 구조와 맞는지 확인한다
    log = EventLog(tmp_path / 'events.sqlite')
    log.write(
        job_id=1,
        version='v2',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={'metadata': _FULL_METADATA, 'ok': True},
    )
    rows = log.since(30)
    assert _observe_ok(rows, version='v2') is True
    assert _observe_ok(rows, version='v3') is False


def test_슬랙_승인_파일을_승인자로_읽는다(tmp_path):
    # 리뷰 지적 — I8: `@삼바 승인 <v>` 가 아무것도 기록하지 않으면서 기록했다고 답했다
    from samba_agent.ops.gate import read_approval, record_approval

    assert read_approval(tmp_path, 'v1') is None
    path = record_approval(tmp_path, 'v1', 'U1')
    assert path.name == 'v1.approval.json'
    assert read_approval(tmp_path, 'v1') == 'U1'


def test_이상한_버전_이름으로는_승인_파일을_쓰지_않는다(tmp_path):
    from samba_agent.ops.gate import record_approval

    with pytest.raises(ValueError):
        record_approval(tmp_path, '../../etc/passwd', 'U1')


def test_승인_파일이_있으면_approve_인자_없이도_판정이_승인을_본다(tmp_path, monkeypatch):
    from samba_agent.ops.gate import record_approval

    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    record_approval(tmp_path, 'v-approved', 'U7')
    assert gate_mod.main(['--version', 'v-approved']) == 0
    report = (tmp_path / 'v-approved.md').read_text(encoding='utf-8')
    assert '| approval | 통과 |' in report


def test_plan_은_무엇을_바꿀지만_보여준다(tmp_path, monkeypatch, capsys):
    # 리뷰 지적 — Minor: --apply 라는 이름이 실제로 반영하는 것처럼 읽힌다
    monkeypatch.setattr(gate_mod, 'REPORT_DIR', tmp_path)
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'f' * 64)
    monkeypatch.setenv('SAMBA_AGENT_ROOT', str(tmp_path))
    monkeypatch.setenv('SAMBA_DB_PATH', str(tmp_path / 'jobs.sqlite'))
    assert gate_mod.main(['--version', 'v9', '--plan']) == 0
    out = capsys.readouterr().out
    assert 'v9' in out
    assert not (tmp_path / 'v9.md').exists()  # 판정도 기록도 하지 않는다
    with pytest.raises(SystemExit):
        gate_mod.main(['--version', 'v9', '--apply'])
