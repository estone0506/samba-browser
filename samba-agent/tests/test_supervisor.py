# 감독자 — 배정 / 결과 검사 / 재시도 1회 / needs_human / 결제 무재시도 / 미지원 / 권한 부족
import pytest

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeError
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor

ORDER = OrderRef(order_no='734501000740906', source='무신사', seller='포이즌', sku='S1', qty=1)


def ok(name: str, **payload) -> AgentResult:
    return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)


def buyer_ok(_a) -> AgentResult:
    return ok('buyer', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5)


def plain_ok(_a) -> AgentResult:
    return ok('agent')


def agents(**over):
    base = {
        'buyer.musinsa': buyer_ok,
        'payer': plain_ok,
        'recorder': plain_ok,
        'verifier': plain_ok,
    }
    base.update(over)
    return base


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def run(reg, agents_map, order: OrderRef = ORDER, options=None) -> dict:
    graph = build_supervisor(reg, agents_map)
    return graph.invoke({'order': order, 'options': options or {}, 'job_id': 1, 'dry_run': True})


def test_정상_한_건은_네_단계를_거쳐_done(reg):
    out = run(reg, agents())
    assert out['outcome'] == 'done'
    assert list(out['results']) == ['buyer.musinsa', 'payer', 'recorder', 'verifier']
    assert out['results']['buyer.musinsa'].payload['card'] == '현대'


def test_구매_실패는_한_번_재시도하고_그래도_실패면_사람에게(reg):
    calls = {'n': 0}

    def flaky(_a):
        calls['n'] += 1
        return AgentResult(status='fail', reason='품절', fail_reason=FailReason.OUT_OF_STOCK)

    out = run(reg, agents(**{'buyer.musinsa': flaky}))
    assert calls['n'] == 2  # 최초 1 + 재시도 1
    assert out['outcome'] == 'needs_human'
    assert out['fail_reason'] is FailReason.OUT_OF_STOCK
    assert 'payer' not in out['results']  # 결제까지 가지 않는다


def test_재시도해서_성공하면_계속_간다(reg):
    calls = {'n': 0}

    def flaky(a):
        calls['n'] += 1
        if calls['n'] == 1:
            return AgentResult(
                status='fail', reason='브릿지 끊김', fail_reason=FailReason.BRIDGE_DOWN
            )
        return buyer_ok(a)

    out = run(reg, agents(**{'buyer.musinsa': flaky}))
    assert out['outcome'] == 'done'
    assert out['attempts']['buyer.musinsa'] == 2


def test_결제_에이전트는_재시도하지_않는다(reg):
    calls = {'n': 0}

    def failing_payer(_a):
        calls['n'] += 1
        return AgentResult(status='fail', reason='승인 거절', fail_reason=FailReason.UNKNOWN)

    out = run(reg, agents(payer=failing_payer))
    assert calls['n'] == 1  # 재결제 위험 — 한 번뿐
    assert out['outcome'] == 'needs_human'


def test_needs_human_은_재시도_없이_바로_멈춘다(reg):
    calls = {'n': 0}

    def captcha(_a):
        calls['n'] += 1
        return AgentResult(status='needs_human', reason='캡차', fail_reason=FailReason.CAPTCHA)

    out = run(reg, agents(**{'buyer.musinsa': captcha}))
    assert calls['n'] == 1
    assert out['fail_reason'] is FailReason.CAPTCHA


def test_카드가_없으면_감독자가_결제로_넘기지_않는다(reg):
    def no_card(_a):
        return ok('buyer', account='a***@x.com', cost=89000, margin_pct=12.5)

    out = run(reg, agents(**{'buyer.musinsa': no_card}))
    assert out['outcome'] == 'needs_human'
    assert out['fail_reason'] is FailReason.CARD_MISSING
    assert 'payer' not in out['results']


def test_카드가_없으면_재시도하지_않는다(reg):
    calls = {'n': 0}

    def no_card(_a):
        calls['n'] += 1
        return ok('buyer', account='a***@x.com', cost=89000, margin_pct=12.5)

    out = run(reg, agents(**{'buyer.musinsa': no_card}))
    assert calls['n'] == 1  # 다시 해도 카드가 안 생긴다 — 재시도 없이 바로 사람에게
    assert out['fail_reason'] is FailReason.CARD_MISSING


def test_마진이_미달이면_결제로_넘기지_않는다(reg):
    def thin(_a):
        return ok('buyer', account='a***@x.com', card='현대', cost=89000, margin_pct=-1.0)

    out = run(reg, agents(**{'buyer.musinsa': thin}))
    assert out['fail_reason'] is FailReason.MARGIN


def test_모르는_소싱처는_바로_사람에게(reg):
    out = run(reg, agents(), order=ORDER.model_copy(update={'source': '쿠팡'}))
    assert out['outcome'] == 'needs_human'
    assert 'unsupported' in out['results']['supervisor'].reason


def test_허용_목록_밖_도구를_부르면_권한_부족으로_끝난다(reg):
    def sneaky(_a):
        raise BridgeError(FailReason.PERMISSION_DENIED, '허용 목록 밖 도구: phone_approve_payment')

    out = run(reg, agents(**{'buyer.musinsa': sneaky}))
    assert out['outcome'] == 'needs_human'
    assert out['fail_reason'] is FailReason.PERMISSION_DENIED
    assert out['attempts']['buyer.musinsa'] == 1  # 권한 부족은 재시도하지 않는다(스펙 §6)


def test_감독자는_에이전트에_허용_도구와_규칙만_넘긴다(reg):
    seen = {}

    def spy(a):
        seen['tools'] = a.allowed_tools
        seen['rules'] = a.rules
        seen['dry_run'] = a.dry_run
        return buyer_ok(a)

    run(reg, agents(**{'buyer.musinsa': spy}))
    assert 'phone_approve_payment' not in seen['tools']
    assert '원가 규칙' in seen['rules']
    assert seen['dry_run'] is True
