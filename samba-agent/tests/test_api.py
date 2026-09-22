# samba-agent/tests/test_api.py
# 하네스 API — 그래프 / 작업 / 판정 / 규칙 수정 / 없는 에이전트 / 경로 탈출
import json
import shutil

import pytest
from werkzeug.test import Client  # wsgi 테스트용(dev 의존성)

from samba_agent.agents.registry import Registry
from samba_agent.api.server import build_app
from samba_agent.ops.releases import Release, ReleaseStore
from samba_agent.queue.db import JobQueue
from samba_agent.settings import DEFAULT_ROOT


@pytest.fixture()
def client(tmp_path):
    # 규칙 파일을 고치는 시험이 있으니 저장소를 tmp 로 복사해 쓴다(실제 rules/ 를 건드리지 않는다)
    root = tmp_path / 'root'
    shutil.copytree(DEFAULT_ROOT / 'rules', root / 'rules')
    shutil.copy(DEFAULT_ROOT / 'registry.yaml', root / 'registry.yaml')
    reg = Registry.load(root)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    q.enqueue('A1', 'U1', {'card': '현대'}, 'ts1')
    rel = ReleaseStore(tmp_path / 'releases.sqlite')
    rel.record(
        Release(
            version='v1',
            verdict='promote',
            decided_by='U1',
            decided_at='2026-09-22T10:00:00+00:00',
            report_path='r',
            prompt_commits={},
        )
    )
    app = build_app(reg=reg, queue=q, releases=rel, root=root, version=lambda: 'vtest')
    return Client(app)


def _json(resp):
    return json.loads(resp.get_data(as_text=True))


def test_graph_는_등록부와_단계를_준다(client):
    body = _json(client.get('/graph'))
    assert body['stages'] == ['buy', 'pay', 'record', 'verify']
    assert any(a['name'] == 'buyer.musinsa' for a in body['agents'])
    assert body['version'] == 'vtest'


def test_jobs_는_현재_배정과_단계를_준다(client):
    body = _json(client.get('/jobs'))
    assert body['jobs'][0]['order_no'] == 'A1'
    assert body['jobs'][0]['state'] == 'queued'


def test_releases_는_운영과_이력을_준다(client):
    body = _json(client.get('/releases'))
    assert body['current']['version'] == 'v1'
    assert len(body['history']) == 1


def test_규칙을_고치면_새_버전을_돌려준다(client):
    resp = client.put('/graph/rules/payer', json={'text': '# 결제 규칙 v2\n'})
    assert resp.status_code == 200
    assert _json(resp)['ok'] is True
    assert client.put('/graph/rules/payer', json={'text': '   '}).status_code == 400


def test_없는_에이전트는_404(client):
    assert client.put('/graph/rules/nope', json={'text': 'x'}).status_code == 404


def test_경로_탈출은_400(client):
    assert client.put('/graph/rules/..%2F..%2Fetc', json={'text': 'x'}).status_code == 400


def test_모르는_경로는_404(client):
    assert client.get('/nope').status_code == 404


def test_규칙_본문이_256KB_넘으면_413(client):
    big = {'text': 'a' * (256 * 1024 + 1)}
    resp = client.put('/graph/rules/payer', json=big)
    assert resp.status_code == 413


def test_규칙_쓰기는_원자적이다(tmp_path, client):
    # 파일 내용이 그대로 반영되고, 임시 파일이 안 남는지 확인한다(리뷰 지적 — Important 3)
    resp = client.put('/graph/rules/payer', json={'text': '# 원자적 쓰기 시험\n'})
    assert resp.status_code == 200
    # fixture 의 root 는 tmp_path / 'root' 다
    rules_dir = tmp_path / 'root' / 'rules'
    payer_files = list(rules_dir.glob('payer*'))
    assert payer_files, 'payer 규칙 파일을 찾지 못함'
    payer_path = payer_files[0]
    assert payer_path.read_text(encoding='utf-8') == '# 원자적 쓰기 시험\n'
    tmp_leftovers = list(rules_dir.glob('.*tmp*'))
    assert tmp_leftovers == []


def test_candidate는_root_기준_ops_reports를_본다(tmp_path, client):
    # 리뷰 지적 — Minor 5: ops.gate.REPORT_DIR 고정 경로가 아니라 root 기준으로 읽는지 확인
    reports = tmp_path / 'root' / 'ops' / 'reports'
    reports.mkdir(parents=True)
    (reports / 'vtest.md').write_text('# 판정 — vtest\n', encoding='utf-8')
    body = _json(client.get('/releases'))
    assert body['candidate'] == {'version': 'vtest', 'report': '# 판정 — vtest\n'}
