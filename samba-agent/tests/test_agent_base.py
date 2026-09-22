# 워커 공통 껍데기 — 허용 목록 / 캡차 감지 / 구조화 출력 재요청 / 실패 변환
import httpx
import pytest
import respx
from pydantic import BaseModel

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'


def base(decide=None, allowed=('get_page',)) -> AgentBase:
    reg = Registry.load(DEFAULT_ROOT)
    spec = reg['buyer.musinsa'].model_copy(update={'tools': allowed})
    client = BridgeClient(URL, 'a' * 64, allowed=allowed, busy_wait_s=0.0)
    return AgentBase(spec, client, decide or (lambda p, m: m(choice='x', reason='근거')))


@respx.mock
def test_허용_목록_밖_도구는_권한_부족_실패다():
    b = base()
    with pytest.raises(AgentFailure) as e:
        b.tool('phone_approve_payment', provider='토스페이')
    assert e.value.fail_reason is FailReason.PERMISSION_DENIED
    assert e.value.status == 'fail'


@respx.mock
def test_캡차_문구가_오면_사람에게_넘긴다():
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(
            200, json={'ok': True, 'result': 'needs_user: 캡차', 'steps': []}
        )
    )
    with pytest.raises(AgentFailure) as e:
        base().tool('get_page')
    assert e.value.fail_reason is FailReason.CAPTCHA
    assert e.value.status == 'needs_human'


@respx.mock
def test_브릿지가_죽으면_bridge_down_실패다():
    respx.post(f'{URL}/tool/get_page').mock(side_effect=httpx.ConnectError('refused'))
    with pytest.raises(AgentFailure) as e:
        base().tool('get_page')
    assert e.value.fail_reason is FailReason.BRIDGE_DOWN


def test_구조화_출력_실패는_한_번만_다시_묻는다():
    calls = {'n': 0}

    def flaky(_p, model):
        calls['n'] += 1
        if calls['n'] == 1:
            raise ValueError('형식 오류')
        return model(choice='260', reason='사이즈 일치')

    got = base(decide=flaky).decide_once('옵션을 고르라', Decision)
    assert calls['n'] == 2
    assert got.choice == '260'


def test_두_번_실패하면_사람에게_넘긴다():
    def always_bad(_p, _m):
        raise ValueError('형식 오류')

    with pytest.raises(AgentFailure) as e:
        base(decide=always_bad).decide_once('옵션을 고르라', Decision)
    assert e.value.status == 'needs_human'
    assert e.value.fail_reason is FailReason.UNKNOWN


def test_근거_없는_판단은_받지_않는다():
    class Empty(BaseModel):
        pass

    with pytest.raises(Exception):  # noqa: B017 — pydantic 검증 오류 타입은 신경 쓰지 않는다
        Decision(choice='x', reason='')


def test_run_agent_는_실패를_결과로_바꾼다():
    def boom() -> AgentResult:
        raise AgentFailure('fail', '품절이다', FailReason.OUT_OF_STOCK)

    got = run_agent(boom)
    assert (got.status, got.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)
    assert got.reason == '품절이다'
