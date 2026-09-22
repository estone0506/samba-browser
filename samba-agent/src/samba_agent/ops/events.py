"""로컬 이벤트 사본 — LangSmith 가 끊겨도 진단이 되게 30일치를 들고 있는다(스펙 §4.5)."""

import json
import logging
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

log = logging.getLogger(__name__)

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
        # check_same_thread=False: traced() 가 여러 스레드에서 호출될 수 있다.
        # 쓰기는 락으로 직렬화한다(sqlite 커넥션 자체는 스레드 안전하지 않다).
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        self._keep_days = keep_days
        self._write_lock = threading.Lock()

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
        """이미 마스킹된 payload 만 넣는다 — 마스킹은 tracing 이 한다.

        payload 안에 JSON 으로 못 바꾸는 값(self·Path·datetime·pydantic 모델 등)이
        있어도 default=str 로 문자열로 남긴다. 그래도 쓰기가 실패하면 정상 흐름을
        막지 않도록 로그만 남기고 삼킨다(tracing.traced 의 finally 에서 호출되므로
        여기서 예외가 나가면 원래 반환값·예외를 덮어버린다).
        """
        try:
            payload_json = json.dumps(payload, ensure_ascii=False, default=str)
            with self._write_lock:
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
                        payload_json,
                    ),
                )
        except Exception:  # 이벤트 기록 실패가 본 흐름을 막으면 안 된다
            log.warning('로컬 이벤트 기록 실패, 무시하고 계속한다', exc_info=True)

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
