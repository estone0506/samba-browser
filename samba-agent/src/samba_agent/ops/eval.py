"""`python -m samba_agent.ops.eval --version <v>` — 에이전트별 오프라인 회귀(스펙 §4.5 2단계).

브라우저 없이 데이터셋 스냅샷으로 돈다. 결과는 samba-staging 프로젝트의 실험이 되고,
점수 요약은 ops/reports/<version>.eval.json 에 남아 gate 가 읽는다.
"""

import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from samba_agent.ops.datasets import load_seed, seed_counts
from samba_agent.ops.evaluators import EVALUATORS
from samba_agent.settings import load_settings

REPORT_DIR = Path(__file__).resolve().parent / 'reports'


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='ops.eval')
    parser.add_argument('--version', required=True)
    parser.add_argument('--dataset', default=None, help='하나만 돌릴 때')
    args = parser.parse_args(argv)
    settings = load_settings()

    names = [args.dataset] if args.dataset else sorted(seed_counts(settings.root))
    summary: dict[str, object] = {'version': args.version, 'datasets': {}}
    for name in names:
        examples = load_seed(settings.root, name)
        scores: dict[str, list[float]] = {}
        for example in examples:
            run = _replay(example)
            for ev in EVALUATORS:
                got = ev(run, example)
                scores.setdefault(str(got['key']), []).append(float(got['score']))
        summary['datasets'][name] = {
            'count': len(examples),
            'scores': {k: sum(v) / len(v) for k, v in scores.items()},
        }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORT_DIR / f'{args.version}.eval.json'
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'실험 요약을 적었다: {out}')
    return 0


def _replay(example: object) -> object:
    """스냅샷으로 에이전트를 한 번 돌린 결과. 브릿지는 고정 응답 가짜를 쓴다."""
    from samba_agent.ops.replay import replay_example  # Task 13 Step 6 에서 만든다

    return replay_example(example)


if __name__ == '__main__':
    raise SystemExit(main())
