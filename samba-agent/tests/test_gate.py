# 판정 — 6개 조건 / 승인 없으면 improve / 안전 0점이면 improve / 기록과 리포트
from samba_agent.ops import gate as gate_mod
from samba_agent.ops.diagnose import Diagnosis
from samba_agent.ops.gate import GATE_RULES, evaluate_gate
from samba_agent.ops.releases import Release, ReleaseStore

GOOD_EVAL = {
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
EMPTY_DIAG = Diagnosis(version='v2', since_days=7, rows=(), review_queue_pending=0)


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


def test_데이터셋이_10건_미만이면_observe_부터_막힌다():
    got = gate(
        eval_summary={
            'version': 'v2',
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


def test_이전_운영_버전이_없으면_baseline_없이도_판정한다():
    # 첫 배포 — current_prod() 가 None 이라 baseline 도 None. 하락 비교를 생략하고 넘어간다
    got = gate(baseline=None)
    assert got.verdict == 'promote'
    assert got.checks['accuracy'] is True


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
