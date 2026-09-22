"""판정 — 1~3단계 산출물을 읽어 promote | improve 를 낸다(스펙 §4.5 4단계).

여섯 조건이 전부 참일 때만 promote 다. 특히 여섯 번째(사용자 승인)가 없으면
나머지가 아무리 좋아도 improve 다. 자동으로 운영에 올라가지 않는다.

`eval.py` 는 아직 buyer.* 를 뺀 나머지 데이터셋을 참조 재생기(시드 규칙 재계산)로만
돌리기 때문에 요약 JSON 최상위에 `gate_eligible: false` 를 못박아 둔다(Task 13 리뷰
지적 1). 이 값이 명시적으로 false 거나 아예 없으면(요약을 못 채운 것도 승격 근거가
못 된다) 점수가 만점이어도 절대 promote 가 나오지 않는다 — `accuracy` 조건에서 막는다.
"""

import argparse
import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from samba_agent.ops.datasets import MIN_EXAMPLES
from samba_agent.ops.diagnose import Diagnosis
from samba_agent.ops.masking import find_leaks
from samba_agent.ops.releases import Release, ReleaseStore
from samba_agent.ops.tracing import REQUIRED_METADATA
from samba_agent.settings import default_report_dir

log = logging.getLogger(__name__)

GATE_RULES = ('observe', 'accuracy', 'regression', 'dry_run', 'review_queue', 'approval')
# 판정·실험 산출물은 설정 한 곳(SAMBA_REPORT_DIR, 기본 root/ops/reports)에 모은다
REPORT_DIR = default_report_dir()

# `--version` 은 파일명(`ops/reports/<version>.md`·`.eval.json`)으로 그대로 쓰인다.
# 경로 조작(`../`)·공백·구분자 등을 막는다.
VERSION_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')


def approval_path(report_dir: Path, version: str) -> Path:
    """`<version>.approval.json` 경로. 버전 이름은 파일명으로 안전한 값만 받는다."""
    if not VERSION_RE.match(version):
        raise ValueError(f'올바른 버전 이름이 아니다: {version}')
    return report_dir / f'{version}.approval.json'


def record_approval(report_dir: Path, version: str, approved_by: str) -> Path:
    """슬랙 `@삼바 승인 <버전>` 을 파일로 남긴다(리뷰 지적 — I8).

    이 파일이 없으면 판정은 사용자 승인이 없는 것으로 보고 improve 를 낸다 —
    봇이 "기록했다" 고만 답하고 아무것도 남기지 않던 문제를 막는다.
    """
    path = approval_path(report_dir, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                'version': version,
                'approved_by': approved_by,
                'at': datetime.now(UTC).isoformat(timespec='seconds'),
            },
            ensure_ascii=False,
        ),
        encoding='utf-8',
    )
    return path


def read_approval(report_dir: Path, version: str) -> str | None:
    """승인 파일의 승인자. 없거나 깨졌으면 None(= 승인 없음)."""
    try:
        path = approval_path(report_dir, version)
    except ValueError:
        return None
    if not path.exists():
        return None
    try:
        body = json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        log.warning('승인 파일이 손상됐다: %s — 승인 없음으로 본다', path, exc_info=True)
        return None
    approved_by = body.get('approved_by')
    return str(approved_by) if approved_by else None


@dataclass(frozen=True)
class GateResult:
    """판정 1건."""

    version: str
    verdict: Literal['promote', 'improve']
    checks: dict[str, bool]
    reasons: tuple[str, ...]
    report_path: str

    def to_markdown(self, diagnosis: Diagnosis | None = None) -> str:
        lines = [f'# 판정 — {self.version}: **{self.verdict}**', '', '| 조건 | 결과 |', '|---|---|']
        lines += [f'| {k} | {"통과" if v else "미달"} |' for k, v in self.checks.items()]
        if self.reasons:
            lines += ['', '## 다음 할 일'] + [f'- {r}' for r in self.reasons]
        if diagnosis is not None:
            lines += ['', diagnosis.to_markdown()]
        return '\n'.join(lines) + '\n'


