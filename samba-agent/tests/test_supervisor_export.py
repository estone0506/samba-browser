# 감독자 — export 노드는 검증 뒤에 돌고, 어떤 경우에도 주문 결과를 바꾸지 않는다
import pytest

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor

ORDER = OrderRef(order_no='A1', source='무신사', seller='GS이숍(캐논)', sku='S1', qty=1)


def ok(name: str, **payload) -> AgentResult:
    return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)


def agents(**over):
    base = {
        'buyer.musinsa': lambda _a: ok(
            'buyer', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5
        ),
        'payer': lambda _a: ok('payer'),
        'recorder': lambda _a: ok('recorder', values={'real_price': 62470, 'shipping_fee': 2300}),
        'verifier': lambda _a: ok('verifier'),
    }
    base.update(over)
    return base


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def run(reg, agents_map, exporter=None, **hooks) -> dict:
    graph = build_supervisor(reg, agents_map, exporter=exporter, **hooks)
    return graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True})


def test_exporter_가_없으면_그래프는_예전과_같다(reg):
    out = run(reg, agents())
    assert out['outcome'] == 'done'
    assert list(out['results']) == ['buyer.musinsa', 'payer', 'recorder', 'verifier']


def test_export_는_검증_뒤에_돈다(reg):
    seen: list[list[str]] = []

    def exporter(state):
        seen.append(list(state['results']))
        return ok('exporter', export='done')

    out = run(reg, agents(), exporter)
    assert seen == [['buyer.musinsa', 'payer', 'recorder', 'verifier']]
    assert out['outcome'] == 'done'
    assert list(out['results'])[-1] == 'exporter'
    assert out['results']['exporter'].payload['export'] == 'done'


def test_export_는_기록_결과를_본다(reg):
    got: dict = {}

    def exporter(state):
        got.update(state['results']['recorder'].payload['values'])
        return ok('exporter', export='done')

    run(reg, agents(), exporter)
    assert got == {'real_price': 62470, 'shipping_fee': 2300}


def test_export_가_예외를_던져도_주문은_done(reg):
    def exporter(_state):
        raise RuntimeError('큐 파일을 못 연다')

    out = run(reg, agents(), exporter)
    assert out['outcome'] == 'done'
    assert out['fail_reason'] is None
    assert out['results']['exporter'].status == 'ok'
    assert out['results']['exporter'].payload == {'export': 'error'}


def test_export_가_실패_결과를_돌려줘도_주문은_done(reg):
    def exporter(_state):
        return AgentResult(status='fail', reason='잘못된 구현', fail_reason=FailReason.UNKNOWN)

    out = run(reg, agents(), exporter)
    assert out['outcome'] == 'done'
    assert out['fail_reason'] is None


def test_검증이_실패하면_export_는_돌지_않는다(reg):
    calls = {'n': 0}

    def exporter(_state):
        calls['n'] += 1
        return ok('exporter', export='done')

    def bad_verifier(_a):
        return AgentResult(status='fail', reason='불일치', fail_reason=FailReason.VERIFY_MISMATCH)

    out = run(reg, agents(verifier=bad_verifier), exporter)
    assert out['outcome'] == 'needs_human'
    assert calls['n'] == 0
    assert 'exporter' not in out['results']


def test_export_근거가_state_에_쌓인다(reg):
    from samba_agent.agents.contracts import Evidence

    def exporter(_state):
        return AgentResult(
            status='ok',
            reason='기입',
            payload={'export': 'done'},
            evidence=(Evidence(label='외부 기입', detail='emp 에 기입'),),
        )

    out = run(reg, agents(), exporter)
    assert out['evidence'][-1].label == '외부 기입'


def test_export_도_에이전트_결과_훅에_남는다(reg):
    seen: list[tuple[str, str, str]] = []

    def hook(_state, stage, name, result, _ms, _attempt):
        seen.append((stage, name, result.status))

    run(reg, agents(), lambda _s: ok('exporter', export='done'), on_agent_result=hook)
    assert seen[-1] == ('export', 'exporter', 'ok')
