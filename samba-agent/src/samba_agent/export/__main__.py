"""`python -m samba_agent.export` — 입력 작업자 실행과 큐 관리.

worker                   입력 작업자를 띄운다(관리자 권한으로 실행해야 EMP 에 입력된다)
list [--limit N]         최근 요청을 본다
requeue ORDER_NO TARGET  실패한 요청을 같은 값으로 다시 대기시킨다
"""

import argparse
import logging
import signal
import threading

from samba_agent.export.desktop import build_adapters
from samba_agent.export.idle import user_idle_seconds
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker
from samba_agent.settings import load_settings

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
    parser = argparse.ArgumentParser(prog='python -m samba_agent.export')
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('worker', help='입력 작업자를 띄운다')
    p_list = sub.add_parser('list', help='최근 요청을 본다')
    p_list.add_argument('--limit', type=int, default=20)
    p_requeue = sub.add_parser('requeue', help='실패한 요청을 다시 대기시킨다')
    p_requeue.add_argument('order_no')
    p_requeue.add_argument('target', choices=['emp', 'shopmine'])
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s.%(msecs)03d %(levelname)s:%(name)s:%(message)s',
        datefmt='%H:%M:%S',
    )
    queue = ExportQueue(load_settings().export_db_path)
    if args.cmd == 'list':
        return _list(queue, args.limit)
    if args.cmd == 'requeue':
        return _requeue(queue, args.order_no, args.target)
    return _worker(queue)


if __name__ == '__main__':
    raise SystemExit(main())
