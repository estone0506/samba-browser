"""진단 — "어느 에이전트의 어느 규칙을 고칠지" 가 읽히는 표를 만든다(스펙 §4.5 3단계).

로컬 events.sqlite 만으로 돈다. LangSmith 가 끊겨도 진단은 된다.
"""

import argparse
import statistics
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from samba_agent.ops.events import EventLog

MAX_LINKS = 3


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


def diagnose(
    events: EventLog,
    *,
    version: str,
    since_days: int = 7,
    previous: Mapping[str, float] | None = None,
    review_queue_pending: int = 0,
) -> Diagnosis:
    """이벤트 → 표.

    실패 사유(`top_reason`)는 payload 의 `fail_reason` 문자열을 그대로 센다 — 이 값이
    `FailReason` enum 밖의 값이라도(모르는 사유) 집계는 막지 않고 그 문자열 그대로
    표에 남긴다(운영 중 enum 에 없는 값이 들어와도 진단이 죽지 않게).
    """
    by_agent: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in events.since(since_days):
        if row['version'] != version or row['kind'] != 'agent':
            continue
        by_agent[str(row['agent'])].append(dict(row['payload']))
    rows: list[DiagnosisRow] = []
    for agent in sorted(by_agent):
        items = by_agent[agent]
        failures = [p for p in items if not p.get('ok')]
        durations = sorted(int(p.get('duration_ms', 0)) for p in items)
        reasons = Counter(str(p.get('fail_reason', 'unknown')) for p in failures)
        rate = len(failures) / len(items) if items else 0.0
        prev = previous.get(agent) if previous else None
        rows.append(
            DiagnosisRow(
                agent=agent,
                step=str(items[-1].get('step', '-')),
                runs=len(items),
                failures=len(failures),
                fail_rate=rate,
                top_reason=reasons.most_common(1)[0][0] if reasons else '-',
                # 합이 아니라 최댓값 — "가장 많이 재시도한 건"이 몇 번 재시도했는지를 본다.
                # (브리프 코드는 sum 이었으나, 브리프의 테스트 픽스처(2건, 각 retries=1)가
                # retries==1 을 기대해 sum(=2) 과 어긋난다. 테스트를 기준으로 max 로 맞춘다.)
                retries=max((int(p.get('retries', 0)) for p in items), default=0),
                p50_ms=int(statistics.median(durations)) if durations else 0,
                p95_ms=durations[max(0, int(len(durations) * 0.95) - 1)] if durations else 0,
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
    from samba_agent.settings import load_settings

    parser = argparse.ArgumentParser(prog='ops.diagnose')
    parser.add_argument('--version', required=True)
    parser.add_argument('--since', default='7d')
    args = parser.parse_args(argv)
    settings = load_settings()
    days = int(str(args.since).rstrip('d') or 7)
    events = EventLog(settings.root / 'events.sqlite')
    report = diagnose(events, version=args.version, since_days=days)
    out = Path(__file__).resolve().parent / 'reports' / f'{args.version}.diagnose.md'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report.to_markdown(), encoding='utf-8')
    print(report.to_markdown())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
