"""하네스 읽기 API — 앱의 자동화 페이지(플랜 3/3)가 5초마다 읽는다(스펙 §4.4b).

127.0.0.1 에만 뜬다. 브릿지와 반대 방향(앱 → 하네스)이라 토큰은 쓰지 않는다.
쓰기는 규칙 파일 수정 하나뿐이고, 고치면 새 harness_version 이 된다.
"""

import json
from collections.abc import Callable
from pathlib import Path

from werkzeug.wrappers import Request, Response

from samba_agent.agents.registry import Registry
from samba_agent.ops.releases import ReleaseStore
from samba_agent.queue.db import JobQueue
from samba_agent.supervisor.policy import STAGES

DEFAULT_PORT = 47812


def build_app(
    *,
    reg: Registry,
    queue: JobQueue,
    releases: ReleaseStore,
    root: Path,
    version: Callable[[], str],
) -> Callable:
    """WSGI 앱. 라우팅이 4개뿐이라 프레임워크를 들이지 않는다."""

    def app(environ, start_response):  # type: ignore[no-untyped-def]
        req = Request(environ)
        path = req.path
        if req.method == 'GET' and path == '/graph':
            resp = _get_graph(reg, version)
        elif req.method == 'GET' and path == '/jobs':
            resp = _get_jobs(queue)
        elif req.method == 'GET' and path == '/releases':
            resp = _get_releases(releases, version)
        elif req.method == 'PUT' and path.startswith('/graph/rules/'):
            resp = _put_rules(reg, root, version, path[len('/graph/rules/') :], req)
        else:
            resp = _json({'error': 'not found'}, 404)
        return resp(environ, start_response)

    return app


def _get_graph(reg: Registry, version: Callable[[], str]) -> Response:
    return _json(
        {
            'version': version(),
            'stages': list(STAGES),
            'agents': [
                {
                    'name': s.name,
                    'kind': s.kind,
                    'match': s.match,
                    'tools': list(s.tools),
                    'rules': s.rules,
                    'retry': s.retry,
                }
                for s in [reg[n] for n in reg.names()]
            ],
        }
    )


def _get_jobs(queue: JobQueue) -> Response:
    return _json(
        {
            'jobs': [
                {
                    'order_no': j.order_no,
                    'state': j.state,
                    'assignee_agent': j.assignee_agent,
                    'step': j.step,
                    'requester': j.requester,
                    'harness_version': j.harness_version,
                    'attempts': j.attempts,
                    'updated_at': j.updated_at,
                }
                for j in queue.live()
            ]
        }
    )


def _get_releases(releases: ReleaseStore, version: Callable[[], str]) -> Response:
    current = releases.current_prod()
    return _json(
        {
            'current': current.__dict__ if current else None,
            'history': [r.__dict__ for r in releases.history()],
            'candidate': _candidate(version()),
        }
    )


def _put_rules(
    reg: Registry, root: Path, version: Callable[[], str], name: str, req: Request
) -> Response:
    """규칙 파일 수정. 고치면 새 버전이 되어 판정 시스템을 다시 통과해야 한다."""
    if '/' in name or '..' in name or '%2f' in name.lower():
        return _json({'error': 'bad name'}, 400)
    try:
        spec = reg[name]
    except KeyError:
        return _json({'error': f'unknown agent: {name}'}, 404)
    try:
        body = json.loads(req.get_data(as_text=True) or '{}')
    except ValueError:
        return _json({'error': 'bad json'}, 400)
    if not isinstance(body, dict):
        return _json({'error': 'bad json'}, 400)
    text = str(body.get('text', ''))
    if not text.strip():
        return _json({'error': 'empty rules'}, 400)
    rules_path = (root / spec.rules).resolve()
    # 등록부 경로 자체가 탈출하지 않는 한 여기까지 오지만, 한 번 더 root 밖으로
    # 안 나가는지 확인한다(스펙 §10-3 — 실패 케이스는 항상 한 번 더 검사한다)
    if root.resolve() not in rules_path.parents and rules_path != root.resolve():
        return _json({'error': 'bad path'}, 400)
    rules_path.write_text(text, encoding='utf-8')
    return _json({'ok': True, 'version': version()})


def _candidate(version: str) -> dict[str, object] | None:
    """후보 버전의 판정 요약. 아직 판정 파일이 없으면 None."""
    from samba_agent.ops.gate import REPORT_DIR

    path = REPORT_DIR / f'{version}.md'
    if not path.exists():
        return None
    return {'version': version, 'report': path.read_text(encoding='utf-8')}


def _json(body: object, status: int = 200) -> Response:
    return Response(
        json.dumps(body, ensure_ascii=False, default=str),
        status=status,
        content_type='application/json; charset=utf-8',
    )


def serve(app: Callable, host: str = '127.0.0.1', port: int = DEFAULT_PORT) -> None:
    """WSGI 서버를 띄운다. 127.0.0.1 만 바인딩한다(스펙 §4.4b — 외부 인터페이스 금지)."""
    from werkzeug.serving import make_server

    make_server(host, port, app).serve_forever()
