"""`python -m samba_agent.export` — 입력 작업자 실행과 큐 관리.

worker                   입력 작업자를 띄운다(관리자 권한으로 실행해야 EMP 에 입력된다)
list [--limit N]         최근 요청을 본다
requeue ORDER_NO TARGET  실패한 요청을 같은 값으로 다시 대기시킨다
"""

import argparse
import logging
import signal
import sys
import threading
from pathlib import Path
from typing import get_args

from samba_agent.export.desktop import build_adapters
from samba_agent.export.idle import user_idle_seconds
from samba_agent.export.routing import Target
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker
from samba_agent.settings import DEFAULT_ROOT, load_settings

log = logging.getLogger(__name__)


def _list(queue: ExportQueue, limit: int) -> int:
    rows = queue.recent(limit)
    if not rows:
        print('외부 기입 요청이 없다')
        return 0
    for r in rows:
        tail = f' {r.fail_reason}: {r.detail}' if r.fail_reason else f' {r.detail or ""}'
        print(
            f'{r.updated_at} {r.order_no} {r.target} {r.status}'
            f' 원가 {r.cost:,} 배송비 {r.shipping_fee:,} 시도 {r.attempts}{tail}'
        )
    return 0


def _requeue(queue: ExportQueue, order_no: str, target: str) -> int:
    req = queue.requeue(order_no, target)
    if req is None:
        print(f'{order_no}({target}) 실패한 요청이 없다')
        return 1
    print(f'{req.order_no}({req.target}) 다시 대기 — 원가 {req.cost:,} 배송비 {req.shipping_fee:,}')
    return 0


def _worker(queue: ExportQueue) -> int:
    adapters = build_adapters()
    if not adapters:
        log.warning('등록된 어댑터가 없다 — 요청은 큐에 대기로 남는다')
    recovered = queue.recover_running(tuple(adapters))
    if recovered:
        log.info('도중에 끊긴 요청 %d건을 되돌렸다', recovered)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_a: stop.set())
    signal.signal(signal.SIGTERM, lambda *_a: stop.set())
    log.info('입력 작업자 시작 — 대상 %s', ', '.join(adapters) or '없음')
    ExportWorker(queue, adapters, user_idle_s=user_idle_seconds).run_forever(stop.is_set)
    return 0


def main(argv: list[str] | None = None) -> int:
    # 예약 작업(Task Scheduler)의 콘솔은 cp949 라 한글 로그·print 가 UnicodeEncodeError 로 죽는다.
    # reconfigure 가 없는 스트림(테스트의 캡처 버퍼 등)은 건드리지 않는다.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(prog='python -m samba_agent.export')
    # 예약 작업(Task Scheduler)은 System32 에서 시작해 cwd 기준 .env 를 못 찾는다 — 항상
    # 하네스 폴더의 .env 를 읽는다. --db 는 그 값을 다시 덮어써(예: 시험 삼아 다른 파일을 볼 때) 쓴다.
    parser.add_argument('--db', type=Path, default=None, help='큐 파일 경로(설정값을 덮어쓴다)')
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('worker', help='입력 작업자를 띄운다')
    p_list = sub.add_parser('list', help='최근 요청을 본다')
    p_list.add_argument('--limit', type=int, default=20)
    p_requeue = sub.add_parser('requeue', help='실패한 요청을 다시 대기시킨다')
    p_requeue.add_argument('order_no')
    p_requeue.add_argument('target', choices=list(get_args(Target)))
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s.%(msecs)03d %(levelname)s:%(name)s:%(message)s',
        datefmt='%H:%M:%S',
    )
    db_path = (
        args.db if args.db is not None else load_settings(DEFAULT_ROOT / '.env').export_db_path
    )
    queue = ExportQueue(db_path)
    if args.cmd == 'list':
        return _list(queue, args.limit)
    if args.cmd == 'requeue':
        return _requeue(queue, args.order_no, args.target)
    return _worker(queue)


if __name__ == '__main__':
    raise SystemExit(main())
