"""외부 기입 요청 큐 — SQLite. 하네스(일반 권한)와 입력 작업자(관리자 권한)의 유일한 접점이다.

두 프로세스가 같은 파일을 연다 — WAL + busy_timeout + BEGIN IMMEDIATE 로 겹침을 막는다.
개인정보는 담지 않는다(주문번호·금액·상태뿐).
"""

import contextlib
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from samba_agent.export.failures import ExportFail

ExportStatus = Literal['pending', 'running', 'done', 'failed']
# 더 바뀌지 않는 상태
TERMINAL: tuple[ExportStatus, ...] = ('done', 'failed')

_SCHEMA = """
CREATE TABLE IF NOT EXISTS export_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  target TEXT NOT NULL,
  cost INTEGER NOT NULL,
  shipping_fee INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  fail_reason TEXT,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_no, target)
);
CREATE INDEX IF NOT EXISTS export_requests_status ON export_requests(status, next_at);
CREATE TABLE IF NOT EXISTS export_heartbeat (
  target TEXT PRIMARY KEY,
  beat_at TEXT NOT NULL
);
"""


class ExportConflict(Exception):
    """이미 기입했거나 기입 중인 요청과 값이 다르다 — 덮어쓰기는 사람이 한다."""


@dataclass(frozen=True)
class ExportRequest:
    """큐의 한 행."""

    id: int
    order_no: str
    target: str
    cost: int
    shipping_fee: int
    status: ExportStatus
    fail_reason: str | None
    detail: str | None
    attempts: int
    notified: bool
    next_at: str
    created_at: str
    updated_at: str


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _to_request(row: sqlite3.Row) -> ExportRequest:
    return ExportRequest(
        id=row['id'],
        order_no=row['order_no'],
        target=row['target'],
        cost=row['cost'],
        shipping_fee=row['shipping_fee'],
        status=row['status'],
        fail_reason=row['fail_reason'],
        detail=row['detail'],
        attempts=row['attempts'],
        notified=bool(row['notified']),
        next_at=row['next_at'],
        created_at=row['created_at'],
        updated_at=row['updated_at'],
    )


