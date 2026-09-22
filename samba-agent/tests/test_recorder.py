# 기록 에이전트 — dry-run / 저장 후 재확인 / 한 필드라도 다르면 실패 / 브릿지 끊김
import httpx
import pytest
import respx

from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.recorder import RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)
EXPECTED = {
    'account': 'a***@x.com',
    'source_order_no': 'M-777',
    'real_price': 89000,
    'shipping_fee': 0,
    'flags': '직배',
}


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(reg, *, dry_run: bool) -> Assignment:
    spec = reg['recorder']
    return Assignment(
        order=ORDER,
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
        expected=EXPECTED,
    )


def agent(reg) -> RecorderAgent:
    spec = reg['recorder']
    return RecorderAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='포이즌 주문 자동 처리', reason='주문번호와 소싱처를 적었다'),
    )


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@respx.mock
def test_dry_run_은_저장하지_않고_계획만_준다(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    save = respx.post(f'{URL}/tool/run_script')
    out = agent(reg)(assignment(reg, dry_run=True))
    assert out.status == 'ok'
    assert out.payload['planned']['source_order_no'] == 'M-777'
    assert not save.called


@respx.mock
def test_저장하고_각_필드를_다시_읽어_확인한다(reg):
    import json

    saved = json.dumps({**EXPECTED, 'memo': '포이즌 주문 자동 처리'}, ensure_ascii=False)
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page('saved'), page(saved)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['saved'] is True
    assert route.call_count == 2


@respx.mock
def test_한_필드라도_다르면_실패하고_재결제하지_않는다(reg):
    import json

    wrong = json.dumps(
        {**EXPECTED, 'real_price': 12345, 'memo': '포이즌 주문 자동 처리'}, ensure_ascii=False
    )
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page('saved'), page(wrong)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert 'real_price' in out.reason


@respx.mock
def test_브릿지가_끊기면_bridge_down(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/run_script').mock(side_effect=httpx.ConnectError('refused'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.fail_reason is FailReason.BRIDGE_DOWN


@respx.mock
def test_허용_목록_밖_도구는_거절되고_저장을_시도하지_않는다(reg):
    """등록부 tools 를 progress 만 남기고 좁히면 run_script 조차 내보내지 않는다."""
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    save = respx.post(f'{URL}/tool/run_script')
    spec = reg['recorder'].model_copy(update={'tools': ('progress',)})
    restricted = RecorderAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='포이즌 주문 자동 처리', reason='주문번호와 소싱처를 적었다'),
    )
    out = restricted(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
    assert not save.called


@respx.mock
def test_저장_결과에_개인정보가_남지_않는다(reg):
    import json

    saved = json.dumps({**EXPECTED, 'memo': '포이즌 주문 자동 처리'}, ensure_ascii=False)
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page('saved'), page(saved)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert find_leaks(out.payload) == []
    assert find_leaks(out.reason) == []
    assert find_leaks([e.detail for e in out.evidence]) == []
