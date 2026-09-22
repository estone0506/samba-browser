"""harness_version — 감독자 코드 + 등록부 + 규칙 파일 + 프롬프트 커밋의 해시(스펙 §4.5)."""

import hashlib
from collections.abc import Mapping
from pathlib import Path

# 버전에 들어가는 코드 — 감독자와 에이전트 껍데기. 여기가 바뀌면 새 버전이다
CODE_DIRS = ('supervisor', 'agents')


def harness_version(root: Path, prompt_commits: Mapping[str, str]) -> str:
    """`v` + sha256 앞 12자. 무엇이든 바뀌면 값이 달라진다."""
    h = hashlib.sha256()
    code_root = Path(__file__).resolve().parent
    for name in CODE_DIRS:
        for f in sorted((code_root / name).rglob('*.py')):
            h.update(f.name.encode('utf-8'))
            h.update(f.read_bytes())
    registry = root / 'registry.yaml'
    if registry.exists():
        h.update(registry.read_bytes())
    for f in sorted((root / 'rules').glob('*.md')):
        h.update(f.name.encode('utf-8'))
        h.update(f.read_bytes())
    for agent in sorted(prompt_commits):
        h.update(f'{agent}={prompt_commits[agent]}'.encode())
    return f'v{h.hexdigest()[:12]}'
