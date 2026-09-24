"""스크립트 원본 읽기와 교체 이력(백업).

- 원본은 앱의 스크립트 파일(userData/site-scripts.json)에서 읽는다. 하네스는 앱과 같은 PC 에서 돈다.
- 교체 전 원본은 앱 저장소가 아니라 하네스 쪽 폴더에 남긴다 — 앱 저장소에 백업 사본을 넣으면
  개수 상한 때문에 다른 스크립트가 밀려 지워진다(실기: 결제창 진입 스크립트 5개 소실).
"""

import json
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class FileScriptSource:
    """앱 스크립트 파일에서 이름으로 한 건을 읽는다. 파일이 없거나 깨졌으면 None."""

    path: Path

    def get(self, name: str) -> dict[str, object] | None:
        try:
            rows = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return None
        if not isinstance(rows, list):
            return None
        for row in rows:
            if isinstance(row, dict) and row.get('name') == name:
                return row
        return None


@dataclass(frozen=True)
class ScriptHistory:
    """교체 이력 폴더: <root>/<이름>/<시각>-before.js · -after.js · -meta.json."""

    root: Path

    def record(self, name: str, before: str | None, after: str, meta: dict[str, object]) -> Path:
        folder = self.root / name
        folder.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        if before:
            (folder / f'{stamp}-before.js').write_text(before, encoding='utf-8')
        (folder / f'{stamp}-after.js').write_text(after, encoding='utf-8')
        (folder / f'{stamp}-meta.json').write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8'
        )
        return folder
