# 등록부 — 조건으로 에이전트를 고르고, 없으면 None, 도구 오타는 로딩에서 막는다
import pytest
from pydantic import ValidationError

from samba_agent.agents.contracts import AgentResult, Assignment, Evidence, OrderRef
from samba_agent.agents.registry import AgentSpec, Registry
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def _order(source: str = '무신사', seller: str = '포이즌') -> OrderRef:
    return OrderRef(order_no='734501000740906', source=source, seller=seller, sku='SKU-1', qty=1)


def test_소싱처로_구매_에이전트를_고른다(reg):
    assert reg.pick('buyer', _order('무신사'), {}).name == 'buyer.musinsa'
    assert reg.pick('buyer', _order('29CM'), {}).name == 'buyer.29cm'
    assert reg.pick('buyer', _order('ABC마트'), {}).name == 'buyer.abc'
    assert reg.pick('buyer', _order('롯데온'), {}).name == 'buyer.lotteon'


def test_모르는_소싱처는_고르지_못한다(reg):
    assert reg.pick('buyer', _order('쿠팡'), {}) is None


def test_결제_기록_검증은_소싱처와_무관하게_하나다(reg):
    for kind, name in (('payer', 'payer'), ('recorder', 'recorder'), ('verifier', 'verifier')):
        assert reg.pick(kind, _order('무신사'), {}).name == name


def test_결제_에이전트는_재시도가_없다(reg):
    assert reg['payer'].retry == 0  # 재결제 위험(스펙 §4.3-4)
    assert reg['buyer.musinsa'].retry == 1


def test_허용_도구는_브릿지_도구_이름이다(reg):
    assert 'phone_approve_payment' in reg['payer'].tools
    assert 'phone_approve_payment' not in reg['recorder'].tools
    assert 'run_script' in reg['recorder'].tools


def test_규칙_파일이_실제로_있다(reg):
    for spec in reg.of_kind('buyer') + reg.of_kind('payer'):
        assert reg.rules_text(spec).strip() != ''


def test_없는_도구가_적히면_로딩을_거부한다(tmp_path):
    (tmp_path / 'rules').mkdir()
    (tmp_path / 'rules' / 'x.md').write_text('규칙', encoding='utf-8')
    (tmp_path / 'registry.yaml').write_text(
        'agents:\n'
        '  - name: buyer.x\n'
        '    kind: buyer\n'
        '    match: {source: X}\n'
        '    tools: [get_page, 없는도구]\n'
        '    rules: rules/x.md\n'
        '    prompts: p\n'
        '    dataset: d\n'
        '    retry: 1\n',
        encoding='utf-8',
    )
    with pytest.raises(ValueError, match='브릿지에 없는 도구'):
        Registry.load(tmp_path)


def test_결과_계약_실패에는_사유가_있어야_한다():
    ok = AgentResult(status='ok', reason='옵션 260 일치', payload={'cost': 89000})
    assert ok.fail_reason is None
    with pytest.raises(ValidationError):
        AgentResult(status='fail', reason='품절')  # 사유가 없다
    bad = AgentResult(status='fail', reason='품절', fail_reason=FailReason.OUT_OF_STOCK)
    assert bad.fail_reason is FailReason.OUT_OF_STOCK
    with pytest.raises(ValidationError):
        AgentResult(status='ok', reason='')  # 근거 없는 판단은 못 낸다


def test_배정은_허용_도구와_규칙을_함께_넘긴다(reg):
    spec = reg['buyer.musinsa']
    a = Assignment(
        order=_order(),
        options={'card': '현대'},
        account_candidates=('a***@x.com',),
        evidence_so_far=(Evidence(label='장바구니', detail='1건'),),
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=True,
    )
    assert 'run_js' in a.allowed_tools
    assert 'phone_approve_payment' not in a.allowed_tools
    assert a.dry_run is True


def test_등록부의_모르는_필드는_거부한다() -> None:
    """registry.yaml 에 필드명을 잘못 쓰면(예: macth) 조용히 무시되지 않고 로딩이 실패해야 한다."""
    with pytest.raises(ValidationError):
        AgentSpec(name='x', kind='buyer', tools=['get_page'], rules='r.md', macth={'source': 'a'})
