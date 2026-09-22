"""판정 — 1~3단계 산출물을 읽어 promote | improve 를 낸다(스펙 §4.5 4단계).

여섯 조건이 전부 참일 때만 promote 다. 특히 여섯 번째(사용자 승인)가 없으면
나머지가 아무리 좋아도 improve 다. 자동으로 운영에 올라가지 않는다.

`eval.py` 는 아직 buyer.* 를 뺀 나머지 데이터셋을 참조 재생기(시드 규칙 재계산)로만
돌리기 때문에 요약 JSON 최상위에 `gate_eligible: false` 를 못박아 둔다(Task 13 리뷰
지적 1). 이 값이 명시적으로 false 면 점수가 만점이어도 절대 promote 가 나오지 않는다
— `accuracy` 조건에서 막는다.
"""

import argparse
import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from samba_agent.ops.datasets import MIN_EXAMPLES
from samba_agent.ops.diagnose import Diagnosis
from samba_agent.ops.releases import Release, ReleaseStore

log = logging.getLogger(__name__)

GATE_RULES = ('observe', 'accuracy', 'regression', 'dry_run', 'review_queue', 'approval')
REPORT_DIR = Path(__file__).resolve().parent / 'reports'


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

    enough = all(int(d.get('count', 0)) >= MIN_EXAMPLES for d in datasets.values()) and bool(
        datasets
    )
    checks = {'observe': bool(observe_ok and enough)}
    if not observe_ok:
        reasons.append('Observe 완료 조건 미달(trace 항목·마스킹 검사)')
    if not enough:
        reasons.append(f'데이터셋이 {MIN_EXAMPLES}건 미만인 것이 있다')

    # 키가 아예 없으면(직접 만든 요약처럼) 기본은 승격 가능한 것으로 본다.
    # eval.py 가 실제로 만드는 요약은 이 키를 항상 명시해서 채워 넣는다(현재는 false 고정).
    gate_eligible = bool(eval_summary.get('gate_eligible', True))
    accuracy = True
    if not gate_eligible:
        accuracy = False
        reasons.append(
            '실험 요약이 아직 승격 근거가 못 된다(gate_eligible=false, 참조 재생기 결과 포함)'
        )
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


def main(argv: Sequence[str] | None = None) -> int:
    from samba_agent.ops.diagnose import diagnose
    from samba_agent.ops.events import EventLog
    from samba_agent.settings import load_settings

    parser = argparse.ArgumentParser(prog='ops.gate')
    parser.add_argument('--version', required=True)
    parser.add_argument('--approve', default=None, help='승인한 사람(슬랙 ID)')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--dry-run-ok', action='store_true')
    args = parser.parse_args(argv)
    settings = load_settings()
    store = ReleaseStore(settings.root / 'releases.sqlite')

    if args.rollback:
        prev = store.current_prod()
        # 자동 롤백은 없다 — 무엇으로 되돌릴지 알려 주고 사람이 태그를 옮긴다
        print(f'되돌릴 운영 버전: {prev.version if prev else "없음"}')
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
        observe_ok=bool(events.since(30)),
        dry_run_ok=bool(args.dry_run_ok),
        review_queue_blocking=diagnosis.review_queue_pending,
        approved_by=args.approve,
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
        # 태그 이동과 실행기 재시작은 외부 변경이라 사람이 한다(스펙 §10-1)
        print('promote — 프롬프트 허브 prod 태그 이동과 HARNESS_ENV=prod 재시작은 사람이 한다')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