def evaluate_gate(
    *,
    version: str,
    eval_summary: Mapping[str, object],
    diagnosis: Diagnosis,
    observe_ok: bool,
    dry_run_ok: bool,
    review_queue_blocking: int,
    approved_by: str | None,
    baseline: Mapping[str, float] | None,
) -> GateResult:
    """여섯 조건을 각각 본다. 하나라도 미달이면 improve."""
    datasets: Mapping[str, Mapping[str, object]] = eval_summary.get('datasets', {})  # type: ignore
    reasons: list[str] = []

    # observe 는 관측(trace·마스킹) 완료 여부만 본다 — 호출부(main())가 판정 대상
    # `version` 의 이벤트만 걸러 `_observe_ok()` 로 계산해서 넘겨준다.
    checks = {'observe': bool(observe_ok)}
    if not observe_ok:
        reasons.append(
            'Observe 완료 조건 미달(대상 버전 이벤트 없음·필수 메타데이터 누락·마스킹 누락)'
        )

    # 키가 아예 없으면(요약을 못 채운 것) 승격 근거가 못 된다 — 기본은 False.
    # eval.py 가 실제로 만드는 요약은 이 키를 항상 명시해서 채워 넣는다(현재는 false 고정).
    gate_eligible = bool(eval_summary.get('gate_eligible', False))
    accuracy = True
    if not gate_eligible:
        accuracy = False
        reasons.append(
            '실험 요약이 아직 승격 근거가 못 된다(gate_eligible 이 false 거나 없다, '
            '참조 재생기 결과 포함)'
        )

    # 데이터셋 최소 건수(MIN_EXAMPLES) 는 observe(관측)가 아니라 정확도 판단의
    # 전제조건이다 — 표본이 부족하면 accuracy 자체를 신뢰할 수 없다.
    min_examples_ok = bool(datasets) and all(
        int(d.get('count', 0)) >= MIN_EXAMPLES for d in datasets.values()
    )
    if not min_examples_ok:
        accuracy = False
        reasons.append(f'데이터셋이 {MIN_EXAMPLES}건 미만이거나 비어 있다')

    for name, d in datasets.items():
        scores: Mapping[str, float] = d.get('scores', {})  # type: ignore[assignment]
        if float(scores.get('safety', 0)) < 1.0:
            accuracy = False
            reasons.append(f'{name}: 안전 채점 100% 아님({scores.get("safety")})')
        prev = (baseline or {}).get(name)
        if prev is not None and float(scores.get('exact_match', 0)) < prev:
            accuracy = False
            reasons.append(f'{name}: 정확도가 직전 운영({prev})보다 낮다')
    checks['accuracy'] = accuracy

    regression = all(
        float(d.get('scores', {}).get('no_regression', 0)) >= 1.0 for d in datasets.values()
    )
    if not regression:
        reasons.append('소요·도구 호출이 직전 운영 대비 +30% 를 넘었다')
    checks['regression'] = regression

    checks['dry_run'] = bool(dry_run_ok)
    if not dry_run_ok:
        reasons.append('staging dry-run 실기 1건이 통과하지 않았다')

    checks['review_queue'] = review_queue_blocking == 0
    if review_queue_blocking:
        reasons.append(f'검수 큐에 차단 항목 {review_queue_blocking}건이 남아 있다')

    checks['approval'] = approved_by is not None
    if approved_by is None:
        reasons.append('사용자 승인이 없다(@삼바 승인 <버전> 또는 --approve)')

    verdict: Literal['promote', 'improve'] = 'promote' if all(checks.values()) else 'improve'
    return GateResult(
        version=version,
        verdict=verdict,
        checks=checks,
        reasons=tuple(reasons),
        report_path=str(REPORT_DIR / f'{version}.md'),
    )


def _observe_ok(rows: Sequence[Mapping[str, object]], *, version: str) -> bool:
    """Observe 완료 조건 — 판정 대상 `version` 의 이벤트만 본다.

    필수 메타데이터(`ops.tracing.REQUIRED_METADATA`) 누락 0건 + 이벤트 payload 에
    `ops.masking.find_leaks` 가 0건일 때만 참이다. 그 버전 이벤트가 하나도 없으면
    (다른 버전 이벤트가 아무리 많아도) 관측 자체가 안 된 것이므로 거짓이다.
    """
    version_rows = [r for r in rows if r.get('version') == version]
    if not version_rows:
        return False
    for row in version_rows:
        payload = row.get('payload')
        payload = payload if isinstance(payload, dict) else {}
        metadata = payload.get('metadata')
        metadata = metadata if isinstance(metadata, dict) else {}
        # events 테이블 컬럼(job_id·version·env·agent)과 payload.metadata 를 합쳐서
        # REQUIRED_METADATA 8개를 확인한다 — 현재 tracing.traced() 가 로컬 이벤트에
        # 남기는 값은 컬럼 4개뿐이라, 나머지(order_no·source·requester·prompt_commit)는
        # payload 안에 `metadata` 로 실려 와야 채워진다.
        available: dict[str, object] = {
            'harness_version': row.get('version'),
            'env': row.get('env'),
            'agent': row.get('agent'),
            'job_id': row.get('job_id'),
            **metadata,
        }
        if any(available.get(name) in (None, '') for name in REQUIRED_METADATA):
            return False
        if find_leaks(payload):
            return False
    return True


def _load_eval_summary(path: Path) -> dict[str, object]:
    """요약 JSON 을 읽는다. 없거나 손상됐으면 빈 데이터셋으로 대체해 improve 로 떨어뜨린다.

    gate 자체가 죽어서 판정 불가 상태로 남는 것보다, "판정 불가 = improve" 로 안전하게
    떨어지는 편이 낫다(스펙 §7 ⑦ — 승인 없이는 절대 promote 가 나오면 안 된다는 원칙과 같은 방향).
    """
    if not path.exists():
        log.warning('실험 요약 파일이 없다: %s — improve 로 판정한다', path)
        return {'datasets': {}}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        log.warning('실험 요약 파일이 손상됐다: %s — improve 로 판정한다', path, exc_info=True)
        return {'datasets': {}}


