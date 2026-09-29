"""품절 빠른 종료 — 품절 표시가 확인되면 수리·재시도하지 않는다(2026-09-26 실기: 품절 1건 10~20분)."""

from samba_agent.agents.buyer import (
    CONFIRMED_SOLD_OUT,
    is_confirmed_sold_out_skip,
    matching_options,
    snapshot_problem,
    sold_out_option_listed,
)
from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import AgentSpec
from samba_agent.failures import FailReason
from samba_agent.supervisor.policy import should_retry


def test_주문_옵션이_품절_표시로_떠_있으면_확정_품절이다() -> None:
    assert sold_out_option_listed(['240 (품절)', '250'], '240')
    assert sold_out_option_listed(['[품절] 240', '250'], '240')
    # 목록에 아예 없으면 스크립트가 엉뚱한 목록을 읽었을 수 있다 — 확정 아님
    assert not sold_out_option_listed(['250', '260'], '240')
    assert not sold_out_option_listed([], '240')


def test_품절_표시면_스냅샷_수리를_하지_않는다() -> None:
    check = snapshot_problem('240')
    assert check({'options': ['240 품절', '250'], 'cost': 0, 'methods': []}) is None
    # 숫자가 하나도 안 겹치면 여전히 수리 대상
    assert '맞는 선택지가 없다' in (check({'options': ['270', '275'], 'cost': 1, 'methods': ['x'], 'selected': '270'}) or '')


def test_확정_품절_사유만_골라낸다() -> None:
    assert is_confirmed_sold_out_skip("buyer01: 주문 옵션 품절 표시 ['240 (품절)', '250']")
    assert not is_confirmed_sold_out_skip("buyer01: 옵션 불일치 ['ONE']")
    assert not is_confirmed_sold_out_skip('buyer01: 원가 못 읽음(None)')


def test_프리사이즈_표기_차이는_같은_옵션이다() -> None:
    assert matching_options(['ONE'], 'BLACK FREE') == ['ONE']
    assert matching_options(['FREE'], 'ONE SIZE') == ['FREE']


def test_한_글자_선택지는_주문_옵션_글자_안에_있다고_고르지_않는다() -> None:
    # 'L' 이 'BLACK' 안에 있다고 L 사이즈를 사면 안 된다
    assert matching_options(['S', 'M', 'L'], 'BLACK FREE') == []
    assert matching_options(['S', 'M', 'L'], 'M') == ['M']


def test_확정_품절은_재시도하지_않는다() -> None:
    spec = AgentSpec(name='buyer.musinsa', kind='buyer', match={}, tools=[], rules='', prompts='', dataset='', retry=1)
    sold = AgentResult(status='fail', reason=f'{CONFIRMED_SOLD_OUT}: a — x', fail_reason=FailReason.OUT_OF_STOCK)
    other = AgentResult(status='fail', reason='모든 계정에서 살 수 없다(품절·실패): a — x', fail_reason=FailReason.OUT_OF_STOCK)
    assert not should_retry(spec, sold, 1)
    assert should_retry(spec, other, 1)
