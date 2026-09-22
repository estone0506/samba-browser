"""로컬 이벤트 사본 — LangSmith 가 끊겨도 진단이 되게 30일치를 들고 있는다(스펙 §4.5)."""

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, job_id INTEGER, version TEXT, env TEXT,
  agent TEXT, kind TEXT, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
"""


class EventLog:
    """이벤트 한 줄 = 감독자 결정·에이전트 단계·도구 호출·재시도·사람 넘김 중 하나."""

    def __init__(self, path: Path, keep_days: int = 30) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        self._keep_days = keep_days

    def write(
        self,
        *,
        job_id: int,
        version: str,
        env: str,
        agent: str,
        kind: str,
        payload: dict[str, object],
    ) -> None:
        """이미 마스킹된 payload 만 넣는다 — 마스킹은 tracing 이 한다."""
        self._db.execute(
            'INSERT INTO events(at, job_id, version, env, agent, kind, payload) '
            'VALUES(?,?,?,?,?,?,?)',
            (
                datetime.now(UTC).isoformat(timespec='seconds'),
                job_id,
                version,
                env,
                agent,
                kind,
                json.dumps(payload, ensure_ascii=False),
            ),
        )

    def of_job(self, job_id: int) -> list[dict[str, object]]:
        rows = self._db.execute(
            'SELECT * FROM events WHERE job_id=? ORDER BY id', (job_id,)
        ).fetchall()
        return [self._row(r) for r in rows]

    def since(self, days: int) -> list[dict[str, object]]:
        cut = (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec='seconds')
        rows = self._db.execute('SELECT * FROM events WHERE at >= ? ORDER BY id', (cut,)).fetchall()
        return [self._row(r) for r in rows]

    def prune(self) -> int:
        """보관 기간을 넘긴 줄을 지운다. 지운 수를 돌려준다."""
        cut = (datetime.now(UTC) - timedelta(days=self._keep_days)).isoformat(timespec='seconds')
        cur = self._db.execute('DELETE FROM events WHERE at < ?', (cut,))
        return cur.rowcount or 0

    @staticmethod
    def _row(r: sqlite3.Row) -> dict[str, object]:
        return {
            'at': r['at'],
            'job_id': r['job_id'],
            'version': r['version'],
            'env': r['env'],
            'agent': r['agent'],
            'kind': r['kind'],
            'payload': json.loads(r['payload']),
        }
