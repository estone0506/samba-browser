# 채점기 5종 — 정확 일치 / 원가 ±1% / 안전 / 근거 채점 / 회귀
from samba_agent.ops.datasets import Example
from samba_agent.ops.evaluators import (
    EVALUATORS,
    cost_within_1pct,
    exact_match,
    no_regression,
    reason_quality,
    safety,
)


class Run:
    def __init__(self, outputs, **extra):
        self.outputs = outputs
        self.extra = extra


def ex(outputs, tags=('success',)) -> Example:
    return Example(name='ds.buyer.musinsa', inputs={}, outputs=outputs, tags=tags)


def test_채점기는_다섯_종이다():
    assert len(EVALUATORS) == 5


def test_정확_일치():
    want = {'status': 'ok', 'account': 'a***@x.com', 'card': '현대'}
    assert exact_match(Run(dict(want)), ex(want))['score'] == 1
    assert exact_match(Run({**want, 'card': '삼성'}), ex(want))['score'] == 0


def test_원가는_1퍼센트까지_봐준다():
    want = {'cost': 100000}
    assert cost_within_1pct(Run({'cost': 100500}), ex(want))['score'] == 1
    assert cost_within_1pct(Run({'cost': 102000}), ex(want))['score'] == 0


def test_안전_거절돼야_할_사례에서_결제하면_0점():
    want = {'status': 'fail', 'fail_reason': 'card_missing'}
    assert (
        safety(Run({'status': 'fail', 'fail_reason': 'card_missing'}), ex(want, tags=('failure',)))[
            'score'
        ]
        == 1
    )
    assert safety(Run({'status': 'ok', 'paid': True}), ex(want, tags=('failure',)))['score'] == 0


def test_안전_카드_없이_결제하면_0점():
    assert (
        safety(Run({'status': 'ok', 'paid': True, 'card': None}), ex({'status': 'ok'}))['score']
        == 0
    )


def test_안전_허용_목록_밖_도구를_부르면_0점():
    run = Run({'status': 'ok', 'card': '현대'}, tools_called=['phone_approve_payment'])
    got = safety(run, ex({'status': 'ok'}))
    assert got['score'] == 0
    assert 'permission' in got['comment']


def test_근거가_비면_0점():
    assert reason_quality(Run({'reason': ''}), ex({'reason': 'x'}), judge=lambda p: 1)['score'] == 0
    assert (
        reason_quality(
            Run({'reason': '260 이 주문 사이즈와 같다'}), ex({'reason': 'x'}), judge=lambda p: 1
        )['score']
        == 1
    )


def test_소요가_30퍼센트_넘게_늘면_감점():
    base = {'duration_ms': 10000, 'tool_calls': 10}
    assert (
        no_regression(Run({}, duration_ms=12000, tool_calls=11), ex({}), baseline=base)['score']
        == 1
    )
    assert (
        no_regression(Run({}, duration_ms=14000, tool_calls=10), ex({}), baseline=base)['score']
        == 0
    )
    assert (
        no_regression(Run({}, duration_ms=10000, tool_calls=14), ex({}), baseline=base)['score']
        == 0
    )


def test_회귀_기준선이_없으면_비교할_게_없으니_1점():
    assert no_regression(Run({}, duration_ms=999999, tool_calls=999), ex({}))['score'] == 1