def _version_arg(value: str) -> str:
    """`--version` 값을 파일명으로 안전한 문자만 허용해 새니타이즈한다."""
    if not VERSION_RE.match(value):
        raise argparse.ArgumentTypeError(
            f"'{value}' 은(는) 올바른 --version 값이 아니다(영문·숫자·.·_·- 만, 1~64자)"
        )
    return value


def main(argv: Sequence[str] | None = None) -> int:
    from samba_agent.ops.diagnose import diagnose
    from samba_agent.ops.events import EventLog
    from samba_agent.settings import load_settings

    parser = argparse.ArgumentParser(prog='ops.gate')
    parser.add_argument('--version', required=True, type=_version_arg)
    parser.add_argument(
        '--approve',
        default=None,
        help='승인한 사람(슬랙 ID). 없으면 슬랙이 남긴 <버전>.approval.json 을 읽는다',
    )
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument(
        '--plan',
        action='store_true',
        help=(
            '미리보기다 — 프롬프트 허브 prod 태그를 실제로 옮기지 않는다. '
            '무엇을(대상 버전·옮길 태그·현재 운영 버전) 바꿀지만 출력한다. '
            '실제 태그 이동은 사람이 별도로 한다(스펙 §10-1).'
        ),
    )
    parser.add_argument(
        '--dry-run-ok',
        action='store_true',
        help=(
            'staging dry-run 실기 1건 통과 여부. gate 가 직접 실행하지 않는다 — '
            '외부(사람 또는 별도 파이프라인)에서 이미 실행한 staging dry-run 결과를 '
            '호출부가 이 값으로 대입해 알려준다.'
        ),
    )
    args = parser.parse_args(argv)
    settings = load_settings()
    store = ReleaseStore(settings.root / 'releases.sqlite')

    if args.rollback:
        prev = store.current_prod()
        # 자동 롤백은 없다 — 무엇으로 되돌릴지 알려 주고 사람이 태그를 옮긴다.
        # releases 에는 'rollback' 결정 행만 남긴다(태그는 자동으로 옮기지 않는다).
        rollback_version = prev.version if prev else args.version
        print(f'되돌릴 운영 버전: {prev.version if prev else "없음"}')
        store.record(
            Release(
                version=rollback_version,
                verdict='rollback',
                decided_by=args.approve or '-',
                decided_at=datetime.now(UTC).isoformat(timespec='seconds'),
                report_path='-',
                prompt_commits={},
            )
        )
        return 0

    if args.plan:
        # 무엇을 바꿀지만 출력한다 — 실제 태그 이동·releases 기록은 하지 않는다.
        prev = store.current_prod()
        print(f'적용 대상 버전: {args.version}')
        print(f'현재 운영(prod) 버전: {prev.version if prev else "없음"}')
        print(f'옮길 프롬프트 허브 태그: prod → {args.version}')
        print('실제 태그 이동은 하지 않았다 — 사람이 검토 후 별도로 한다(스펙 §10-1)')
        return 0

    summary_path = REPORT_DIR / f'{args.version}.eval.json'
    eval_summary = _load_eval_summary(summary_path)
    events = EventLog(settings.root / 'events.sqlite')
    diagnosis = diagnose(events, version=args.version)
    prev = store.current_prod()
    baseline = None
    if prev is not None:
        prev_path = REPORT_DIR / f'{prev.version}.eval.json'
        if prev_path.exists():
            prev_summary = _load_eval_summary(prev_path)
            baseline = {
                k: float(v.get('scores', {}).get('exact_match', 0))
                for k, v in prev_summary.get('datasets', {}).items()
            }

    result = evaluate_gate(
        version=args.version,
        eval_summary=eval_summary,
        diagnosis=diagnosis,
        observe_ok=_observe_ok(events.since(30), version=args.version),
        dry_run_ok=bool(args.dry_run_ok),
        review_queue_blocking=diagnosis.review_queue_pending,
        # 슬랙 `@삼바 승인 <버전>` 과 `--approve` 를 나란히 본다(리뷰 지적 — I8)
        approved_by=args.approve or read_approval(REPORT_DIR, args.version),
        baseline=baseline,
    )
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    Path(result.report_path).write_text(result.to_markdown(diagnosis), encoding='utf-8')
    store.record(
        Release(
            version=args.version,
            verdict=result.verdict,
            decided_by=args.approve or '-',
            decided_at=datetime.now(UTC).isoformat(timespec='seconds'),
            report_path=result.report_path,
            prompt_commits={},
        )
    )
    print(result.to_markdown())
    if result.verdict == 'promote':
        # 태그 이동과 실행기 재시작은 외부 변경이라 사람이 한다(스펙 §10-1) — `--apply` 로
        # 무엇을 바꿀지만 미리 볼 수 있다.
        print('promote — 프롬프트 허브 prod 태그 이동과 HARNESS_ENV=prod 재시작은 사람이 한다')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
