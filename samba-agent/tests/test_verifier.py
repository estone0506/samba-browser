# 검증 에이전트 — 셋이 맞으면 ok / 하나라도 다르면 불일치 표
import json

import httpx
import pytest
import respx

from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.agents.verifier import VerifierAgent
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)
EXPECTED = {'source_order_no': 'M-777', 'real_price': 89000}


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def agent(reg) -> VerifierAgent:
    spec = reg['verifier']
    return VerifierAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='불일치 없음', reason='세 값이 같다'),
    )


def assignment(reg) -> Assignment:
    spec = reg['verifier']
    return Assignment(
        order=ORDER,
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=False,
        expected=EXPECTED,
    )


def page(obj) -> httpx.Response:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@respx.mock
def test_셋이_같으면_통과(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page(EXPECTED), page(EXPECTED)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg))
    assert out.status == 'ok'
    assert out.payload['mismatches'] == []


@respx.mock
def test_소싱처와_samba_가_다르면_불일치_표를_낸다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({**EXPECTED, 'real_price': 91000}), page(EXPECTED)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert out.payload['mismatches'][0]['field'] == 'real_price'
    assert out.payload['mismatches'][0]['source'] == 91000


@respx.mock
def test_허용_목록_밖_도구는_거절된다(reg):
    """등록부 tools 를 progress 만 남기고 좁히면 run_script 조차 내보내지 않는다."""
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    read = respx.post(f'{URL}/tool/run_script')
    spec = reg['verifier'].model_copy(update={'tools': ('progress',)})
    restricted = VerifierAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='불일치 없음', reason='세 값이 같다'),
    )
    out = restricted(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
    assert not read.called


@respx.mock
def test_불일치_표에_개인정보가_남지_않는다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({**EXPECTED, 'real_price': 91000}), page(EXPECTED)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg))
    assert find_leaks(out.payload) == []
    assert find_leaks(out.reason) == []
    assert find_leaks([e.detail for e in out.evidence]) == []
