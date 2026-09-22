# 검증 에이전트 — 셋이 맞으면 ok / 하나라도 다르면 불일치 표 / 개인정보는 payload·프롬프트로 안 샌다
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


def agent(reg, decide=None) -> VerifierAgent:
    spec = reg['verifier']
    return VerifierAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        decide or (lambda p, m: m(choice='불일치 없음', reason='세 값이 같다')),
    )


def assignment(reg, *, expected=EXPECTED) -> Assignment:
    spec = reg['verifier']
    return Assignment(
        order=ORDER,
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=False,
        expected=expected,
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


@respx.mock
def test_브릿지의_원문_개인정보가_불일치_표와_프롬프트에서_가려진다(reg):
    """브릿지(소싱처 주문 상세)가 이름·전화·이메일이 섞인 원문 메모를 돌려줘도, 불일치
    표(payload)와 reason·decide_once 프롬프트 어디에도 원문이 그대로 나가면 안 된다
    (find_leaks 0건)."""
    leaky_expected = {**EXPECTED, 'note': '수취인 정상 처리'}
    leaky_source = {
        **EXPECTED,
        'note': '수취인 홍길동 010-1234-5678 kimsun@example.com 배송 요청',
    }
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page(leaky_source), page(leaky_expected)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))

    captured_prompts: list[str] = []

    def spy_decide(prompt, model):
        captured_prompts.append(prompt)
        return model(choice='불일치 있음', reason='실구매가가 다르다')

    out = agent(reg, decide=spy_decide)(assignment(reg, expected=leaky_expected))

    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert find_leaks(out.payload) == []
    assert find_leaks(out.reason) == []
    assert find_leaks([e.detail for e in out.evidence]) == []
    assert captured_prompts, '불일치가 있으면 decide_once 가 반드시 호출돼야 한다'
    assert all(find_leaks(p) == [] for p in captured_prompts)


@respx.mock
def test_대조할_기대값이_없으면_ok가_아니라_사람에게_넘긴다(reg):
    # 리뷰 지적 — Minor: 기대값이 비면 '0개가 모두 같다' 로 ok 가 나왔다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page({}))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, expected={}))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.VERIFY_MISMATCH
