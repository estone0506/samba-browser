# 데이터셋 시드 — 에이전트별 10건 이상, 성공·실패 둘 다, 실패의 기대는 올바른 거절
import pytest

from samba_agent.agents.registry import Registry
from samba_agent.ops.datasets import (
    MIN_EXAMPLES,
    REQUIRED_TAGS,
    Example,
    ensure_online_evaluator,
    load_seed,
    pull_reviewed_examples,
    push_to_langsmith,
    seed_counts,
)
from samba_agent.settings import DEFAULT_ROOT


def test_모든_에이전트_데이터셋이_있다():
    reg = Registry.load(DEFAULT_ROOT)
    counts = seed_counts(DEFAULT_ROOT)
    for spec in [s for k in ('buyer', 'payer', 'recorder', 'verifier') for s in reg.of_kind(k)]:
        assert spec.dataset in counts, f'{spec.name} 의 데이터셋이 없다'
    assert 'ds.supervisor.assign' in counts  # 배정 정답 데이터셋


@pytest.mark.parametrize('name', list(seed_counts(DEFAULT_ROOT)))
def test_데이터셋마다_10건_이상이고_성공과_실패가_모두_있다(name):
    examples = load_seed(DEFAULT_ROOT, name)
    assert len(examples) >= MIN_EXAMPLES
    tags = {t for e in examples for t in e.tags}
    for required in REQUIRED_TAGS:
        assert required in tags, f'{name} 에 {required} 사례가 없다'


def test_실패_사례의_기대는_올바른_거절이다():
    for e in load_seed(DEFAULT_ROOT, 'ds.buyer.musinsa'):
        if 'failure' in e.tags:
            assert e.outputs['status'] in ('fail', 'needs_human')
            assert e.outputs['fail_reason']


def test_권한_부족과_중복_사례가_들어_있다():
    tags = {t for e in load_seed(DEFAULT_ROOT, 'ds.buyer.musinsa') for t in e.tags}
    assert 'permission' in tags
    assert 'duplicate' in tags


# ---- LangSmith 연동 — 실제로는 아무것도 나가지 않는다. 가짜 client 로만 돈다 ----


class _FakeDataset:
    def __init__(self, name: str) -> None:
        self.id = name


class _FakeLangSmithClient:
    """push_to_langsmith 가 기대하는 최소 인터페이스를 흉내 낸 가짜."""

    def __init__(self) -> None:
        self.created: dict[str, list[dict[str, object]]] = {}
        self._known: set[str] = set()

    def read_dataset(self, *, dataset_name: str) -> _FakeDataset:
        if dataset_name not in self._known:
            raise ValueError('없는 데이터셋')
        return _FakeDataset(dataset_name)

    def create_dataset(self, name: str) -> _FakeDataset:
        self._known.add(name)
        return _FakeDataset(name)

    def create_examples(self, *, inputs, outputs, metadata, dataset_id) -> None:
        self.created.setdefault(dataset_id, []).extend(inputs)


def test_langsmith_키가_없으면_아무것도_보내지_않는다(monkeypatch):
    """client 를 안 주면 실제 LangSmith 로는 절대 나가지 않는다 — 여기서 검증하는 두 함수는
    이번 태스크에서는 Task 16 진입점까지 연결만 해 둔 자리라 client 없이는 0/빈 목록이다."""
    monkeypatch.delenv('LANGSMITH_API_KEY', raising=False)
    assert ensure_online_evaluator(client=None) == 0
    assert pull_reviewed_examples(client=None) == []


def test_가짜_client_를_주면_데이터셋에_올라간다():
    client = _FakeLangSmithClient()
    examples = [
        Example(
            name='ds.buyer.musinsa', inputs={'a': 1}, outputs={'status': 'ok'}, tags=('success',)
        ),
        Example(
            name='ds.buyer.musinsa', inputs={'a': 2}, outputs={'status': 'fail'}, tags=('failure',)
        ),
        Example(name='ds.payer', inputs={'a': 3}, outputs={'status': 'ok'}, tags=('success',)),
    ]
    count = push_to_langsmith(examples, client=client)
    assert count == 3
    assert len(client.created['ds.buyer.musinsa']) == 2
    assert len(client.created['ds.payer']) == 1


class _FakeOnlineClient:
    def __init__(self, already: bool = False) -> None:
        self.already = already
        self.calls: list[tuple[str, str]] = []

    def ensure_online_evaluator(self, *, name: str, review_queue: str) -> bool:
        self.calls.append((name, review_queue))
        return self.already


def test_온라인_채점기_연결은_client_가_있어야_동작한다():
    client = _FakeOnlineClient(already=False)
    assert ensure_online_evaluator(client=client) == 1
    assert client.calls == [('samba.online.safety', 'samba-review')]

    client2 = _FakeOnlineClient(already=True)
    assert ensure_online_evaluator(client=client2) == 0


class _FakeReviewClient:
    def list_reviewed_examples(self, *, queue_name: str):
        assert queue_name == 'samba-review'
        return [
            {
                'dataset': 'ds.buyer.musinsa',
                'inputs': {'order': {'order_no': 'X1'}},
                'outputs': {'status': 'ok'},
                'tags': ['reviewed'],
            }
        ]


def test_검수_큐에서_사람이_고친_예시를_가져온다():
    got = pull_reviewed_examples(client=_FakeReviewClient())
    assert len(got) == 1
    assert got[0].name == 'ds.buyer.musinsa'
    assert 'reviewed' in got[0].tags
