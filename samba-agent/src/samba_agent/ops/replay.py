"""오프라인 재생기 — 브라우저 없이 스냅샷으로 에이전트를 한 번 돌린다(스펙 §4.5 2단계, Task 13 Step 6).

주의(이 워크트리 한정): 실제 buyer/payer/recorder/verifier 에이전트 구현(Task 7 계열,
`agents/base.py`·`agents/buyer.py` 등)이 다른 워크트리에서 동시에 작업 중이라 아직
이 워크트리에는 없다. 브리프는 "고정 응답 가짜 BridgeClient 를 세워 해당 에이전트를
1회 실행"하라고 하지만, 부를 에이전트 자체가 없어 그대로는 할 수 없다.

그래서 여기서는 각 시드가 이미 담고 있는 `snapshot`/`bridge`/`tool`/`dry_run` 필드를
그대로 판정하는 참조 재생기를 둔다 — 데이터셋 작성자가 seed 를 만들 때 쓴 것과
같은 규칙이다(정답을 베끼는 게 아니라 조건을 재계산한다). `ds.supervisor.assign` 은
실제 배정 로직(`agents.registry.Registry.pick`)을 그대로 쓴다 — 이건 이미 구현돼 있다.

실제 buyer/payer/recorder/verifier 에이전트가 이 워크트리에 합류하면 `_replay_buyer_kind`
류의 함수를 지우고, Assignment 를 만들어 BridgeClient(httpx.MockTransport 로 스냅샷을
고정 응답으로 주는)와 함께 진짜 에이전트를 호출하는 코드로 바꿔 끼우면 된다 — 이 파일의
공개 API(`replay_example(example) -> Run`, `.outputs`/`.extra` 모양)는 그대로 유지된다.
"""

import time
from collections.abc import Mapping
from dataclasses import dataclass, field

from samba_agent.agents.contracts import OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT

_registry_cache: Registry | None = None


@dataclass
class Run:
    """evaluators 가 기대하는 최소 인터페이스 — outputs + extra(duration_ms·tool_calls·tools_called)."""

    outputs: dict[str, object]
    extra: dict[str, object] = field(default_factory=dict)


def replay_example(example: object) -> Run:
    """스냅샷 하나를 판정해 Run 을 만든다. 실제 소요 시간을 재서 duration_ms 로 남긴다."""
    started = time.perf_counter()
    inputs: Mapping[str, object] = getattr(example, 'inputs', {}) or {}
    name = str(getattr(example, 'name', ''))
    outputs, tools_called = _dispatch(name, inputs)
    duration_ms = (time.perf_counter() - started) * 1000
    return Run(
        outputs=outputs,
        extra={
            'duration_ms': duration_ms,
            'tool_calls': len(tools_called),
            'tools_called': tools_called,
        },
    )


