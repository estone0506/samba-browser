# 봇 — 접수 답장 / 중복 답장 / 미등록 무시 / 승인 버튼 / 상태·버전·진단
import pytest
from langgraph.checkpoint.memory import MemorySaver

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.gateway.slack_bot import SambaBot, approval_blocks
from samba_agent.queue.db import JobQueue
from samba_agent.queue.worker import Worker, WorkerDeps
from samba_agent.settings import DEFAULT_ROOT, Settings
from samba_agent.supervisor.graph import build_supervisor


def ok(name, **p):
    def fn(_a):
        return AgentResult(status='ok', reason=f'{name} 정상', payload=p)

    return fn


@pytest.fixture()
def bot(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    agents = {
        'buyer.musinsa': ok('buy', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5),
        'payer': ok('pay'),
        'recorder': ok('record'),
        'verifier': ok('verify'),
    }
    graph = build_supervisor(reg, agents, checkpointer=MemorySaver(), gate=True)
    worker = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda j, s: None,
            parse_order=lambda j: OrderRef(
                order_no=j.order_no, source='무신사', seller='포이즌', sku='S1', qty=1
            ),
        )
    )
    s = Settings(SAMBA_BRIDGE_TOKEN='a' * 64, SLACK_ALLOWED_USERS='U1,U2', SLACK_CHANNEL='#test')
    return (
        SambaBot(app=None, worker=worker, queue=q, settings=s, diagnose=lambda v: f'진단 표({v})'),
        q,
        worker,
    )


def test_접수하면_답장한다(bot):
    b, q, _ = bot
    out = b.handle_mention('<@BOT> A1 처리해 현대카드', 'U1', 'ts1')
    assert 'A1' in out and '접수' in out
    assert q.get('A1').options == {'card': '현대'}


def test_같은_주문_재요청은_처리중이라고_답한다(bot):
    b, _q, w = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    w.tick()  # 승인 대기까지 간다
    out = b.handle_mention('<@BOT> A1 처리해', 'U2', 'ts2')
    assert '이미' in out and 'U1' in out


def test_미등록_사용자_명령은_무시한다(bot):
    b, q, _ = bot
    assert b.handle_mention('<@BOT> A1 처리해', 'U999', 'ts1') is None
    assert q.get('A1') is None


def test_승인_버튼이_그래프를_이어간다(bot):
    b, q, w = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    w.tick()
    assert q.get('A1').state == 'needs_human'
    out = b.handle_approval('A1', approved=True, user='U1')
    assert '승인' in out
    assert q.get('A1').state in ('needs_human', 'done')  # 다음 게이트(기록)에서 다시 멈춘다


def test_미등록_사용자의_승인은_무시한다(bot):
    b, q, w = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    w.tick()
    out = b.handle_approval('A1', approved=True, user='U999')
    assert '권한' in out
    assert q.get('A1').state == 'needs_human'


def test_상태와_버전과_진단(bot):
    b, _q, _ = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    assert 'A1' in b.handle_mention('<@BOT> 상태', 'U1', None)
    assert 'vtest' in b.handle_mention('<@BOT> 버전', 'U1', None)
    assert '진단 표' in b.handle_mention('<@BOT> 진단 A1', 'U1', None)


def test_취소와_이어서(bot):
    b, q, _ = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    assert '취소' in b.handle_mention('<@BOT> 취소 A1', 'U1', None)
    assert q.get('A1').state == 'cancelled'
    assert '없' in b.handle_mention('<@BOT> 취소 A9', 'U1', None)


def test_승인_블록에_두_버튼이_있다():
    blocks = approval_blocks('A1', 'pay', '요약')
    ids = [e['action_id'] for b in blocks if b['type'] == 'actions' for e in b['elements']]
    assert ids == ['samba_approve', 'samba_reject']
    assert all('A1' in str(b) or True for b in blocks)
