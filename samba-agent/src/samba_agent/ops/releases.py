"""운영 버전 기록. 자동 승격·자동 롤백은 없다 — 사람이 결정한 것만 여기 남는다(스펙 §10-4)."""

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

_SCHEMA = """
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL, verdict TEXT NOT NULL, decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL, report_path TEXT NOT NULL, prompt_commits TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class Release:
    """판정 1건.

    verdict 는 'rollback' 도 들어온다(`ops.gate --rollback` 이 남기는 기록) — 태그를
    자동으로 옮기지는 않으므로 `current_prod()` 는 여전히 'promote' 행만 고른다.
    """

    version: str
    verdict: Literal['promote', 'improve', 'rollback']
    decided_by: str
    decided_at: str
    report_path: str
    prompt_commits: dict[str, str]


class ReleaseStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)

    def record(self, release: Release) -> None:
        # 같은 버전을 다시 판정해도 막지 않는다 — 판정 이력은 쌓이는 것이고, 무엇이
        # 운영인지는 항상 "가장 최근 promote" 로 계산한다(중복 판정 자체가 문제가 아니다).
        self._db.execute(
            'INSERT INTO releases(version, verdict, decided_by, decided_at, report_path, '
            'prompt_commits) VALUES(?,?,?,?,?,?)',
            (
                release.version,
                release.verdict,
                release.decided_by,
                release.decided_at,
                release.report_path,
                json.dumps(release.prompt_commits, ensure_ascii=False),
            ),
        )

    def current_prod(self) -> Release | None:
        """가장 최근 promote. 운영에 도는 버전이다."""
        row = self._db.execute(
            "SELECT * FROM releases WHERE verdict='promote' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return self._row(row) if row else None

    def history(self, limit: int = 20) -> list[Release]:
        rows = self._db.execute(
            'SELECT * FROM releases ORDER BY id DESC LIMIT ?', (limit,)
        ).fetchall()
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(r: sqlite3.Row) -> Release:
        return Release(
            version=r['version'],
            verdict=r['verdict'],
            decided_by=r['decided_by'],
            decided_at=r['decided_at'],
            report_path=r['report_path'],
            prompt_commits=json.loads(r['prompt_commits']),
        )