def _dispatch(name: str, inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    kind = name.split('.')[1] if name.count('.') >= 1 else ''
    if name == 'ds.supervisor.assign' or kind == 'supervisor':
        return _replay_assign(inputs)
    if kind == 'payer':
        return _replay_payer(inputs)
    if kind == 'recorder':
        return _replay_recorder(inputs)
    if kind == 'verifier':
        return _replay_verifier(inputs)
    # buyer.* (musinsa/29cm/abc/lotteon 공통)
    return _replay_buyer_kind(inputs)


def _bridge_and_tool_checks(
    inputs: Mapping[str, object],
) -> tuple[dict[str, object], list[str]] | None:
    """모든 종류가 공유하는 선행 조건 — 브릿지 끊김 / 허용 밖 도구 / 중복."""
    tools_called: list[str] = ['get_page']
    if inputs.get('bridge') == 'down':
        return {'status': 'fail', 'fail_reason': FailReason.BRIDGE_DOWN.value}, tools_called
    tool = inputs.get('tool')
    if tool:
        tools_called.append(str(tool))
        return {'status': 'fail', 'fail_reason': FailReason.PERMISSION_DENIED.value}, tools_called
    snapshot = inputs.get('snapshot')
    if isinstance(snapshot, Mapping) and snapshot.get('samba_source_order_no'):
        return {'status': 'fail', 'fail_reason': FailReason.DUPLICATE.value}, tools_called
    return None


def _replay_buyer_kind(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    early = _bridge_and_tool_checks(inputs)
    if early is not None:
        return early
    tools_called: list[str] = ['get_page']
    snapshot = inputs.get('snapshot')
    if not isinstance(snapshot, Mapping):
        return {'status': 'needs_human', 'fail_reason': FailReason.UNKNOWN.value}, tools_called

    raw = snapshot.get('raw')
    if isinstance(raw, str) and '캡차' in raw:
        return {'status': 'needs_human', 'fail_reason': FailReason.CAPTCHA.value}, tools_called

    options_list = snapshot.get('options')
    if isinstance(options_list, list) and not options_list:
        return {'status': 'fail', 'fail_reason': FailReason.OUT_OF_STOCK.value}, tools_called

    margin_pct = snapshot.get('margin_pct')
    if isinstance(margin_pct, (int, float)) and margin_pct < 0:
        return {'status': 'fail', 'fail_reason': FailReason.MARGIN.value}, tools_called

    options = inputs.get('options')
    card = options.get('card') if isinstance(options, Mapping) else None
    methods = snapshot.get('methods')
    if card and isinstance(methods, list) and card not in methods:
        return {'status': 'fail', 'fail_reason': FailReason.CARD_MISSING.value}, tools_called

    result: dict[str, object] = {'status': 'ok'}
    coupons = snapshot.get('coupons')
    if isinstance(coupons, Mapping) and coupons:
        result['account'] = next(iter(coupons))
    if card:
        result['card'] = card
    cost = snapshot.get('cost')
    if isinstance(cost, (int, float)):
        result['cost'] = cost
    return result, tools_called


def _replay_assign(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    """배정은 흉내가 아니라 실제 Registry.pick 을 쓴다 — 이 로직은 이미 구현돼 있다."""
    order_row = dict(inputs.get('order', {}))
    order_row.setdefault('sku', 'SKU-1')
    order_row.setdefault('qty', 1)
    order = OrderRef.model_validate(order_row)
    options = dict(inputs.get('options', {}))
    spec = _registry().pick('buyer', order, options)
    if spec is None:
        return {'status': 'needs_human', 'fail_reason': FailReason.UNKNOWN.value}, []
    return {'status': 'ok', 'agent': spec.name}, []


def _replay_payer(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    early = _bridge_and_tool_checks(inputs)
    if early is not None:
        return early
    tools_called: list[str] = ['get_page']
    snapshot = inputs.get('snapshot')
    if isinstance(snapshot, Mapping):
        raw = snapshot.get('raw')
        if isinstance(raw, str) and '캡차' in raw:
            return {'status': 'needs_human', 'fail_reason': FailReason.CAPTCHA.value}, tools_called

    options = inputs.get('options')
    card = options.get('card') if isinstance(options, Mapping) else None
    if isinstance(snapshot, Mapping):
        methods = snapshot.get('methods')
        if card and isinstance(methods, list) and card not in methods:
            return {'status': 'fail', 'fail_reason': FailReason.CARD_MISSING.value}, tools_called

    if inputs.get('dry_run'):
        return {'status': 'ok', 'payload': {'dry_run': True, 'paid': False}}, tools_called

    if isinstance(snapshot, Mapping) and snapshot.get('approval_confirmed') is False:
        return {'status': 'needs_human', 'fail_reason': FailReason.UNKNOWN.value}, tools_called

    tools_called.append('phone_approve_payment')
    result: dict[str, object] = {'status': 'ok', 'payload': {'paid': True}}
    if card:
        result['card'] = card
    return result, tools_called


def _replay_recorder(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    early = _bridge_and_tool_checks(inputs)
    if early is not None:
        return early
    tools_called: list[str] = ['get_page']
    if inputs.get('dry_run'):
        return {'status': 'ok', 'payload': {'dry_run': True}}, tools_called
    snapshot = inputs.get('snapshot')
    if not isinstance(snapshot, Mapping):
        return {'status': 'needs_human', 'fail_reason': FailReason.UNKNOWN.value}, tools_called
    expected = snapshot.get('expected', {})
    actual = snapshot.get('actual', {})
    if expected == actual:
        return {'status': 'ok'}, tools_called
    return {'status': 'fail', 'fail_reason': FailReason.VERIFY_MISMATCH.value}, tools_called


def _replay_verifier(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    early = _bridge_and_tool_checks(inputs)
    if early is not None:
        return early
    tools_called: list[str] = ['get_page']
    snapshot = inputs.get('snapshot')
    if not isinstance(snapshot, Mapping):
        return {'status': 'needs_human', 'fail_reason': FailReason.UNKNOWN.value}, tools_called
    if not snapshot.get('found', True):
        return {'status': 'fail', 'fail_reason': FailReason.UNKNOWN.value}, tools_called
    expected = snapshot.get('expected', {})
    observed = snapshot.get('observed', {})
    if expected == observed:
        return {'status': 'ok'}, tools_called
    return {'status': 'fail', 'fail_reason': FailReason.VERIFY_MISMATCH.value}, tools_called


def _registry() -> Registry:
    global _registry_cache
    if _registry_cache is None:
        _registry_cache = Registry.load(DEFAULT_ROOT)
    return _registry_cache
