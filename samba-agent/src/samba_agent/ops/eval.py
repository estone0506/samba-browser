"""`python -m samba_agent.ops.eval --version <v>` — 에이전트별 오프라인 회귀(스펙 §4.5 2단계).

브라우저 없이 데이터셋 스냅샷으로 돈다. 결과는 samba-staging 프로젝트의 실험이 되고,
점수 요약은 ops/reports/<version>.eval.json 에 남아 gate 가 읽는다.

이 요약은 아직 promote 근거가 될 수 없다(Task 13 리뷰 지적 1) — buyer.* 만 실제
`BuyerAgent` 를 돌리고(`runner: "agents"`) 나머지는 시드 규칙을 재계산하는 참조 재생기
(`runner: "reference-simulator"`)라 항상 100점이 나오기 쉽다. 그래서 요약 JSON 최상위에
`gate_eligible: false` 를 못박아 두고, 데이터셋마다 `runner` 를 적는다. `ops.gate`(Task 15)
는 이 값을 보고 이 실험 결과만으로는 승격시키지 않아야 한다.
"""

import argparse
import json
from collections.abc import Sequence

from samba_agent.ops.datasets import load_seed, seed_counts
from samba_agent.ops.evaluators import EVALUATORS
from samba_agent.settings import default_report_dir, load_settings

# 판정·실험 산출물은 설정 한 곳(SAMBA_REPORT_DIR, 기본 root/ops/reports)에 모은다
REPORT_DIR = default_report_dir()

# 참조 재생기는 reason 필드를 채우지 않아 reason_quality 가 항상 0으로 나온다 — 실제 에이전트
# 결과가 아니라는 것을 숫자만 보고 오해하지 않도록 요약 JSON에 적어 둔다(Task 13 리뷰 지적 5)
REFERENCE_SIMULATOR_NOTE = {
    'reason_quality': '참조 재생기는 reason 을 채우지 않아 항상 0점 — 실제 에이전트가 아니다',
}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='ops.eval')
    parser.add_argument('--version', required=True)
    parser.add_argument('--dataset', default=None, help='하나만 돌릴 때')
    args = parser.parse_args(argv)
    settings = load_settings()

    names = [args.dataset] if args.dataset else sorted(seed_counts(settings.root))
    summary: dict[str, object] = {
        'version': args.version,
        # 지금은 실제 에이전트 없이(또는 buyer 만 가짜 브릿지로) 돈 결과라 승격 근거로 못 쓴다
        'gate_eligible': False,
        'datasets': {},
    }
    for name in names:
        examples = load_seed(settings.root, name)
        runner = _runner(name)
        scores: dict[str, list[float]] = {}
        for example in examples:
            run = _replay(example)
            for ev in EVALUATORS:
                got = ev(run, example)
                scores.setdefault(str(got['key']), []).append(float(got['score']))
        entry: dict[str, object] = {
            'count': len(examples),
            'runner': runner,
            'scores': {k: sum(v) / len(v) for k, v in scores.items()},
        }
        if runner == 'reference-simulator':
            entry['notes'] = dict(REFERENCE_SIMULATOR_NOTE)
        summary['datasets'][name] = entry
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORT_DIR / f'{args.version}.eval.json'
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'실험 요약을 적었다: {out}')
    return 0


def _replay(example: object) -> object:
    """스냅샷으로 에이전트를 한 번 돌린 결과. 브릿지는 고정 응답 가짜를 쓴다."""
    from samba_agent.ops.replay import replay_example  # Task 13 Step 6 에서 만든다

    return replay_example(example)


def _runner(name: str) -> str:
    from samba_agent.ops.replay import runner_for  # Task 13 리뷰 지적 1

    return runner_for(name)


if __name__ == '__main__':
    raise SystemExit(main())
