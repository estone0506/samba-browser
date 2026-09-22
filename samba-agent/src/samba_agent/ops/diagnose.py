"""진단 — "어느 에이전트의 어느 규칙을 고칠지" 가 읽히는 표를 만든다(스펙 §4.5 3단계).

로컬 events.sqlite 만으로 돈다. LangSmith 가 끊겨도 진단은 된다.
"""

import argparse
import math
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from samba_agent.failures import FailReason
from samba_agent.ops.events import EventLog

MAX_LINKS = 3


def _parse_since_days(value: str) -> int:
    """`--since` 값(예: '7d')을 일수로 바꾼다. 잘못된 값이면 argparse 오류로 끝난다."""
    text = value.strip().removesuffix('d')
    if not text.isdigit():
        raise argparse.ArgumentTypeError(f"'{value}' 은(는) 올바른 --since 값이 아니다(예: 7d)")
    return int(text)


@dataclass(frozen=True)
class DiagnosisRow:
    """에이전트 한 줄."""

    agent: str
    step: str
    runs: int
    failures: int
    fail_rate: float
    top_reason: str
    retries: int
    p50_ms: int
    p95_ms: int
    delta_vs_prev: float | None
    example_links: tuple[str, ...]


@dataclass(frozen=True)
class Diagnosis:
    """표 1개."""

    version: str
    since_days: int
    rows: tuple[DiagnosisRow, ...]
    review_queue_pending: int

    def to_markdown(self) -> str:
        head = f'# 진단 — {self.version} (최근 {self.since_days}일)\n'
        if not self.rows:
            return head + '\n기록 없음\n'
        lines = [
            head,
            '| 에이전트 | 단계 | 실행 | 실패 | 실패율 | 상위 사유 | 재시도 | p50 | p95 | 직전 대비 |',
            '|---|---|---:|---:|---:|---|---:|---:|---:|---:|',
        ]
        for r in self.rows:
            delta = '-' if r.delta_vs_prev is None else f'{r.delta_vs_prev:+.1%}'
            lines.append(
                f'| {r.agent} | {r.step} | {r.runs} | {r.failures} | {r.fail_rate:.1%} | '
                f'{r.top_reason} | {r.retries} | {r.p50_ms} | {r.p95_ms} | {delta} |'
            )
        lines.append(f'\n검수 큐 미처리: {self.review_queue_pending}건\n')
        for r in self.rows:
            for link in r.example_links:
                lines.append(f'- 실패 예시({r.agent}): {link}')
        return '\n'.join(lines) + '\n'


def _parse_fail_reason(value: object) -> str:
    """`fail_reason` 값을 `FailReason` enum 으로 검증한다. 없거나 모르는 값은 unknown."""
    if value is None:
        return FailReason.UNKNOWN.value
    try:
        return FailReason(str(value)).value
    except ValueError:
        return FailReason.UNKNOWN.value


def _nearest_rank(sorted_values: list[int], pct: float) -> int:
    """표준 nearest-rank 백분위수: 정렬된 값에서 `ceil(pct*N)-1` 번째(0-based)."""
    if not sorted_values:
        return 0
    idx = max(0, math.ceil(pct * len(sorted_values)) - 1)
    return sorted_values[min(idx, len(sorted_values) - 1)]


def diagnose(
    events: EventLog,
    *,
    version: str,
    since_days: int = 7,
    previous: Mapping[str, float] | None = None,
    review_queue_pending: int = 0,
) -> Diagnosis:
    """이벤트 → 표.

    실패 사유(`top_reason`)는 payload 의 `fail_reason` 값을 `FailReason` enum 으로
    파싱해서 센다. enum 밖의 값(운영 중 잘못 들어온 값)은 `FailReason.UNKNOWN` 으로
    폴백한다 — 검증되지 않은 문자열이 그대로 표에 남지 않게 한다.

    행은 `agent` 만이 아니라 `(agent, step)` 쌍으로 묶는다 — 같은 에이전트라도
    단계가 다르면 실패율·재시도·소요가 다르게 나오므로 단계별로 따로 봐야
    "어느 에이전트의 어느 단계를 고칠지"가 읽힌다.
    """
    by_key: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for row in events.since(since_days):
        if row['version'] != version or row['kind'] != 'agent':
            continue
        payload = dict(row['payload'])
        key = (str(row['agent']), str(payload.get('step', '-')))
        by_key[key].append(payload)
    rows: list[DiagnosisRow] = []
    for agent, step in sorted(by_key):
        items = by_key[(agent, step)]
        failures = [p for p in items if not p.get('ok')]
        durations = sorted(int(p.get('duration_ms', 0)) for p in items)
        reasons = Counter(_parse_fail_reason(p.get('fail_reason')) for p in failures)
        rate = len(failures) / len(items)
        prev = previous.get(agent) if previous else None
        rows.append(
            DiagnosisRow(
                agent=agent,
                step=step,
                runs=len(items),
                failures=len(failures),
                fail_rate=rate,
                top_reason=reasons.most_common(1)[0][0] if reasons else '-',
                # 실패 건의 재시도 합(성공 건은 제외) — "이 기간 이 (에이전트,단계) 가
                # 재시도로 총 몇 번을 더 썼는지"를 본다. 성공 건의 재시도는 이미 성공으로
                # 끝났으므로 여기 문제 진단에는 넣지 않는다.
                retries=sum(int(p.get('retries', 0)) for p in failures),
                p50_ms=_nearest_rank(durations, 0.50),
                p95_ms=_nearest_rank(durations, 0.95),
                delta_vs_prev=(rate - prev) if prev is not None else None,
                example_links=tuple(str(p['link']) for p in failures if p.get('link'))[:MAX_LINKS],
            )
        )
    return Diagnosis(
        version=version,
        since_days=since_days,
        rows=tuple(rows),
        review_queue_pending=review_queue_pending,
    )


def main(argv: Sequence[str] | None = None) -> int:
    from samba_agent.settings import default_report_dir, load_settings

    parser = argparse.ArgumentParser(prog='ops.diagnose')
    parser.add_argument('--version', required=True)
    parser.add_argument('--since', default='7d', type=_parse_since_days)
    args = parser.parse_args(argv)
    settings = load_settings()
    events = EventLog(settings.root / 'events.sqlite')
    report = diagnose(events, version=args.version, since_days=args.since)
    # 판정·실험과 같은 폴더를 쓴다(리뷰 지적 — I4)
    out = default_report_dir() / f'{args.version}.diagnose.md'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report.to_markdown(), encoding='utf-8')
    print(report.to_markdown())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