class ExportQueue:
    """외부 기입 큐. 하네스와 입력 작업자가 각자 연결을 하나씩 연다."""

    def __init__(self, path: Path, clock: Callable[[], datetime] | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._clock = clock or _utc_now
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # 다른 프로세스가 쓰는 중이면 즉시 실패하지 않고 기다린다
        self._db.execute('PRAGMA busy_timeout=5000')
        # 읽는 쪽(하네스 대기)과 쓰는 쪽(작업자)이 서로 막지 않게 한다
        self._db.execute('PRAGMA journal_mode=WAL')
        self._db.executescript(_SCHEMA)
        # 한 연결을 여러 스레드가 쓴다(그래프 노드·알림 고리) — BEGIN~COMMIT 구간을 직렬화한다
        self._lock = threading.Lock()

    def _iso(self, offset_s: float = 0) -> str:
        return (self._clock() + timedelta(seconds=offset_s)).isoformat(timespec='seconds')

    @contextlib.contextmanager
    def _immediate(self) -> Iterator[None]:
        """조회 → 쓰기를 한 트랜잭션으로 묶는다. 예외가 나면 되돌린다."""
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                yield
                self._db.execute('COMMIT')
            except BaseException:
                self._db.execute('ROLLBACK')
                raise

    def _row(self, request_id: int) -> sqlite3.Row | None:
        return self._db.execute(
            'SELECT * FROM export_requests WHERE id=?', (request_id,)
        ).fetchone()

    def enqueue(self, order_no: str, target: str, cost: int, shipping_fee: int) -> ExportRequest:
        """요청을 넣는다. 같은 (주문번호, 대상) 이 있으면 새 행을 만들지 않는다.

        값이 같으면 기존 행을 그대로 돌려준다. 값이 다르면 — 이미 기입했거나(done) 기입 중(running)
        이면 거절하고, 아직 안 했거나 실패한 요청이면 새 값으로 바꿔 다시 대기시킨다.
        """
        now = self._iso()
        with self._immediate():
            row = self._db.execute(
                'SELECT * FROM export_requests WHERE order_no=? AND target=?',
                (order_no, target),
            ).fetchone()
            if row is None:
                cur = self._db.execute(
                    'INSERT INTO export_requests '
                    '(order_no, target, cost, shipping_fee, next_at, created_at, updated_at) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?)',
                    (order_no, target, cost, shipping_fee, now, now, now),
                )
                row = self._row(int(cur.lastrowid or 0))
            elif (row['cost'], row['shipping_fee']) != (cost, shipping_fee):
                if row['status'] in ('done', 'running'):
                    raise ExportConflict(
                        f'{order_no}({target}) 는 이미 {row["status"]} 다 — '
                        f'기존 {row["cost"]}/{row["shipping_fee"]}, 요청 {cost}/{shipping_fee}'
                    )
                self._db.execute(
                    "UPDATE export_requests SET cost=?, shipping_fee=?, status='pending', "
                    'fail_reason=NULL, detail=NULL, attempts=0, notified=0, next_at=?, '
                    'updated_at=? WHERE id=?',
                    (cost, shipping_fee, now, now, row['id']),
                )
                row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def get(self, request_id: int) -> ExportRequest:
        with self._lock:
            row = self._row(request_id)
        if row is None:
            raise KeyError(request_id)
        return _to_request(row)

    def find(self, order_no: str, target: str) -> ExportRequest | None:
        with self._lock:
            row = self._db.execute(
                'SELECT * FROM export_requests WHERE order_no=? AND target=?',
                (order_no, target),
            ).fetchone()
        return _to_request(row) if row is not None else None

    def claim_next(self, targets: Sequence[str]) -> ExportRequest | None:
        """맡은 대상의 대기 요청 중 가장 오래된 것을 running 으로 바꿔 돌려준다."""
        if not targets:
            return None
        now = self._iso()
        marks = ','.join('?' for _ in targets)
        with self._immediate():
            row = self._db.execute(
                f"SELECT * FROM export_requests WHERE status='pending' AND next_at<=? "
                f'AND target IN ({marks}) ORDER BY created_at, id LIMIT 1',
                (now, *targets),
            ).fetchone()
            if row is None:
                return None
            self._db.execute(
                "UPDATE export_requests SET status='running', attempts=attempts+1, updated_at=? "
                'WHERE id=?',
                (now, row['id']),
            )
            row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def done(self, request_id: int, detail: str) -> None:
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='done', fail_reason=NULL, detail=?, "
                'updated_at=? WHERE id=?',
                (detail, self._iso(), request_id),
            )

    def fail(self, request_id: int, reason: ExportFail, detail: str) -> None:
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='failed', fail_reason=?, detail=?, "
                'updated_at=? WHERE id=?',
                (reason.value, detail, self._iso(), request_id),
            )

    def retry_later(
        self,
        request_id: int,
        reason: ExportFail,
        detail: str,
        delay_s: float,
    ) -> None:
        """다시 대기시킨다. delay_s 가 지나야 다시 집힌다."""
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='pending', fail_reason=?, detail=?, "
                'next_at=?, updated_at=? WHERE id=?',
                (reason.value, detail, self._iso(delay_s), self._iso(), request_id),
            )

    def recover_running(self, targets: Sequence[str]) -> int:
        """작업자가 도중에 죽어 남은 running 을 되돌린다.

        다시 돌려도 안전하다 — 작업자는 입력 전에 먼저 읽고, 값이 이미 같으면 입력하지 않는다.
        """
        if not targets:
            return 0
        marks = ','.join('?' for _ in targets)
        now = self._iso()
        with self._immediate():
            cur = self._db.execute(
                f"UPDATE export_requests SET status='pending', next_at=?, updated_at=? "
                f"WHERE status='running' AND target IN ({marks})",
                (now, now, *targets),
            )
        return int(cur.rowcount)

    def requeue(self, order_no: str, target: str) -> ExportRequest | None:
        """실패한 요청을 같은 값으로 다시 대기시킨다(사람이 원인을 고친 뒤)."""
        now = self._iso()
        with self._immediate():
            row = self._db.execute(
                "SELECT * FROM export_requests WHERE order_no=? AND target=? AND status='failed'",
                (order_no, target),
            ).fetchone()
            if row is None:
                return None
            self._db.execute(
                "UPDATE export_requests SET status='pending', fail_reason=NULL, detail=NULL, "
                'attempts=0, notified=0, next_at=?, updated_at=? WHERE id=?',
                (now, now, row['id']),
            )
            row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def wait(
        self,
        request_id: int,
        timeout_s: float,
        *,
        poll_s: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> ExportRequest:
        """요청이 끝나길 기다린다. 제한 시간이 지나면 그때 상태 그대로 돌려준다."""
        if timeout_s <= 0:
            return self.get(request_id)
        deadline = monotonic() + timeout_s
        while True:
            req = self.get(request_id)
            if req.status in TERMINAL or monotonic() >= deadline:
                return req
            sleep(poll_s)

    def unnotified_failed(self) -> list[ExportRequest]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM export_requests WHERE status='failed' AND notified=0 ORDER BY id"
            ).fetchall()
        return [_to_request(r) for r in rows]

    def mark_notified(self, request_id: int) -> None:
        with self._immediate():
            self._db.execute(
                'UPDATE export_requests SET notified=1, updated_at=? WHERE id=?',
                (self._iso(), request_id),
            )

    def recent(self, limit: int = 20) -> list[ExportRequest]:
        with self._lock:
            rows = self._db.execute(
                'SELECT * FROM export_requests ORDER BY updated_at DESC, id DESC LIMIT ?',
                (limit,),
            ).fetchall()
        return [_to_request(r) for r in rows]

    def beat(self, targets: Sequence[str]) -> None:
        """입력 작업자가 살아 있고 이 대상을 맡고 있다는 표시."""
        now = self._iso()
        with self._immediate():
            for target in targets:
                self._db.execute(
                    'INSERT INTO export_heartbeat (target, beat_at) VALUES (?, ?) '
                    'ON CONFLICT(target) DO UPDATE SET beat_at=excluded.beat_at',
                    (target, now),
                )

    def has_older_pending(self, target: str, before_id: int) -> bool:
        """이 대상에 ``before_id`` 보다 먼저 들어온 대기 요청이 있는가.

        있으면 이 요청은 한참 뒤에나 집힐 테니 export 단계가 기다려도 소용없다
        (리뷰 지적 — I4 (b): alive() 만 보면 대기열이 밀려 있어도 주문마다 대기 시간을 다 쓴다).
        """
        with self._lock:
            row = self._db.execute(
                "SELECT 1 FROM export_requests WHERE target=? AND status='pending' "
                'AND id<? LIMIT 1',
                (target, before_id),
            ).fetchone()
        return row is not None

    def alive(self, target: str, within_s: float = 30.0) -> bool:
        """이 대상을 맡은 작업자가 최근에 표시를 남겼는가."""
        with self._lock:
            row = self._db.execute(
                'SELECT beat_at FROM export_heartbeat WHERE target=?', (target,)
            ).fetchone()
        if row is None:
            return False
        return row['beat_at'] >= self._iso(-within_s)
