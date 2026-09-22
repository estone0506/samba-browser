# 사람 검토 게이트 — 승인 전에는 결제·기록이 돌지 않는다 / 거부 / 재개 / 재시작 뒤 재개
import pytest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.approval import APPROVAL_INTERRUPT_KEY
from samba_agent.supervisor.graph import build_supervisor

ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def agents(log: list[str]):
    def mk(name: str, **payload):
        def fn(_a):
            log.append(name)
            return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)

        return fn

    return {
        'buyer.musinsa': mk('buy', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5),
        'payer': mk('pay', paid=True),
        'recorder': mk('record', saved=True),
        'verifier': mk('verify'),
    }


def graph_of(reg, log):
    return build_supervisor(reg, agents(log), checkpointer=MemorySaver(), gate=True)


CFG = {'configurable': {'thread_id': 'job:1'}}


def test_결제_직전에_멈추고_요약을_내놓는다(reg):
    log: list[str] = []
    out = graph_of(reg, log).invoke(
        {'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG
    )
    assert log == ['buy']  # 결제는 아직 돌지 않았다
    req = out['__interrupt__'][0].value
    assert req['kind'] == APPROVAL_INTERRUPT_KEY
    assert req['stage'] == 'pay'
    assert '현대' in req['summary'] and '89,000' in req['summary']


def test_승인하면_결제_기록까지_이어진다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    g.invoke(Command(resume={'approved': True, 'by': 'U1'}), CFG)  # 결제 승인
    out = g.invoke(Command(resume={'approved': True, 'by': 'U1'}), CFG)  # 기록 승인
    assert log == ['buy', 'pay', 'record', 'verify']
    assert out['outcome'] == 'done'
    assert out['approvals'] == {'pay': 'U1', 'record': 'U1'}


def test_거부하면_외부를_바꾸지_않고_사람에게_넘긴다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    out = g.invoke(Command(resume={'approved': False, 'by': 'U1'}), CFG)
    assert log == ['buy']
    assert out['outcome'] == 'needs_human'
    assert out['fail_reason'] is FailReason.PERMISSION_DENIED


def test_기록_단계에도_따로_승인을_받는다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    out = g.invoke(Command(resume={'approved': True, 'by': 'U1'}), CFG)
    assert log == ['buy', 'pay']
    assert out['__interrupt__'][0].value['stage'] == 'record'


def test_dry_run_이어도_게이트는_뜬다(reg):
    log: list[str] = []
    out = build_supervisor(reg, agents(log), checkpointer=MemorySaver(), gate=True).invoke(
        {'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG
    )
    assert '__interrupt__' in out


def test_게이트를_끄면_예전처럼_쭉_돈다(reg):
    log: list[str] = []
    out = build_supervisor(reg, agents(log)).invoke(
        {'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}
    )
    assert out['outcome'] == 'done'
    assert log == ['buy', 'pay', 'record', 'verify']


def test_같은_스레드로_다시_부르면_중복_실행되지_않는다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    assert log.count('buy') == 1  # 체크포인트가 있어 구매를 다시 하지 않는다
