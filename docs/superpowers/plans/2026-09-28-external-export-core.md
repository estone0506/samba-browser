# 외부 기입(export) 코어 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하네스가 검증을 끝낸 주문의 원가·배송비를 외부 기입 큐에 넣고, 입력 작업자가 어댑터로 기입·되읽기 하는 뼈대를 만든다(어댑터는 가짜로 검증).

**Architecture:** 하네스(일반 권한)는 감독자 그래프의 `verify` 뒤 `export` 노드에서 SQLite 큐에 요청을 넣고 결과를 잠깐 기다린다. 별도 프로세스인 입력 작업자(관리자 권한)가 큐에서 한 건씩 꺼내 어댑터의 `read → write → read` 로 기입한다. 외부 기입 결과는 주문 결과(`outcome`)를 바꾸지 않는다.

**Tech Stack:** Python 3.12, LangGraph, SQLite(WAL), pydantic, PyYAML, pytest, ruff, uv

**스펙:** `docs/superpowers/specs/2026-09-28-external-export-design.md`

## 범위

스펙은 서로 독립인 세 덩어리다. 이 계획은 첫째만 다룬다.

| 계획 | 내용 | 상태 |
|---|---|---|
| **코어(이 문서)** | 라우팅 · 큐 · `export` 노드 · 입력 작업자 · 알림 · 배선 | 작성됨 |
| 샵마인 어댑터 | `DataGridView` 읽기·쓰기 | 주문 화면 읽기 전용 탐색 뒤 작성 |
| EMP 어댑터 + 스케줄러 등록 | 화면 값 읽기 방법 확정 → 입력, 작업 스케줄러 최고 권한 등록 | 읽기 방법 시험 뒤 작성 |

어댑터 계획을 지금 쓰지 않는 이유: 어댑터 코드는 실제 화면의 컨트롤 이름·열 이름·검색 방식에 달려 있고,
그 값은 읽기 전용 탐색으로만 알 수 있다. 코어는 가짜 어댑터로 끝까지 검증되므로 먼저 만든다.

## Global Constraints

- 기입 항목은 원가와 배송비 두 개뿐이다.
- 원가는 삼바웨이브에 기록한 매입금액과 같은 값이다(기록 결과 `values.real_price`). 배송비는 `values.shipping_fee`.
- 외부 기입이 실패해도 주문은 완료 상태를 유지한다. `export` 노드는 `outcome` 을 건드리지 않고 재결제·재기록을 일으키지 않는다.
- 주문 한 건은 한 곳에만 기입한다. 라우팅: EMP = GS이숍 · 롯데아이몰 · 현대H몰 · KT알파쇼핑, 제외 = 포이즌 · 크림, 나머지 = 샵마인.
- 라우팅 목록은 코드가 아니라 설정 파일(`samba-agent/export.yaml`)에서 고친다.
- `(order_no, target)` 은 유일하다. `done` 인 요청과 값이 다른 재요청은 거절한다.
- 큐에 개인정보를 담지 않는다(주문번호·금액·상태만).
- 입력 작업자는 한 번에 1건만 처리한다.
- 셀에 이미 값이 있고 기입할 값과 다르면 덮어쓰지 않는다. 같으면 입력 없이 성공이다.
- 되읽은 값이 다르면 실패(`verify_mismatch`)이고 재시도하지 않는다.
- `dry_run` 에서는 큐에 넣지 않고 계획만 돌려준다.
- 기능은 기본 꺼짐이다(`SAMBA_EXPORT_ENABLED=false`). 켜지 않으면 기존 동작·기존 테스트가 그대로다.
- 코드 주석·문서·커밋 메시지는 한국어, 식별자는 영어. 작은따옴표, 줄 길이 100(ruff).
- 테스트 실행은 `samba-agent/` 에서 `uv run pytest`.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `samba-agent/export.yaml` (새로) | 판매처 → 대상 라우팅 목록 |
| `samba-agent/src/samba_agent/export/__init__.py` (새로) | 패키지 표식 |
| `samba-agent/src/samba_agent/export/failures.py` (새로) | 외부 기입 실패 사유 enum |
| `samba-agent/src/samba_agent/export/routing.py` (새로) | 판매처 문자열 → `emp` · `shopmine` · 제외 |
| `samba-agent/src/samba_agent/export/store.py` (새로) | SQLite 큐(요청·결과·작업자 생존 표시) |
| `samba-agent/src/samba_agent/export/stage.py` (새로) | 그래프 `export` 노드가 부르는 함수 |
| `samba-agent/src/samba_agent/export/adapters.py` (새로) | 어댑터 인터페이스·예외 |
| `samba-agent/src/samba_agent/export/idle.py` (새로) | 사용자 입력 없는 시간(초) |
| `samba-agent/src/samba_agent/export/worker.py` (새로) | 입력 작업자(한 건 처리 규칙) |
| `samba-agent/src/samba_agent/export/notify.py` (새로) | 실패 건 슬랙 알림 |
| `samba-agent/src/samba_agent/export/desktop/__init__.py` (새로) | 어댑터 등록 지점(이 계획에서는 비어 있다) |
| `samba-agent/src/samba_agent/export/__main__.py` (새로) | `python -m samba_agent.export` CLI |
| `samba-agent/src/samba_agent/supervisor/graph.py` (수정) | `exporter` 인자와 `export` 노드 |
| `samba-agent/src/samba_agent/settings.py` (수정) | 설정 4개 |
| `samba-agent/src/samba_agent/__main__.py` (수정) | 배선 |

---

### Task 1: 라우팅

**Files:**
- Create: `samba-agent/export.yaml`
- Create: `samba-agent/src/samba_agent/export/__init__.py`
- Create: `samba-agent/src/samba_agent/export/routing.py`
- Test: `samba-agent/tests/test_export_routing.py`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `Target = Literal['emp', 'shopmine']`
  - `class ExportRouting(BaseModel)` — 필드 `emp: tuple[str, ...]`, `skip: tuple[str, ...]`, `default: Target`
  - `ExportRouting.load(path: Path) -> ExportRouting`
  - `ExportRouting.target_for(seller: str | None) -> Target | None` — `None` 은 기입 제외

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_export_routing.py`:

```python
# 외부 기입 라우팅 — 판매처 문자열로 대상 프로그램을 정한다
from pathlib import Path

import pytest
from pydantic import ValidationError

from samba_agent.export.routing import ExportRouting
from samba_agent.settings import DEFAULT_ROOT

ROUTING = ExportRouting(
    emp=('GS이숍', '롯데아이몰', '현대H몰', 'KT알파'),
    skip=('포이즌', '크림'),
    default='shopmine',
)


@pytest.mark.parametrize(
    'seller',
    ['GS이숍(캐논)', '롯데아이몰', '현대H몰', 'KT알파쇼핑', 'gs이숍 (캐논)', '현대 h몰'],
)
def test_플레이오토_경유_판매처는_emp(seller):
    assert ROUTING.target_for(seller) == 'emp'


@pytest.mark.parametrize('seller', ['포이즌', 'POIZON 포이즌', '크림'])
def test_제외_판매처는_기입하지_않는다(seller):
    assert ROUTING.target_for(seller) is None


@pytest.mark.parametrize('seller', ['스마트스토어', '쿠팡', '11번가'])
def test_나머지는_샵마인(seller):
    assert ROUTING.target_for(seller) == 'shopmine'


@pytest.mark.parametrize('seller', [None, '', '   '])
def test_판매처를_모르면_기입하지_않는다(seller):
    assert ROUTING.target_for(seller) is None


def test_제외가_emp_보다_먼저다():
    routing = ExportRouting(emp=('몰',), skip=('포이즌몰',), default='shopmine')
    assert routing.target_for('포이즌몰') is None


def test_설정_파일을_읽는다(tmp_path: Path):
    path = tmp_path / 'export.yaml'
    path.write_text('emp: [GS이숍]\nskip: [포이즌]\ndefault: shopmine\n', encoding='utf-8')
    routing = ExportRouting.load(path)
    assert routing.target_for('GS이숍(캐논)') == 'emp'


def test_모르는_키는_로딩을_거부한다(tmp_path: Path):
    path = tmp_path / 'export.yaml'
    path.write_text('emp: [GS이숍]\nemps: [오타]\n', encoding='utf-8')
    with pytest.raises(ValidationError):
        ExportRouting.load(path)


def test_저장소의_설정_파일이_스펙과_같다():
    routing = ExportRouting.load(DEFAULT_ROOT / 'export.yaml')
    assert routing.target_for('GS이숍(캐논)') == 'emp'
    assert routing.target_for('롯데아이몰') == 'emp'
    assert routing.target_for('현대H몰') == 'emp'
    assert routing.target_for('KT알파쇼핑') == 'emp'
    assert routing.target_for('포이즌') is None
    assert routing.target_for('크림') is None
    assert routing.target_for('스마트스토어') == 'shopmine'
```

- [ ] **Step 2: 실패 확인**

Run (`samba-agent/` 에서): `uv run pytest tests/test_export_routing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'samba_agent.export'`

- [ ] **Step 3: 구현**

`samba-agent/src/samba_agent/export/__init__.py`:

```python
"""외부 프로그램(EMP·샵마인) 원가·배송비 기입."""
```

`samba-agent/src/samba_agent/export/routing.py`:

```python
"""판매처 → 외부 기입 대상. 목록은 export.yaml 에서 고친다(코드 수정 없이)."""

import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

Target = Literal['emp', 'shopmine']

_SPACES = re.compile(r'\s+')


def _norm(text: str | None) -> str:
    """비교용 — 공백을 없애고 소문자로 맞춘다('현대 h몰' == '현대H몰')."""
    return _SPACES.sub('', text or '').lower()


class ExportRouting(BaseModel):
    """라우팅 설정. 모르는 키(오타)는 조용히 버리지 않고 로딩을 거부한다."""

    model_config = ConfigDict(extra='forbid')

    # 판매처 문자열에 이 표식이 들어 있으면 EMP 에 기입한다
    emp: tuple[str, ...] = ()
    # 이 표식이 들어 있으면 어디에도 기입하지 않는다
    skip: tuple[str, ...] = ()
    # 위 둘에 해당하지 않는 판매처의 대상
    default: Target = 'shopmine'

    @classmethod
    def load(cls, path: Path) -> 'ExportRouting':
        raw = yaml.safe_load(path.read_text(encoding='utf-8')) or {}
        return cls.model_validate(raw)

    def target_for(self, seller: str | None) -> Target | None:
        """기입할 프로그램. None 이면 기입하지 않는다(제외 판매처이거나 판매처를 모른다)."""
        s = _norm(seller)
        if not s:
            return None
        # 제외가 먼저다 — 제외 표식이 EMP 표식을 품고 있어도 기입하지 않는다
        if any(_norm(m) in s for m in self.skip if _norm(m)):
            return None
        if any(_norm(m) in s for m in self.emp if _norm(m)):
            return 'emp'
        return self.default
```

`samba-agent/export.yaml`:

```yaml
# 외부 기입 라우팅(스펙 2026-09-28 §4.1). 판매처 문자열에 표식이 들어 있으면 그 대상이다.
# 공백·대소문자는 무시한다. 주문 한 건은 한 곳에만 기입한다.

# 플레이오토 EMP 에 기입할 판매처
emp:
  - GS이숍
  - 롯데아이몰
  - 현대H몰
  - KT알파

# 어디에도 기입하지 않는 판매처
skip:
  - 포이즌
  - poizon
  - 크림
  - kream

# 위에 해당하지 않는 나머지
default: shopmine
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_export_routing.py -v`
Expected: PASS (테스트 19개)

- [ ] **Step 5: 커밋**

```bash
git add samba-agent/export.yaml samba-agent/src/samba_agent/export/__init__.py samba-agent/src/samba_agent/export/routing.py samba-agent/tests/test_export_routing.py
git commit -m "기능: 외부 기입 라우팅 — 판매처로 EMP·샵마인·제외를 정한다"
```

---

### Task 2: 큐 저장소

**Files:**
- Create: `samba-agent/src/samba_agent/export/failures.py`
- Create: `samba-agent/src/samba_agent/export/store.py`
- Test: `samba-agent/tests/test_export_store.py`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `class ExportFail(StrEnum)` — `WINDOW_MISSING` `BUSY` `TIMEOUT` `BLOCKED` `NOT_FOUND` `AMBIGUOUS` `VALUE_CONFLICT` `VERIFY_MISMATCH` `UNKNOWN`
  - `ExportStatus = Literal['pending', 'running', 'done', 'failed']`
  - `@dataclass(frozen=True) class ExportRequest` — `id: int`, `order_no: str`, `target: str`, `cost: int`, `shipping_fee: int`, `status: ExportStatus`, `fail_reason: str | None`, `detail: str | None`, `attempts: int`, `notified: bool`, `next_at: str`, `created_at: str`, `updated_at: str`
  - `class ExportConflict(Exception)`
  - `class ExportQueue`:
    - `__init__(path: Path, clock: Callable[[], datetime] | None = None)`
    - `enqueue(order_no: str, target: str, cost: int, shipping_fee: int) -> ExportRequest`
    - `get(request_id: int) -> ExportRequest` (없으면 `KeyError`)
    - `find(order_no: str, target: str) -> ExportRequest | None`
    - `claim_next(targets: Sequence[str]) -> ExportRequest | None`
    - `done(request_id: int, detail: str) -> None`
    - `fail(request_id: int, reason: ExportFail, detail: str) -> None`
    - `retry_later(request_id: int, reason: ExportFail, detail: str, delay_s: float) -> None`
    - `recover_running(targets: Sequence[str]) -> int`
    - `requeue(order_no: str, target: str) -> ExportRequest | None`
    - `wait(request_id: int, timeout_s: float, *, poll_s: float = 1.0, sleep=time.sleep, monotonic=time.monotonic) -> ExportRequest`
    - `unnotified_failed() -> list[ExportRequest]`
    - `mark_notified(request_id: int) -> None`
    - `recent(limit: int = 20) -> list[ExportRequest]`
    - `beat(targets: Sequence[str]) -> None`
    - `alive(target: str, within_s: float = 30.0) -> bool`

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_export_store.py`:

```python
# 외부 기입 큐 — 중복 방지 · 상태 전이 · 재시도 예약 · 작업자 생존 표시
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportConflict, ExportQueue


class Clock:
    """시험용 시계 — 마음대로 앞으로 돌린다."""

    def __init__(self) -> None:
        self.now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def forward(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture()
def clock() -> Clock:
    return Clock()


@pytest.fixture()
def queue(tmp_path: Path, clock: Clock) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite', clock=clock)


def test_새_요청은_pending_으로_들어간다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    assert (req.order_no, req.target, req.cost, req.shipping_fee) == ('A1', 'emp', 62470, 2300)
    assert req.status == 'pending'
    assert req.attempts == 0
    assert req.notified is False


def test_같은_요청은_새_행을_만들지_않는다(queue):
    first = queue.enqueue('A1', 'emp', 62470, 2300)
    second = queue.enqueue('A1', 'emp', 62470, 2300)
    assert second.id == first.id
    assert len(queue.recent()) == 1


def test_대상이_다르면_다른_요청이다(queue):
    a = queue.enqueue('A1', 'emp', 62470, 2300)
    b = queue.enqueue('A1', 'shopmine', 62470, 2300)
    assert a.id != b.id


def test_done_인_요청과_값이_다른_재요청은_거절한다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    with pytest.raises(ExportConflict):
        queue.enqueue('A1', 'emp', 70000, 2300)
    assert queue.get(req.id).cost == 62470


def test_running_중에는_값을_바꿀_수_없다(queue):
    queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    with pytest.raises(ExportConflict):
        queue.enqueue('A1', 'emp', 70000, 2300)


def test_실패한_요청은_새_값으로_다시_넣을_수_있다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    queue.mark_notified(req.id)
    again = queue.enqueue('A1', 'emp', 70000, 2300)
    assert again.id == req.id
    assert again.status == 'pending'
    assert again.cost == 70000
    assert again.attempts == 0
    assert again.fail_reason is None
    assert again.notified is False


def test_claim_은_오래된_것부터_running_으로_바꾼다(queue, clock):
    first = queue.enqueue('A1', 'emp', 1000, 0)
    clock.forward(1)
    queue.enqueue('A2', 'emp', 2000, 0)
    got = queue.claim_next(['emp'])
    assert got is not None
    assert got.id == first.id
    assert got.status == 'running'
    assert got.attempts == 1


def test_claim_은_맡은_대상만_집는다(queue):
    queue.enqueue('A1', 'shopmine', 1000, 0)
    assert queue.claim_next(['emp']) is None
    assert queue.claim_next([]) is None
    assert queue.claim_next(['shopmine']) is not None


def test_재시도_예약은_시간이_지나야_다시_집힌다(queue, clock):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.retry_later(req.id, ExportFail.BUSY, '창 사용 중', delay_s=60)
    assert queue.get(req.id).status == 'pending'
    assert queue.get(req.id).fail_reason == 'busy'
    assert queue.claim_next(['emp']) is None
    clock.forward(61)
    got = queue.claim_next(['emp'])
    assert got is not None
    assert got.attempts == 2


def test_done_과_fail_은_결과를_남긴다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'emp', 2000, 0)
    queue.claim_next(['emp'])
    queue.done(a.id, '기입 완료')
    queue.claim_next(['emp'])
    queue.fail(b.id, ExportFail.VERIFY_MISMATCH, '되읽기 불일치')
    assert queue.get(a.id).status == 'done'
    assert queue.get(a.id).detail == '기입 완료'
    assert queue.get(a.id).fail_reason is None
    assert queue.get(b.id).status == 'failed'
    assert queue.get(b.id).fail_reason == 'verify_mismatch'


def test_죽은_작업자가_남긴_running_은_되돌린다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    queue.claim_next(['emp'])
    queue.claim_next(['shopmine'])
    assert queue.recover_running(['emp']) == 1
    assert queue.get(a.id).status == 'pending'
    assert queue.get(b.id).status == 'running'


def test_requeue_는_실패한_요청만_되살린다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    assert queue.requeue('A1', 'emp') is None  # pending 은 건드리지 않는다
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    again = queue.requeue('A1', 'emp')
    assert again is not None
    assert again.status == 'pending'
    assert again.attempts == 0
    assert queue.requeue('A9', 'emp') is None


def test_wait_는_끝난_요청을_바로_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    slept: list[float] = []
    out = queue.wait(req.id, 10, sleep=slept.append)
    assert out.status == 'done'
    assert slept == []


def test_wait_는_기다리는_동안_끝나면_결과를_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)

    def sleep(_s: float) -> None:
        queue.claim_next(['emp'])
        queue.done(req.id, '기입 완료')

    ticks = iter([0.0, 0.0, 1.0, 2.0])
    out = queue.wait(req.id, 10, sleep=sleep, monotonic=lambda: next(ticks))
    assert out.status == 'done'


def test_wait_는_시간이_지나면_pending_그대로_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    ticks = iter([0.0, 5.0, 11.0])
    slept: list[float] = []
    out = queue.wait(req.id, 10, sleep=slept.append, monotonic=lambda: next(ticks))
    assert out.status == 'pending'
    assert slept == [1.0]


def test_wait_시간이_0_이면_한_번만_본다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    slept: list[float] = []
    out = queue.wait(req.id, 0, sleep=slept.append)
    assert out.status == 'pending'
    assert slept == []


def test_알림_대상은_알리지_않은_실패뿐이다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'emp', 2000, 0)
    queue.enqueue('A3', 'emp', 3000, 0)
    queue.claim_next(['emp'])
    queue.fail(a.id, ExportFail.NOT_FOUND, '주문 없음')
    queue.claim_next(['emp'])
    queue.done(b.id, '기입 완료')
    assert [r.id for r in queue.unnotified_failed()] == [a.id]
    queue.mark_notified(a.id)
    assert queue.unnotified_failed() == []


def test_작업자_생존_표시는_시간이_지나면_꺼진다(queue, clock):
    assert queue.alive('emp') is False
    queue.beat(['emp'])
    assert queue.alive('emp') is True
    assert queue.alive('shopmine') is False
    clock.forward(31)
    assert queue.alive('emp') is False


def test_두_연결이_같은_파일을_본다(tmp_path: Path, clock):
    path = tmp_path / 'exports.sqlite'
    harness = ExportQueue(path, clock=clock)
    worker = ExportQueue(path, clock=clock)
    req = harness.enqueue('A1', 'emp', 1000, 0)
    got = worker.claim_next(['emp'])
    assert got is not None
    worker.done(got.id, '기입 완료')
    assert harness.get(req.id).status == 'done'


def test_없는_요청을_찾으면_KeyError(queue):
    with pytest.raises(KeyError):
        queue.get(999)
    assert queue.find('A1', 'emp') is None
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_export_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'samba_agent.export.failures'`

- [ ] **Step 3: 구현**

`samba-agent/src/samba_agent/export/failures.py`:

```python
"""외부 기입 실패 사유 — 알림·집계가 흔들리지 않게 코드로 고정한다."""

from enum import StrEnum


class ExportFail(StrEnum):
    """입력 작업자가 남길 수 있는 실패 사유. 이 목록 밖의 값은 쓰지 않는다."""

    # 다시 하면 풀릴 수 있는 사유 — 큐가 시간을 두고 다시 집는다
    WINDOW_MISSING = 'window_missing'  # 프로그램 창이 없다
    BUSY = 'busy'  # 사람이 그 창을 쓰는 중이다
    TIMEOUT = 'timeout'  # 화면이 제때 반응하지 않았다
    BLOCKED = 'blocked'  # 인증·오류 대화상자가 떠 있다(건드리지 않는다)
    # 다시 해도 같은 답이 나오는 사유 — 사람이 본다
    NOT_FOUND = 'not_found'  # 그 주문번호가 없다
    AMBIGUOUS = 'ambiguous'  # 검색 결과가 1건이 아니다
    VALUE_CONFLICT = 'value_conflict'  # 이미 다른 값이 들어 있다
    VERIFY_MISMATCH = 'verify_mismatch'  # 입력 뒤 되읽은 값이 다르다
    UNKNOWN = 'unknown'
```

`samba-agent/src/samba_agent/export/store.py`:

```python
"""외부 기입 요청 큐 — SQLite. 하네스(일반 권한)와 입력 작업자(관리자 권한)의 유일한 접점이다.

두 프로세스가 같은 파일을 연다 — WAL + busy_timeout + BEGIN IMMEDIATE 로 겹침을 막는다.
개인정보는 담지 않는다(주문번호·금액·상태뿐).
"""

import contextlib
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from samba_agent.export.failures import ExportFail

ExportStatus = Literal['pending', 'running', 'done', 'failed']
# 더 바뀌지 않는 상태
TERMINAL: tuple[ExportStatus, ...] = ('done', 'failed')

_SCHEMA = """
CREATE TABLE IF NOT EXISTS export_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  target TEXT NOT NULL,
  cost INTEGER NOT NULL,
  shipping_fee INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  fail_reason TEXT,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_no, target)
);
CREATE INDEX IF NOT EXISTS export_requests_status ON export_requests(status, next_at);
CREATE TABLE IF NOT EXISTS export_heartbeat (
  target TEXT PRIMARY KEY,
  beat_at TEXT NOT NULL
);
"""


class ExportConflict(Exception):
    """이미 기입했거나 기입 중인 요청과 값이 다르다 — 덮어쓰기는 사람이 한다."""


@dataclass(frozen=True)
class ExportRequest:
    """큐의 한 행."""

    id: int
    order_no: str
    target: str
    cost: int
    shipping_fee: int
    status: ExportStatus
    fail_reason: str | None
    detail: str | None
    attempts: int
    notified: bool
    next_at: str
    created_at: str
    updated_at: str


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _to_request(row: sqlite3.Row) -> ExportRequest:
    return ExportRequest(
        id=row['id'],
        order_no=row['order_no'],
        target=row['target'],
        cost=row['cost'],
        shipping_fee=row['shipping_fee'],
        status=row['status'],
        fail_reason=row['fail_reason'],
        detail=row['detail'],
        attempts=row['attempts'],
        notified=bool(row['notified']),
        next_at=row['next_at'],
        created_at=row['created_at'],
        updated_at=row['updated_at'],
    )


class ExportQueue:
    """외부 기입 큐. 하네스와 입력 작업자가 각자 연결을 하나씩 연다."""

    def __init__(self, path: Path, clock: Callable[[], datetime] | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._clock = clock or _utc_now
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # 다른 프로세스가 쓰는 중이면 즉시 실패하지 않고 기다린다
        self._db.execute('PRAGMA busy_timeout=5000')
        # 읽는 쪽(하네스 대기)과 쓰는 쪽(작업자)이 서로 막지 않게 한다
        self._db.execute('PRAGMA journal_mode=WAL')
        self._db.executescript(_SCHEMA)
        # 한 연결을 여러 스레드가 쓴다(그래프 노드·알림 고리) — BEGIN~COMMIT 구간을 직렬화한다
        self._lock = threading.Lock()

    def _iso(self, offset_s: float = 0) -> str:
        return (self._clock() + timedelta(seconds=offset_s)).isoformat(timespec='seconds')

    @contextlib.contextmanager
    def _immediate(self) -> Iterator[None]:
        """조회 → 쓰기를 한 트랜잭션으로 묶는다. 예외가 나면 되돌린다."""
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                yield
            except BaseException:
                self._db.execute('ROLLBACK')
                raise
            self._db.execute('COMMIT')

    def _row(self, request_id: int) -> sqlite3.Row | None:
        return self._db.execute(
            'SELECT * FROM export_requests WHERE id=?', (request_id,)
        ).fetchone()

    def enqueue(self, order_no: str, target: str, cost: int, shipping_fee: int) -> ExportRequest:
        """요청을 넣는다. 같은 (주문번호, 대상) 이 있으면 새 행을 만들지 않는다.

        값이 같으면 기존 행을 그대로 돌려준다. 값이 다르면 — 이미 기입했거나(done) 기입 중(running)
        이면 거절하고, 아직 안 했거나 실패한 요청이면 새 값으로 바꿔 다시 대기시킨다.
        """
        now = self._iso()
        with self._immediate():
            row = self._db.execute(
                'SELECT * FROM export_requests WHERE order_no=? AND target=?', (order_no, target)
            ).fetchone()
            if row is None:
                cur = self._db.execute(
                    'INSERT INTO export_requests '
                    '(order_no, target, cost, shipping_fee, next_at, created_at, updated_at) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?)',
                    (order_no, target, cost, shipping_fee, now, now, now),
                )
                row = self._row(int(cur.lastrowid or 0))
            elif (row['cost'], row['shipping_fee']) != (cost, shipping_fee):
                if row['status'] in ('done', 'running'):
                    raise ExportConflict(
                        f'{order_no}({target}) 는 이미 {row["status"]} 다 — '
                        f'기존 {row["cost"]}/{row["shipping_fee"]}, 요청 {cost}/{shipping_fee}'
                    )
                self._db.execute(
                    "UPDATE export_requests SET cost=?, shipping_fee=?, status='pending', "
                    'fail_reason=NULL, detail=NULL, attempts=0, notified=0, next_at=?, '
                    'updated_at=? WHERE id=?',
                    (cost, shipping_fee, now, now, row['id']),
                )
                row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def get(self, request_id: int) -> ExportRequest:
        with self._lock:
            row = self._row(request_id)
        if row is None:
            raise KeyError(request_id)
        return _to_request(row)

    def find(self, order_no: str, target: str) -> ExportRequest | None:
        with self._lock:
            row = self._db.execute(
                'SELECT * FROM export_requests WHERE order_no=? AND target=?', (order_no, target)
            ).fetchone()
        return _to_request(row) if row is not None else None

    def claim_next(self, targets: Sequence[str]) -> ExportRequest | None:
        """맡은 대상의 대기 요청 중 가장 오래된 것을 running 으로 바꿔 돌려준다."""
        if not targets:
            return None
        now = self._iso()
        marks = ','.join('?' for _ in targets)
        with self._immediate():
            row = self._db.execute(
                f"SELECT * FROM export_requests WHERE status='pending' AND next_at<=? "  # noqa: S608
                f'AND target IN ({marks}) ORDER BY created_at, id LIMIT 1',
                (now, *targets),
            ).fetchone()
            if row is None:
                return None
            self._db.execute(
                "UPDATE export_requests SET status='running', attempts=attempts+1, updated_at=? "
                'WHERE id=?',
                (now, row['id']),
            )
            row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def done(self, request_id: int, detail: str) -> None:
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='done', fail_reason=NULL, detail=?, "
                'updated_at=? WHERE id=?',
                (detail, self._iso(), request_id),
            )

    def fail(self, request_id: int, reason: ExportFail, detail: str) -> None:
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='failed', fail_reason=?, detail=?, "
                'updated_at=? WHERE id=?',
                (reason.value, detail, self._iso(), request_id),
            )

    def retry_later(
        self, request_id: int, reason: ExportFail, detail: str, delay_s: float
    ) -> None:
        """다시 대기시킨다. delay_s 가 지나야 다시 집힌다."""
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='pending', fail_reason=?, detail=?, "
                'next_at=?, updated_at=? WHERE id=?',
                (reason.value, detail, self._iso(delay_s), self._iso(), request_id),
            )

    def recover_running(self, targets: Sequence[str]) -> int:
        """작업자가 도중에 죽어 남은 running 을 되돌린다.

        다시 돌려도 안전하다 — 작업자는 입력 전에 먼저 읽고, 값이 이미 같으면 입력하지 않는다.
        """
        if not targets:
            return 0
        marks = ','.join('?' for _ in targets)
        now = self._iso()
        with self._immediate():
            cur = self._db.execute(
                f"UPDATE export_requests SET status='pending', next_at=?, updated_at=? "  # noqa: S608
                f"WHERE status='running' AND target IN ({marks})",
                (now, now, *targets),
            )
        return int(cur.rowcount)

    def requeue(self, order_no: str, target: str) -> ExportRequest | None:
        """실패한 요청을 같은 값으로 다시 대기시킨다(사람이 원인을 고친 뒤)."""
        now = self._iso()
        with self._immediate():
            row = self._db.execute(
                "SELECT * FROM export_requests WHERE order_no=? AND target=? AND status='failed'",
                (order_no, target),
            ).fetchone()
            if row is None:
                return None
            self._db.execute(
                "UPDATE export_requests SET status='pending', fail_reason=NULL, detail=NULL, "
                'attempts=0, notified=0, next_at=?, updated_at=? WHERE id=?',
                (now, now, row['id']),
            )
            row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def wait(
        self,
        request_id: int,
        timeout_s: float,
        *,
        poll_s: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> ExportRequest:
        """요청이 끝나길 기다린다. 제한 시간이 지나면 그때 상태 그대로 돌려준다."""
        if timeout_s <= 0:
            return self.get(request_id)
        deadline = monotonic() + timeout_s
        while True:
            req = self.get(request_id)
            if req.status in TERMINAL or monotonic() >= deadline:
                return req
            sleep(poll_s)

    def unnotified_failed(self) -> list[ExportRequest]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM export_requests WHERE status='failed' AND notified=0 ORDER BY id"
            ).fetchall()
        return [_to_request(r) for r in rows]

    def mark_notified(self, request_id: int) -> None:
        with self._immediate():
            self._db.execute(
                'UPDATE export_requests SET notified=1, updated_at=? WHERE id=?',
                (self._iso(), request_id),
            )

    def recent(self, limit: int = 20) -> list[ExportRequest]:
        with self._lock:
            rows = self._db.execute(
                'SELECT * FROM export_requests ORDER BY updated_at DESC, id DESC LIMIT ?',
                (limit,),
            ).fetchall()
        return [_to_request(r) for r in rows]

    def beat(self, targets: Sequence[str]) -> None:
        """입력 작업자가 살아 있고 이 대상을 맡고 있다는 표시."""
        now = self._iso()
        with self._immediate():
            for target in targets:
                self._db.execute(
                    'INSERT INTO export_heartbeat (target, beat_at) VALUES (?, ?) '
                    'ON CONFLICT(target) DO UPDATE SET beat_at=excluded.beat_at',
                    (target, now),
                )

    def alive(self, target: str, within_s: float = 30.0) -> bool:
        """이 대상을 맡은 작업자가 최근에 표시를 남겼는가."""
        with self._lock:
            row = self._db.execute(
                'SELECT beat_at FROM export_heartbeat WHERE target=?', (target,)
            ).fetchone()
        if row is None:
            return False
        return row['beat_at'] >= self._iso(-within_s)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_export_store.py -v`
Expected: PASS (테스트 20개)

- [ ] **Step 5: 린트**

Run: `uv run ruff check src/samba_agent/export tests/test_export_store.py tests/test_export_routing.py`
Expected: `All checks passed!`

- [ ] **Step 6: 커밋**

```bash
git add samba-agent/src/samba_agent/export/failures.py samba-agent/src/samba_agent/export/store.py samba-agent/tests/test_export_store.py
git commit -m "기능: 외부 기입 큐 — 중복 방지·재시도 예약·작업자 생존 표시"
```

---

### Task 3: `export` 단계 함수

**Files:**
- Create: `samba-agent/src/samba_agent/export/stage.py`
- Test: `samba-agent/tests/test_export_stage.py`

**Interfaces:**
- Consumes:
  - `ExportRouting.target_for(seller) -> Target | None` (Task 1)
  - `ExportQueue.enqueue / wait / alive`, `ExportConflict` (Task 2)
  - `RunState` (`samba_agent.supervisor.state`), `AgentResult` · `Evidence` (`samba_agent.agents.contracts`)
- Produces:
  - `ExportFn = Callable[[RunState], AgentResult]`
  - `export_values(state: RunState) -> tuple[int, int] | None` — (원가, 배송비)
  - `make_exporter(queue: ExportQueue, routing: ExportRouting, *, wait_s: float = 60.0, poll_s: float = 1.0, sleep: Callable[[float], None] = time.sleep) -> ExportFn`
  - 결과 `payload['export']` 값: `'skipped'` · `'planned'` · `'done'` · `'pending'` · `'failed'` · `'conflict'`

결과의 `status` 는 항상 `'ok'` 다 — 외부 기입 결과는 주문 결과를 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_export_stage.py`:

```python
# export 단계 — 대상 결정 · 큐 적재 · 결과 대기. 어떤 경우에도 주문 결과는 ok 다
from pathlib import Path

import pytest

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.export.failures import ExportFail
from samba_agent.export.routing import ExportRouting
from samba_agent.export.stage import export_values, make_exporter
from samba_agent.export.store import ExportQueue

ROUTING = ExportRouting(emp=('GS이숍',), skip=('포이즌',), default='shopmine')


def order(seller: str) -> OrderRef:
    return OrderRef(order_no='A1', source='무신사', seller=seller, sku='S1', qty=1)


def recorded(real_price: object = 62470.0, shipping_fee: object = 2300) -> AgentResult:
    return AgentResult(
        status='ok',
        reason='기록 완료',
        payload={
            'saved': True,
            'values': {'real_price': real_price, 'shipping_fee': shipping_fee},
        },
    )


def state(seller: str = 'GS이숍(캐논)', dry_run: bool = False, **results: AgentResult) -> dict:
    return {
        'order': order(seller),
        'options': {},
        'job_id': 1,
        'dry_run': dry_run,
        'results': results or {'recorder': recorded()},
    }


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


def test_기록한_원가와_배송비를_정수로_꺼낸다():
    assert export_values(state()) == (62470, 2300)


def test_소수_원가는_반올림한다():
    assert export_values(state(recorder=recorded(62469.6, 0))) == (62470, 0)


def test_배송비가_없으면_0():
    assert export_values(state(recorder=recorded(62470, None))) == (62470, 0)


def test_dry_run_기록의_계획값도_읽는다():
    planned = AgentResult(
        status='ok',
        reason='dry-run',
        payload={'saved': False, 'planned': {'real_price': 50000, 'shipping_fee': 3000}},
    )
    assert export_values(state(recorder=planned)) == (50000, 3000)


@pytest.mark.parametrize('cost', [None, 0, -1, '62470', True])
def test_원가가_없거나_숫자가_아니면_값이_없다(cost):
    assert export_values(state(recorder=recorded(cost, 2300))) is None


def test_기록_결과가_없으면_값이_없다():
    buyer = AgentResult(status='ok', reason='구매', payload={'cost': 62470})
    assert export_values(state(**{'buyer.musinsa': buyer})) is None


def test_작업자가_끝내면_done(queue):
    queue.beat(['emp'])

    def sleep(_s: float) -> None:
        req = queue.claim_next(['emp'])
        assert req is not None
        queue.done(req.id, '기입 완료')

    out = make_exporter(queue, ROUTING, wait_s=10, sleep=sleep)(state())
    assert out.status == 'ok'
    assert out.payload == {
        'export': 'done',
        'target': 'emp',
        'cost': 62470,
        'shipping_fee': 2300,
        'detail': '기입 완료',
    }
    assert out.fail_reason is None


def test_작업자가_실패해도_주문_결과는_ok(queue):
    queue.beat(['emp'])

    def sleep(_s: float) -> None:
        req = queue.claim_next(['emp'])
        assert req is not None
        queue.fail(req.id, ExportFail.VALUE_CONFLICT, '이미 다른 값 50,000')

    out = make_exporter(queue, ROUTING, wait_s=10, sleep=sleep)(state())
    assert out.status == 'ok'
    assert out.payload['export'] == 'failed'
    assert out.payload['fail_reason'] == 'value_conflict'
    assert 'value_conflict' in out.reason


def test_작업자가_없으면_기다리지_않고_pending(queue):
    slept: list[float] = []
    out = make_exporter(queue, ROUTING, wait_s=10, sleep=slept.append)(state())
    assert out.status == 'ok'
    assert out.payload['export'] == 'pending'
    assert slept == []
    assert queue.find('A1', 'emp') is not None  # 요청은 큐에 남는다
    assert '대기' in out.reason


def test_나머지_판매처는_샵마인으로_넣는다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(seller='스마트스토어'))
    assert out.payload['target'] == 'shopmine'
    assert queue.find('A1', 'shopmine') is not None


def test_제외_판매처는_큐에_넣지_않는다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(seller='포이즌'))
    assert out.status == 'ok'
    assert out.payload['export'] == 'skipped'
    assert queue.recent() == []


def test_원가가_없으면_큐에_넣지_않는다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(recorder=recorded(None, 0)))
    assert out.status == 'ok'
    assert out.payload['export'] == 'skipped'
    assert queue.recent() == []


def test_dry_run_은_계획만_돌려준다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(dry_run=True))
    assert out.status == 'ok'
    assert out.payload == {
        'export': 'planned',
        'target': 'emp',
        'cost': 62470,
        'shipping_fee': 2300,
    }
    assert queue.recent() == []


def test_dry_run_표시가_없으면_dry_run_으로_본다(queue):
    s = state()
    del s['dry_run']
    out = make_exporter(queue, ROUTING, wait_s=0)(s)
    assert out.payload['export'] == 'planned'
    assert queue.recent() == []


def test_이미_기입한_주문을_다른_값으로_다시_넣으면_conflict(queue):
    req = queue.enqueue('A1', 'emp', 50000, 2300)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    out = make_exporter(queue, ROUTING, wait_s=0)(state())
    assert out.status == 'ok'
    assert out.payload['export'] == 'conflict'
    assert queue.get(req.id).cost == 50000


def test_근거를_남긴다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state())
    assert [e.label for e in out.evidence] == ['외부 기입']
    assert 'emp' in out.evidence[0].detail
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_export_stage.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'samba_agent.export.stage'`

- [ ] **Step 3: 구현**

`samba-agent/src/samba_agent/export/stage.py`:

```python
"""export 단계 — 검증이 끝난 주문의 원가·배송비를 외부 기입 큐에 넣는다.

이 단계는 주문 결과를 바꾸지 않는다. 기입이 실패하든 늦든 돌려주는 결과는 항상 ok 이고,
실제 기입 결과는 payload['export'] 에 담는다(실패 알림은 export.notify 가 따로 보낸다).
"""

import time
from collections.abc import Callable

from samba_agent.agents.contracts import AgentResult, Evidence
from samba_agent.export.routing import ExportRouting
from samba_agent.export.store import ExportConflict, ExportQueue
from samba_agent.supervisor.state import RunState

ExportFn = Callable[[RunState], AgentResult]


def _won(value: object) -> int | None:
    """금액 → 원 단위 정수. 숫자가 아니면 None(불리언·문자열은 숫자로 치지 않는다)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return int(round(float(value)))


def export_values(state: RunState) -> tuple[int, int] | None:
    """기록 단계가 삼바웨이브에 적은 (원가, 배송비). 원가가 없으면 None.

    기록 결과만 본다 — 구매 단계의 견적 원가는 실제 결제액과 다를 수 있어 쓰지 않는다.
    """
    recorder = state.get('results', {}).get('recorder')
    if recorder is None:
        return None
    values = recorder.payload.get('values') or recorder.payload.get('planned')
    if not isinstance(values, dict):
        return None
    cost = _won(values.get('real_price'))
    if cost is None or cost <= 0:
        return None
    return cost, max(_won(values.get('shipping_fee')) or 0, 0)


def _result(reason: str, payload: dict[str, object]) -> AgentResult:
    return AgentResult(
        status='ok',
        reason=reason,
        payload=payload,
        evidence=(Evidence(label='외부 기입', detail=reason),),
    )


def make_exporter(
    queue: ExportQueue,
    routing: ExportRouting,
    *,
    wait_s: float = 60.0,
    poll_s: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
) -> ExportFn:
    """그래프의 export 노드가 부를 함수를 만든다."""

    def exporter(state: RunState) -> AgentResult:
        order = state['order']
        values = export_values(state)
        if values is None:
            return _result('외부 기입 건너뜀 — 기록된 원가가 없다', {'export': 'skipped'})
        cost, shipping_fee = values
        target = routing.target_for(order.seller)
        if target is None:
            return _result(
                f'외부 기입 건너뜀 — 기입 제외 판매처({order.seller or "판매처 없음"})',
                {'export': 'skipped'},
            )
        plan: dict[str, object] = {'target': target, 'cost': cost, 'shipping_fee': shipping_fee}
        if state.get('dry_run', True):
            return _result(
                f'dry-run: {target} 에 원가 {cost:,} · 배송비 {shipping_fee:,} 기입 예정',
                {'export': 'planned', **plan},
            )
        try:
            req = queue.enqueue(order.order_no, target, cost, shipping_fee)
        except ExportConflict as e:
            return _result(f'외부 기입 충돌({target}) — {e}', {'export': 'conflict', **plan})
        # 그 대상을 맡은 작업자가 떠 있을 때만 기다린다 — 없으면 주문마다 제한 시간을 통째로 쓴다
        waited = wait_s if queue.alive(target) else 0
        final = queue.wait(req.id, waited, poll_s=poll_s, sleep=sleep)
        if final.status == 'done':
            return _result(
                f'{target} 에 원가 {cost:,} · 배송비 {shipping_fee:,} 기입',
                {'export': 'done', **plan, 'detail': final.detail},
            )
        if final.status == 'failed':
            return _result(
                f'외부 기입 실패({target}) — {final.fail_reason}: {final.detail}',
                {
                    'export': 'failed',
                    **plan,
                    'fail_reason': final.fail_reason,
                    'detail': final.detail,
                },
            )
        return _result(
            f'외부 기입 대기 중({target}) — 입력 작업자가 처리하면 반영된다',
            {'export': 'pending', **plan},
        )

    return exporter
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_export_stage.py -v`
Expected: PASS (테스트 20개)

- [ ] **Step 5: 커밋**

```bash
git add samba-agent/src/samba_agent/export/stage.py samba-agent/tests/test_export_stage.py
git commit -m "기능: export 단계 — 기록된 원가·배송비를 큐에 넣고 결과를 기다린다"
```

---

### Task 4: 감독자 그래프에 `export` 노드

**Files:**
- Modify: `samba-agent/src/samba_agent/supervisor/graph.py:179-250` (`build_supervisor`)
- Test: `samba-agent/tests/test_supervisor_export.py`

**Interfaces:**
- Consumes: `ExportFn = Callable[[RunState], AgentResult]` (Task 3)
- Produces: `build_supervisor(reg, agents, *, checkpointer=None, gate=False, on_stage_start=None, on_agent_result=None, exporter: Callable[[RunState], AgentResult] | None = None)`
  - `exporter` 가 없으면 그래프는 지금과 똑같다.
  - 있으면 `verify → export → finish`. 결과는 `state['results']['exporter']` 에 담긴다.

`STAGES` · `KIND_OF_STAGE` · 등록부는 건드리지 않는다. `export` 는 브릿지 도구도 LLM 도 쓰지 않아
등록부 행(도구·규칙·프롬프트·데이터셋)이 필요 없다.

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_supervisor_export.py`:

```python
# 감독자 — export 노드는 검증 뒤에 돌고, 어떤 경우에도 주문 결과를 바꾸지 않는다
import pytest

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor

ORDER = OrderRef(order_no='A1', source='무신사', seller='GS이숍(캐논)', sku='S1', qty=1)


def ok(name: str, **payload) -> AgentResult:
    return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)


def agents(**over):
    base = {
        'buyer.musinsa': lambda _a: ok(
            'buyer', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5
        ),
        'payer': lambda _a: ok('payer'),
        'recorder': lambda _a: ok(
            'recorder', values={'real_price': 62470, 'shipping_fee': 2300}
        ),
        'verifier': lambda _a: ok('verifier'),
    }
    base.update(over)
    return base


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def run(reg, agents_map, exporter=None, **hooks) -> dict:
    graph = build_supervisor(reg, agents_map, exporter=exporter, **hooks)
    return graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True})


def test_exporter_가_없으면_그래프는_예전과_같다(reg):
    out = run(reg, agents())
    assert out['outcome'] == 'done'
    assert list(out['results']) == ['buyer.musinsa', 'payer', 'recorder', 'verifier']


def test_export_는_검증_뒤에_돈다(reg):
    seen: list[list[str]] = []

    def exporter(state):
        seen.append(list(state['results']))
        return ok('exporter', export='done')

    out = run(reg, agents(), exporter)
    assert seen == [['buyer.musinsa', 'payer', 'recorder', 'verifier']]
    assert out['outcome'] == 'done'
    assert list(out['results'])[-1] == 'exporter'
    assert out['results']['exporter'].payload['export'] == 'done'


def test_export_는_기록_결과를_본다(reg):
    got: dict = {}

    def exporter(state):
        got.update(state['results']['recorder'].payload['values'])
        return ok('exporter', export='done')

    run(reg, agents(), exporter)
    assert got == {'real_price': 62470, 'shipping_fee': 2300}


def test_export_가_예외를_던져도_주문은_done(reg):
    def exporter(_state):
        raise RuntimeError('큐 파일을 못 연다')

    out = run(reg, agents(), exporter)
    assert out['outcome'] == 'done'
    assert out['fail_reason'] is None
    assert out['results']['exporter'].status == 'ok'
    assert out['results']['exporter'].payload == {'export': 'error'}


def test_export_가_실패_결과를_돌려줘도_주문은_done(reg):
    def exporter(_state):
        return AgentResult(status='fail', reason='잘못된 구현', fail_reason=FailReason.UNKNOWN)

    out = run(reg, agents(), exporter)
    assert out['outcome'] == 'done'
    assert out['fail_reason'] is None


def test_검증이_실패하면_export_는_돌지_않는다(reg):
    calls = {'n': 0}

    def exporter(_state):
        calls['n'] += 1
        return ok('exporter', export='done')

    def bad_verifier(_a):
        return AgentResult(
            status='fail', reason='불일치', fail_reason=FailReason.VERIFY_MISMATCH
        )

    out = run(reg, agents(verifier=bad_verifier), exporter)
    assert out['outcome'] == 'needs_human'
    assert calls['n'] == 0
    assert 'exporter' not in out['results']


def test_export_근거가_state_에_쌓인다(reg):
    from samba_agent.agents.contracts import Evidence

    def exporter(_state):
        return AgentResult(
            status='ok',
            reason='기입',
            payload={'export': 'done'},
            evidence=(Evidence(label='외부 기입', detail='emp 에 기입'),),
        )

    out = run(reg, agents(), exporter)
    assert out['evidence'][-1].label == '외부 기입'


def test_export_도_에이전트_결과_훅에_남는다(reg):
    seen: list[tuple[str, str, str]] = []

    def hook(_state, stage, name, result, _ms, _attempt):
        seen.append((stage, name, result.status))

    run(reg, agents(), lambda _s: ok('exporter', export='done'), on_agent_result=hook)
    assert seen[-1] == ('export', 'exporter', 'ok')
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_supervisor_export.py -v`
Expected: FAIL — `TypeError: build_supervisor() got an unexpected keyword argument 'exporter'`

- [ ] **Step 3: 구현 — export 노드 함수 추가**

`samba-agent/src/samba_agent/supervisor/graph.py` 의 `_finish` 함수(118행) **바로 위**에 넣는다:

```python
# 외부 기입 결과가 state 에 담기는 이름
EXPORTER_NAME = 'exporter'
# export 노드 함수 — 검증까지 끝난 state 를 받아 결과 하나를 돌려준다
ExportFn = Callable[[RunState], AgentResult]


def _run_export(
    exporter: ExportFn,
    state: RunState,
    on_agent_result: 'AgentResultHook | None' = None,
) -> RunState:
    """외부 기입 — 주문 결과를 바꾸지 않는다.

    결제·기록·검증이 끝난 주문이다. 외부 프로그램 기입이 실패하거나 예외가 나도 outcome 은
    건드리지 않는다 — 여기서 멈추면 이미 산 주문이 사람 대기로 남는다.
    """
    started = time.monotonic()
    try:
        result = exporter(state)
    except Exception:  # noqa: BLE001 — 외부 기입 오류가 주문 처리를 막으면 안 된다
        _log.exception('외부 기입 요청 실패 — 주문은 완료로 둔다')
        result = AgentResult(
            status='ok',
            reason='외부 기입 요청 중 오류 — 주문은 완료로 둔다',
            payload={'export': 'error'},
        )
    if result.status != 'ok':
        # 계약 위반(export 는 항상 ok 를 돌려준다) — 주문을 멈추지 않고 사유만 남긴다
        result = AgentResult(
            status='ok',
            reason=f'외부 기입 결과 이상 — {result.reason}',
            payload={'export': 'error'},
            evidence=result.evidence,
        )
    if on_agent_result is not None:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        try:
            on_agent_result(state, 'export', EXPORTER_NAME, result, elapsed_ms, 1)
        except Exception:  # noqa: BLE001 — 기록 실패가 주문 처리를 막으면 안 된다
            _log.exception('에이전트 결과 기록 실패 — 계속한다: %s', EXPORTER_NAME)
    result = sanitize_result(result)
    return {
        **state,
        'results': {**state.get('results', {}), EXPORTER_NAME: result},
        'evidence': [*state.get('evidence', []), *result.evidence],
    }
```

- [ ] **Step 4: 구현 — `build_supervisor` 에 인자와 노드·간선 추가**

`build_supervisor` 의 시그니처를 바꾼다:

```python
def build_supervisor(
    reg: Registry,
    agents: Mapping[str, AgentFn],
    *,
    checkpointer: object | None = None,
    gate: bool = False,
    on_stage_start: 'StageHook | None' = None,
    on_agent_result: 'AgentResultHook | None' = None,
    exporter: 'ExportFn | None' = None,
):
    """감독자 그래프를 만든다. agents 는 이름 → 함수(실제 에이전트 또는 테스트용 가짜).

    exporter 를 주면 검증 뒤에 외부 기입 노드가 붙는다(verify → export → finish).
    """
```

같은 함수 안의 노드·간선 구성부(지금의 235~246행)를 아래로 바꾼다:

```python
    for stage in STAGES:
        graph.add_node(stage, make(stage))
    graph.add_node('finish', _finish)
    # 마지막 단계 다음 — 외부 기입이 있으면 거쳐 가고, 없으면 바로 끝낸다
    after_last = 'finish'
    if exporter is not None:

        def export_node(state: RunState) -> RunState:
            if state.get('outcome') is not None:
                return state
            return _run_export(exporter, state, on_agent_result)

        graph.add_node('export', export_node)
        graph.add_edge('export', 'finish')
        after_last = 'export'
    graph.set_entry_point(STAGES[0])
    for i, stage in enumerate(STAGES):
        nxt = STAGES[i + 1] if i + 1 < len(STAGES) else after_last
        graph.add_conditional_edges(
            stage,
            lambda s, nxt=nxt: 'finish' if s.get('outcome') is not None else nxt,
            {nxt: nxt, 'finish': 'finish'},
        )
    graph.add_edge('finish', END)
```

- [ ] **Step 5: 통과 확인**

Run: `uv run pytest tests/test_supervisor_export.py -v`
Expected: PASS (테스트 8개)

- [ ] **Step 6: 기존 감독자·승인·실행기 테스트가 그대로인지 확인**

Run: `uv run pytest tests/test_supervisor.py tests/test_approval_gate.py tests/test_worker.py tests/test_main_wiring.py -v`
Expected: PASS — 이 계획을 시작하기 전과 같은 개수가 통과한다(실패 0)

- [ ] **Step 7: 커밋**

```bash
git add samba-agent/src/samba_agent/supervisor/graph.py samba-agent/tests/test_supervisor_export.py
git commit -m "기능: 감독자 그래프에 export 노드 — 검증 뒤에 돌고 주문 결과를 바꾸지 않는다"
```

---

### Task 5: 입력 작업자

**Files:**
- Create: `samba-agent/src/samba_agent/export/adapters.py`
- Create: `samba-agent/src/samba_agent/export/idle.py`
- Create: `samba-agent/src/samba_agent/export/worker.py`
- Test: `samba-agent/tests/test_export_worker.py`

**Interfaces:**
- Consumes: `ExportQueue`, `ExportRequest` (Task 2), `ExportFail` (Task 2)
- Produces:
  - `@dataclass(frozen=True) class CellValues` — `cost: int | None`, `shipping_fee: int | None`
  - `class AdapterRetry(Exception)` — `__init__(reason: ExportFail, detail: str)`, 속성 `reason` `detail`
  - `class AdapterReject(Exception)` — 같은 모양
  - `class Adapter(Protocol)`:
    - `read(order_no: str) -> CellValues` — 행을 1건으로 특정해 현재 값을 읽는다
    - `write(order_no: str, cost: int, shipping_fee: int) -> None` — 행을 다시 특정해 입력하고 저장한다
  - `user_idle_seconds() -> float` (`export/idle.py`)
  - `class ExportWorker`:
    - `__init__(queue: ExportQueue, adapters: Mapping[str, Adapter], *, user_idle_s: Callable[[], float], min_idle_s: float = 20.0, max_attempts: int = 5, retry_delay_s: float = 60.0)`
    - `run_once() -> ExportRequest | None` — 처리한 요청의 최종 상태, 할 일이 없으면 `None`
    - `run_forever(should_stop: Callable[[], bool], poll_s: float = 3.0, sleep: Callable[[float], None] = time.sleep) -> None`

어댑터 규약(후속 어댑터 계획이 지킨다):
- 주문이 없으면 `AdapterReject(NOT_FOUND)`, 검색 결과가 여러 건이면 `AdapterReject(AMBIGUOUS)`.
- 창이 없으면 `AdapterRetry(WINDOW_MISSING)`, 대화상자가 떠 있으면 `AdapterRetry(BLOCKED)`, 화면이 반응하지 않으면 `AdapterRetry(TIMEOUT)`.
- `write` 는 입력 직전에 선택 행의 주문번호를 다시 확인한다. 다르면 아무것도 입력하지 않고 `AdapterReject(AMBIGUOUS)`.
- 빈 셀과 0 은 `None` 또는 `0` 으로 돌려준다(작업자는 둘을 같게 본다).

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_export_worker.py`:

```python
# 입력 작업자 — 읽기 → (필요하면) 쓰기 → 되읽기. 덮어쓰지 않고, 한 번에 한 건만
from pathlib import Path

import pytest

from samba_agent.export.adapters import AdapterReject, AdapterRetry, CellValues
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker


class FakeAdapter:
    """메모리 위의 주문 표. 실제 화면 대신 쓴다."""

    def __init__(self, rows: dict[str, CellValues] | None = None) -> None:
        self.rows = dict(rows or {})
        self.calls: list[str] = []
        self.read_error: Exception | None = None
        self.write_error: Exception | None = None
        # 쓰기가 값을 다르게 저장하는 고장(되읽기 불일치 시험용)
        self.corrupt = False

    def read(self, order_no: str) -> CellValues:
        self.calls.append(f'read {order_no}')
        if self.read_error is not None:
            raise self.read_error
        if order_no not in self.rows:
            raise AdapterReject(ExportFail.NOT_FOUND, f'{order_no} 없음')
        return self.rows[order_no]

    def write(self, order_no: str, cost: int, shipping_fee: int) -> None:
        self.calls.append(f'write {order_no} {cost} {shipping_fee}')
        if self.write_error is not None:
            raise self.write_error
        self.rows[order_no] = CellValues(cost + 1 if self.corrupt else cost, shipping_fee)


EMPTY = CellValues(None, None)


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


def worker(queue, adapter, idle: float = 999.0, **kw) -> ExportWorker:
    return ExportWorker(queue, {'emp': adapter}, user_idle_s=lambda: idle, **kw)


def test_빈_셀에_기입하고_되읽어_확인한다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out is not None
    assert out.id == req.id
    assert out.status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)
    assert adapter.calls == ['read A1', 'write A1 62470 2300', 'read A1']


def test_0_은_빈_셀로_본다(queue):
    adapter = FakeAdapter({'A1': CellValues(0, 0)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter).run_once().status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)


def test_이미_같은_값이면_입력하지_않는다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, 2300)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert adapter.calls == ['read A1']
    assert '이미' in (out.detail or '')


def test_배송비_0_과_빈_셀은_같은_값이다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, None)})
    queue.enqueue('A1', 'emp', 62470, 0)
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert adapter.calls == ['read A1']


def test_한쪽만_비어_있으면_기입한다(queue):
    adapter = FakeAdapter({'A1': CellValues(None, 2300)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter).run_once().status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)


@pytest.mark.parametrize(
    'current', [CellValues(50000, 2300), CellValues(62470, 3000), CellValues(50000, None)]
)
def test_다른_값이_있으면_덮어쓰지_않는다(queue, current):
    adapter = FakeAdapter({'A1': current})
    queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'value_conflict'
    assert adapter.rows['A1'] == current
    assert adapter.calls == ['read A1']


def test_되읽은_값이_다르면_실패하고_재시도하지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.corrupt = True
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'verify_mismatch'
    assert w.run_once() is None  # 다시 집히지 않는다


def test_주문이_없으면_실패하고_재시도하지_않는다(queue):
    adapter = FakeAdapter({})
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'not_found'
    assert w.run_once() is None


def test_창이_없으면_나중에_다시_한다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.read_error = AdapterRetry(ExportFail.WINDOW_MISSING, 'EMP 창 없음')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0)
    out = w.run_once()
    assert out.status == 'pending'
    assert out.fail_reason == 'window_missing'
    adapter.read_error = None
    assert w.run_once().status == 'done'


def test_재시도_한도를_넘으면_실패로_끝낸다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.read_error = AdapterRetry(ExportFail.BLOCKED, '인증 대화상자')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0, max_attempts=3)
    assert w.run_once().status == 'pending'
    assert w.run_once().status == 'pending'
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'blocked'
    assert out.attempts == 3
    assert '재시도' in (out.detail or '')


def test_쓰기_도중_모르는_오류는_재시도하지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.write_error = RuntimeError('알 수 없는 오류')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'unknown'
    assert w.run_once() is None


def test_사람이_쓰는_중이면_집지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter, idle=3.0).run_once() is None
    assert queue.get(req.id).status == 'pending'
    assert queue.get(req.id).attempts == 0
    assert adapter.calls == []


def test_어댑터가_없는_대상은_집지_않는다(queue):
    req = queue.enqueue('A1', 'shopmine', 62470, 2300)
    assert worker(queue, FakeAdapter({'A1': EMPTY})).run_once() is None
    assert queue.get(req.id).status == 'pending'


def test_어댑터가_하나도_없으면_아무것도_하지_않는다(queue):
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = ExportWorker(queue, {}, user_idle_s=lambda: 999.0)
    assert w.run_once() is None


def test_한_번에_한_건만_처리한다(queue):
    adapter = FakeAdapter({'A1': EMPTY, 'A2': EMPTY})
    queue.enqueue('A1', 'emp', 1000, 0)
    queue.enqueue('A2', 'emp', 2000, 0)
    w = worker(queue, adapter)
    assert w.run_once().order_no == 'A1'
    assert adapter.rows['A2'] == EMPTY
    assert w.run_once().order_no == 'A2'
    assert w.run_once() is None


def test_run_forever_는_생존_표시를_남기고_멈춘다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, False, True])
    slept: list[float] = []
    worker(queue, adapter).run_forever(lambda: next(stops), poll_s=3.0, sleep=slept.append)
    assert queue.alive('emp') is True
    assert queue.find('A1', 'emp').status == 'done'
    assert slept == [3.0]  # 첫 바퀴는 일을 했으니 쉬지 않고, 둘째 바퀴는 할 일이 없어 쉰다


def test_run_forever_는_고리_오류로_죽지_않는다(queue):
    class Broken(FakeAdapter):
        def read(self, order_no: str) -> CellValues:
            raise AdapterRetry(ExportFail.TIMEOUT, '응답 없음')

    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, True])
    worker(queue, Broken(), retry_delay_s=0).run_forever(
        lambda: next(stops), sleep=lambda _s: None
    )
    assert queue.find('A1', 'emp').status == 'pending'
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_export_worker.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'samba_agent.export.adapters'`

- [ ] **Step 3: 구현 — 어댑터 인터페이스**

`samba-agent/src/samba_agent/export/adapters.py`:

```python
"""어댑터 규약 — 외부 프로그램 1개의 주문 표를 읽고 쓴다.

작업자는 이 두 함수만 부른다. 화면을 어떻게 다루는지(검색·셀 선택·저장)는 어댑터 안의 일이다.
"""

from dataclasses import dataclass
from typing import Protocol

from samba_agent.export.failures import ExportFail


@dataclass(frozen=True)
class CellValues:
    """주문 1행의 원가·배송비. 빈 셀은 None 또는 0 이다(작업자는 둘을 같게 본다)."""

    cost: int | None
    shipping_fee: int | None


class _AdapterError(Exception):
    def __init__(self, reason: ExportFail, detail: str) -> None:
        super().__init__(f'{reason.value}: {detail}')
        self.reason = reason
        self.detail = detail


class AdapterRetry(_AdapterError):
    """다시 하면 풀릴 수 있다 — 창 없음·대화상자·응답 없음."""


class AdapterReject(_AdapterError):
    """다시 해도 같다 — 주문 없음·검색 결과 여러 건·행 불일치."""


class Adapter(Protocol):
    """외부 프로그램 1개.

    두 함수 모두 주문번호로 행을 1건으로 특정한 뒤에만 일한다. 특정하지 못하면 아무것도
    바꾸지 않고 예외를 던진다.
    """

    def read(self, order_no: str) -> CellValues:
        """그 주문의 현재 원가·배송비."""
        ...

    def write(self, order_no: str, cost: int, shipping_fee: int) -> None:
        """원가·배송비를 입력하고 저장한다. 입력 직전에 선택 행의 주문번호를 다시 확인한다."""
        ...
```

- [ ] **Step 4: 구현 — 사용자 입력 없는 시간**

`samba-agent/src/samba_agent/export/idle.py`:

```python
"""사용자가 마지막으로 키보드·마우스를 만진 뒤 지난 시간.

작업자는 사람이 PC 를 쓰는 동안 화면을 건드리지 않는다 — 키 입력이 섞이면 엉뚱한 셀에 값이 들어간다.
삼바브라우저의 페이지 조작(CDP)과 폰 조작(adb)은 Windows 입력으로 잡히지 않는다.
"""

import ctypes
import sys


class _LastInputInfo(ctypes.Structure):
    _fields_ = [('cbSize', ctypes.c_uint), ('dwTime', ctypes.c_uint)]


def user_idle_seconds() -> float:
    """마지막 입력 뒤 지난 초. Windows 가 아니거나 못 읽으면 0(사용 중으로 본다 — 안전한 쪽)."""
    if sys.platform != 'win32':
        return 0.0
    info = _LastInputInfo()
    info.cbSize = ctypes.sizeof(_LastInputInfo)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    # 둘 다 부팅 뒤 밀리초(32비트)다 — 49일마다 0 으로 돌아가므로 차이를 32비트로 자른다
    elapsed_ms = (ctypes.windll.kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF
    return elapsed_ms / 1000.0
```

- [ ] **Step 5: 구현 — 작업자**

`samba-agent/src/samba_agent/export/worker.py`:

```python
"""입력 작업자 — 큐에서 한 건씩 꺼내 어댑터로 기입한다.

관리자 권한으로 따로 도는 프로세스다(EMP 가 관리자 권한이라 일반 권한으로는 입력이 막힌다).
규칙: 먼저 읽는다 → 같은 값이면 입력하지 않는다 → 다른 값이 있으면 덮어쓰지 않는다 →
입력한 뒤에는 되읽어 확인한다.
"""

import logging
import time
from collections.abc import Callable, Mapping

from samba_agent.export.adapters import Adapter, AdapterReject, AdapterRetry, CellValues
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue, ExportRequest

log = logging.getLogger(__name__)


def _same(current: CellValues, req: ExportRequest) -> bool:
    """이미 기입할 값이 들어 있는가. 빈 셀과 0 은 같게 본다."""
    return (current.cost or 0) == req.cost and (current.shipping_fee or 0) == req.shipping_fee


def _conflict(current: CellValues, req: ExportRequest) -> str | None:
    """덮어쓰면 안 되는 값이 있으면 그 설명. 비어 있거나 같은 값이면 None."""
    found: list[str] = []
    if (current.cost or 0) not in (0, req.cost):
        found.append(f'원가 {current.cost:,}(기입할 값 {req.cost:,})')
    if (current.shipping_fee or 0) not in (0, req.shipping_fee):
        found.append(f'배송비 {current.shipping_fee:,}(기입할 값 {req.shipping_fee:,})')
    return ' · '.join(found) or None


class ExportWorker:
    """외부 기입 작업자. 한 번에 1건만 처리한다(프로그램 창이 하나다)."""

    def __init__(
        self,
        queue: ExportQueue,
        adapters: Mapping[str, Adapter],
        *,
        user_idle_s: Callable[[], float],
        min_idle_s: float = 20.0,
        max_attempts: int = 5,
        retry_delay_s: float = 60.0,
    ) -> None:
        self._queue = queue
        self._adapters = dict(adapters)
        self._user_idle_s = user_idle_s
        self._min_idle_s = min_idle_s
        self._max_attempts = max_attempts
        self._retry_delay_s = retry_delay_s

    @property
    def targets(self) -> tuple[str, ...]:
        return tuple(self._adapters)

    def run_once(self) -> ExportRequest | None:
        """요청 1건을 처리하고 그 최종 상태를 돌려준다. 할 일이 없으면 None."""
        if not self._adapters:
            return None
        # 사람이 PC 를 쓰는 중이면 집지도 않는다 — 시도 횟수를 헛되이 쓰지 않는다
        if self._user_idle_s() < self._min_idle_s:
            return None
        req = self._queue.claim_next(self.targets)
        if req is None:
            return None
        self._process(req, self._adapters[req.target])
        return self._queue.get(req.id)

    def _process(self, req: ExportRequest, adapter: Adapter) -> None:
        try:
            current = adapter.read(req.order_no)
            if _same(current, req):
                self._queue.done(req.id, '이미 같은 값이 들어 있어 입력하지 않았다')
                return
            conflict = _conflict(current, req)
            if conflict is not None:
                self._queue.fail(
                    req.id, ExportFail.VALUE_CONFLICT, f'덮어쓰지 않았다 — {conflict}'
                )
                return
            adapter.write(req.order_no, req.cost, req.shipping_fee)
            after = adapter.read(req.order_no)
            if not _same(after, req):
                self._queue.fail(
                    req.id,
                    ExportFail.VERIFY_MISMATCH,
                    f'되읽은 값이 다르다 — 원가 {after.cost} · 배송비 {after.shipping_fee}',
                )
                return
            self._queue.done(
                req.id, f'원가 {req.cost:,} · 배송비 {req.shipping_fee:,} 기입 확인'
            )
        except AdapterRetry as e:
            if req.attempts >= self._max_attempts:
                self._queue.fail(
                    req.id, e.reason, f'재시도 {req.attempts}회 모두 실패 — {e.detail}'
                )
            else:
                self._queue.retry_later(req.id, e.reason, e.detail, self._retry_delay_s)
        except AdapterReject as e:
            self._queue.fail(req.id, e.reason, e.detail)
        except Exception as e:  # noqa: BLE001 — 어댑터 내부 오류의 모양은 정해져 있지 않다
            # 입력이 어디까지 됐는지 모른다 — 자동으로 다시 하지 않고 사람이 본다
            log.exception('외부 기입 중 오류: %s(%s)', req.order_no, req.target)
            self._queue.fail(req.id, ExportFail.UNKNOWN, f'{type(e).__name__}: {e}'[:200])

    def run_forever(
        self,
        should_stop: Callable[[], bool],
        poll_s: float = 3.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """멈추라고 할 때까지 돈다. 일을 했으면 쉬지 않고 바로 다음 건을 본다."""
        while not should_stop():
            worked = False
            try:
                self._queue.beat(self.targets)
                worked = self.run_once() is not None
            except Exception:  # noqa: BLE001 — 한 바퀴의 오류가 작업자를 죽이면 안 된다
                log.exception('입력 작업자 고리 오류 — 계속한다')
            if not worked:
                sleep(poll_s)
```

- [ ] **Step 6: 통과 확인**

Run: `uv run pytest tests/test_export_worker.py -v`
Expected: PASS (테스트 19개)

- [ ] **Step 7: 커밋**

```bash
git add samba-agent/src/samba_agent/export/adapters.py samba-agent/src/samba_agent/export/idle.py samba-agent/src/samba_agent/export/worker.py samba-agent/tests/test_export_worker.py
git commit -m "기능: 외부 기입 작업자 — 읽고, 덮어쓰지 않고, 되읽어 확인한다"
```

---

### Task 6: 실패 알림

**Files:**
- Create: `samba-agent/src/samba_agent/export/notify.py`
- Test: `samba-agent/tests/test_export_notify.py`

**Interfaces:**
- Consumes: `ExportQueue.unnotified_failed() / mark_notified()` (Task 2)
- Produces:
  - `class ExportNotifier`:
    - `__init__(queue: ExportQueue, thread_of: Callable[[str], str | None], post: Callable[[str | None, str], bool])`
      - `thread_of(order_no)` → 그 주문의 슬랙 스레드(없으면 `None`)
      - `post(thread_ts, text)` → 보냈으면 `True` (`SambaBot.post` 와 같은 모양)
    - `tick() -> int` — 이번에 알린 건수
    - `run_forever(should_stop: Callable[[], bool], interval_s: float = 15.0, sleep: Callable[[float], None] = time.sleep) -> None`

`export` 단계가 기다리는 동안 끝난 실패도, 제한 시간이 지난 뒤에 끝난 실패도 이 한 통로로 알린다.

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_export_notify.py`:

```python
# 외부 기입 실패 알림 — 실패한 요청을 주문 스레드에 한 번만 알린다
from pathlib import Path

import pytest

from samba_agent.export.failures import ExportFail
from samba_agent.export.notify import ExportNotifier
from samba_agent.export.store import ExportQueue


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


def failed(queue, order_no: str, target: str = 'emp') -> int:
    req = queue.enqueue(order_no, target, 62470, 2300)
    queue.claim_next([target])
    queue.fail(req.id, ExportFail.VALUE_CONFLICT, '덮어쓰지 않았다 — 원가 50,000')
    return req.id


def test_실패한_요청을_주문_스레드에_알린다(queue):
    failed(queue, 'A1')
    sent: list[tuple[str | None, str]] = []

    def post(thread_ts, text):
        sent.append((thread_ts, text))
        return True

    n = ExportNotifier(queue, lambda no: f'ts-{no}', post).tick()
    assert n == 1
    assert sent[0][0] == 'ts-A1'
    text = sent[0][1]
    assert 'A1' in text
    assert 'emp' in text
    assert 'value_conflict' in text
    assert '50,000' in text
    assert '62,470' in text


def test_한_번_알린_실패는_다시_알리지_않는다(queue):
    failed(queue, 'A1')
    sent: list[str] = []
    notifier = ExportNotifier(queue, lambda _no: None, lambda _t, text: sent.append(text) or True)
    assert notifier.tick() == 1
    assert notifier.tick() == 0
    assert len(sent) == 1


def test_성공과_대기는_알리지_않는다(queue):
    done = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.done(done.id, '기입 완료')
    queue.enqueue('A2', 'emp', 2000, 0)
    sent: list[str] = []
    n = ExportNotifier(queue, lambda _no: None, lambda _t, text: sent.append(text) or True).tick()
    assert n == 0
    assert sent == []


def test_슬랙이_없어도_알린_것으로_친다(queue):
    rid = failed(queue, 'A1')
    n = ExportNotifier(queue, lambda _no: None, lambda _t, _text: False).tick()
    assert n == 1
    assert queue.get(rid).notified is True


def test_전송이_예외를_던지면_다음에_다시_알린다(queue):
    rid = failed(queue, 'A1')

    def post(_t, _text):
        raise RuntimeError('네트워크')

    notifier = ExportNotifier(queue, lambda _no: None, post)
    assert notifier.tick() == 0
    assert queue.get(rid).notified is False


def test_한_건이_실패해도_나머지는_알린다(queue):
    failed(queue, 'A1')
    failed(queue, 'A2')
    sent: list[str] = []

    def post(_t, text):
        if 'A1' in text:
            raise RuntimeError('네트워크')
        sent.append(text)
        return True

    assert ExportNotifier(queue, lambda _no: None, post).tick() == 1
    assert len(sent) == 1
    assert 'A2' in sent[0]


def test_run_forever_는_멈추라고_하면_멈춘다(queue):
    failed(queue, 'A1')
    sent: list[str] = []
    stops = iter([False, True])
    slept: list[float] = []
    ExportNotifier(queue, lambda _no: None, lambda _t, text: sent.append(text) or True).run_forever(
        lambda: next(stops), interval_s=15.0, sleep=slept.append
    )
    assert len(sent) == 1
    assert slept == [15.0]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_export_notify.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'samba_agent.export.notify'`

- [ ] **Step 3: 구현**

`samba-agent/src/samba_agent/export/notify.py`:

```python
"""외부 기입 실패 알림 — 실패한 요청을 그 주문의 슬랙 스레드에 한 번만 알린다.

하네스 프로세스에서 돈다(슬랙 봇이 거기 있다). 입력 작업자는 큐에 결과만 적는다.
"""

import logging
import time
from collections.abc import Callable

from samba_agent.export.store import ExportQueue, ExportRequest

log = logging.getLogger(__name__)


def _text(req: ExportRequest) -> str:
    return (
        f'{req.order_no} 외부 기입 실패({req.target}) — {req.fail_reason}: {req.detail or ""}\n'
        f'기입하려던 값: 원가 {req.cost:,} · 배송비 {req.shipping_fee:,} '
        '(주문은 완료 상태 그대로다. 직접 기입이 필요하다)'
    )


class ExportNotifier:
    """실패 알림 고리."""

    def __init__(
        self,
        queue: ExportQueue,
        thread_of: Callable[[str], str | None],
        post: Callable[[str | None, str], bool],
    ) -> None:
        self._queue = queue
        self._thread_of = thread_of
        self._post = post

    def tick(self) -> int:
        """알리지 않은 실패를 알린다. 이번에 알린 건수를 돌려준다."""
        sent = 0
        for req in self._queue.unnotified_failed():
            try:
                delivered = self._post(self._thread_of(req.order_no), _text(req))
            except Exception:  # noqa: BLE001 — 전송 오류의 모양은 정해져 있지 않다
                # 표시하지 않는다 — 다음 바퀴에 다시 알린다
                log.exception('외부 기입 실패 알림 전송 오류: %s', req.order_no)
                continue
            if not delivered:
                # 슬랙이 없는 실행 — 로그에 남기고 되풀이하지 않는다
                log.warning('%s', _text(req))
            self._queue.mark_notified(req.id)
            sent += 1
        return sent

    def run_forever(
        self,
        should_stop: Callable[[], bool],
        interval_s: float = 15.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        while not should_stop():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 — 알림 오류가 하네스를 죽이면 안 된다
                log.exception('외부 기입 알림 고리 오류 — 계속한다')
            sleep(interval_s)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_export_notify.py -v`
Expected: PASS (테스트 7개)

- [ ] **Step 5: 커밋**

```bash
git add samba-agent/src/samba_agent/export/notify.py samba-agent/tests/test_export_notify.py
git commit -m "기능: 외부 기입 실패를 주문 스레드에 한 번만 알린다"
```

---

### Task 7: 설정 · 배선 · CLI

**Files:**
- Modify: `samba-agent/src/samba_agent/settings.py:76-78` (`site_scripts_file` 필드 뒤)
- Modify: `samba-agent/src/samba_agent/__main__.py` (import, `make_wave` 뒤 도우미, `build_supervisor` 호출, 알림 스레드)
- Create: `samba-agent/src/samba_agent/export/desktop/__init__.py`
- Create: `samba-agent/src/samba_agent/export/__main__.py`
- Test: `samba-agent/tests/test_export_wiring.py`

**Interfaces:**
- Consumes: `ExportQueue`, `ExportRouting`, `make_exporter`, `ExportFn`, `ExportNotifier`, `ExportWorker`, `Adapter`, `user_idle_seconds`
- Produces:
  - 설정: `export_enabled: bool`(기본 `False`, `SAMBA_EXPORT_ENABLED`), `export_db_path: Path`(기본 `root/exports.sqlite`, `SAMBA_EXPORT_DB_PATH`), `export_routing_file: Path`(기본 `root/export.yaml`, `SAMBA_EXPORT_ROUTING_FILE`), `export_wait_s: float`(기본 `60.0`, `SAMBA_EXPORT_WAIT_S`)
  - `samba_agent.__main__.make_export(settings: Settings) -> tuple[ExportQueue, ExportFn] | None`
  - `samba_agent.export.desktop.build_adapters() -> dict[str, Adapter]`
  - `samba_agent.export.__main__.main(argv: list[str] | None = None) -> int`
  - CLI: `python -m samba_agent.export worker` · `list [--limit N]` · `requeue ORDER_NO TARGET`

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_export_wiring.py`:

```python
# 외부 기입 배선 — 설정 기본값 · 하네스 연결 · CLI
from pathlib import Path

import pytest

from samba_agent.__main__ import make_export
from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.export.__main__ import main as export_main
from samba_agent.export.desktop import build_adapters
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue
from samba_agent.settings import DEFAULT_ROOT, Settings


def settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **env: str) -> Settings:
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'test-token')
    monkeypatch.setenv('SAMBA_EXPORT_DB_PATH', str(tmp_path / 'exports.sqlite'))
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings()  # type: ignore[call-arg]


def test_기본은_꺼져_있다(monkeypatch, tmp_path):
    s = settings(monkeypatch, tmp_path)
    assert s.export_enabled is False
    assert s.export_wait_s == 60.0
    assert s.export_routing_file == DEFAULT_ROOT / 'export.yaml'
    assert make_export(s) is None


def test_큐_파일_기본_위치는_하네스_폴더다(monkeypatch):
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'test-token')
    monkeypatch.delenv('SAMBA_EXPORT_DB_PATH', raising=False)
    assert Settings().export_db_path == DEFAULT_ROOT / 'exports.sqlite'  # type: ignore[call-arg]


def test_켜면_큐와_export_함수를_만든다(monkeypatch, tmp_path):
    s = settings(monkeypatch, tmp_path, SAMBA_EXPORT_ENABLED='true', SAMBA_EXPORT_WAIT_S='0')
    made = make_export(s)
    assert made is not None
    queue, exporter = made
    out = exporter(
        {
            'order': OrderRef(
                order_no='A1', source='무신사', seller='GS이숍(캐논)', sku='S1', qty=1
            ),
            'dry_run': False,
            'results': {
                'recorder': AgentResult(
                    status='ok',
                    reason='기록',
                    payload={'values': {'real_price': 62470, 'shipping_fee': 2300}},
                )
            },
        }
    )
    assert out.payload['export'] == 'pending'
    assert out.payload['target'] == 'emp'
    assert queue.find('A1', 'emp') is not None


def test_이_계획에서는_등록된_어댑터가_없다():
    assert build_adapters() == {}


def test_list_는_최근_요청을_보여_준다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    queue = ExportQueue(tmp_path / 'exports.sqlite')
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    assert export_main(['list']) == 0
    out = capsys.readouterr().out
    assert 'A1' in out
    assert 'emp' in out
    assert 'failed' in out
    assert 'not_found' in out


def test_list_는_비어_있으면_그렇게_말한다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    assert export_main(['list']) == 0
    assert '없다' in capsys.readouterr().out


def test_requeue_는_실패한_요청을_되살린다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    queue = ExportQueue(tmp_path / 'exports.sqlite')
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    assert export_main(['requeue', 'A1', 'emp']) == 0
    assert queue.get(req.id).status == 'pending'
    assert 'A1' in capsys.readouterr().out


def test_requeue_할_실패_요청이_없으면_1(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    assert export_main(['requeue', 'A9', 'emp']) == 1
    assert '없다' in capsys.readouterr().out
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_export_wiring.py -v`
Expected: FAIL — `ImportError: cannot import name 'make_export' from 'samba_agent.__main__'`

- [ ] **Step 3: 구현 — 설정**

`samba-agent/src/samba_agent/settings.py` 의 `site_scripts_file` 필드(76~78행) **바로 뒤**, `_split_users` 검증기 **앞**에 넣는다:

```python
    # 외부 프로그램(EMP·샵마인) 원가·배송비 기입. 기본 꺼짐 — 입력 작업자와 어댑터를 실기로 확인한 뒤 켠다
    export_enabled: bool = Field(default=False, alias='SAMBA_EXPORT_ENABLED')
    # 하네스와 입력 작업자가 함께 보는 큐 파일
    export_db_path: Path = Field(
        default=DEFAULT_ROOT / 'exports.sqlite', alias='SAMBA_EXPORT_DB_PATH'
    )
    # 판매처 → 대상 라우팅 목록
    export_routing_file: Path = Field(
        default=DEFAULT_ROOT / 'export.yaml', alias='SAMBA_EXPORT_ROUTING_FILE'
    )
    # export 단계가 기입 결과를 기다리는 시간(초). 지나면 주문은 완료로 끝내고 결과는 나중에 알린다
    export_wait_s: float = Field(default=60.0, ge=0, alias='SAMBA_EXPORT_WAIT_S')
```

- [ ] **Step 4: 구현 — 어댑터 등록 지점**

`samba-agent/src/samba_agent/export/desktop/__init__.py`:

```python
"""외부 프로그램 어댑터 등록 지점.

어댑터는 프로그램마다 실제 화면을 읽기 전용으로 탐색한 뒤 따로 만든다
(샵마인·EMP 어댑터 계획). 여기 등록된 대상만 입력 작업자가 큐에서 집는다 —
등록되지 않은 대상의 요청은 큐에 대기로 남는다.
"""

from samba_agent.export.adapters import Adapter


def build_adapters() -> dict[str, Adapter]:
    """이 PC 에서 쓸 어댑터(대상 이름 → 어댑터)."""
    return {}
```

- [ ] **Step 5: 구현 — CLI**

`samba-agent/src/samba_agent/export/__main__.py`:

```python
"""`python -m samba_agent.export` — 입력 작업자 실행과 큐 관리.

  worker                   입력 작업자를 띄운다(관리자 권한으로 실행해야 EMP 에 입력된다)
  list [--limit N]         최근 요청을 본다
  requeue ORDER_NO TARGET  실패한 요청을 같은 값으로 다시 대기시킨다
"""

import argparse
import logging
import signal
import threading

from samba_agent.export.desktop import build_adapters
from samba_agent.export.idle import user_idle_seconds
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker
from samba_agent.settings import load_settings

log = logging.getLogger(__name__)


def _list(queue: ExportQueue, limit: int) -> int:
    rows = queue.recent(limit)
    if not rows:
        print('외부 기입 요청이 없다')
        return 0
    for r in rows:
        tail = f' {r.fail_reason}: {r.detail}' if r.fail_reason else f' {r.detail or ""}'
        print(
            f'{r.updated_at} {r.order_no} {r.target} {r.status}'
            f' 원가 {r.cost:,} 배송비 {r.shipping_fee:,} 시도 {r.attempts}{tail}'
        )
    return 0


def _requeue(queue: ExportQueue, order_no: str, target: str) -> int:
    req = queue.requeue(order_no, target)
    if req is None:
        print(f'{order_no}({target}) 실패한 요청이 없다')
        return 1
    print(f'{req.order_no}({req.target}) 다시 대기 — 원가 {req.cost:,} 배송비 {req.shipping_fee:,}')
    return 0


def _worker(queue: ExportQueue) -> int:
    adapters = build_adapters()
    if not adapters:
        log.warning('등록된 어댑터가 없다 — 요청은 큐에 대기로 남는다')
    recovered = queue.recover_running(tuple(adapters))
    if recovered:
        log.info('도중에 끊긴 요청 %d건을 되돌렸다', recovered)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_a: stop.set())
    signal.signal(signal.SIGTERM, lambda *_a: stop.set())
    log.info('입력 작업자 시작 — 대상 %s', ', '.join(adapters) or '없음')
    ExportWorker(queue, adapters, user_idle_s=user_idle_seconds).run_forever(stop.is_set)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='python -m samba_agent.export')
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('worker', help='입력 작업자를 띄운다')
    p_list = sub.add_parser('list', help='최근 요청을 본다')
    p_list.add_argument('--limit', type=int, default=20)
    p_requeue = sub.add_parser('requeue', help='실패한 요청을 다시 대기시킨다')
    p_requeue.add_argument('order_no')
    p_requeue.add_argument('target', choices=['emp', 'shopmine'])
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s.%(msecs)03d %(levelname)s:%(name)s:%(message)s',
        datefmt='%H:%M:%S',
    )
    queue = ExportQueue(load_settings().export_db_path)
    if args.cmd == 'list':
        return _list(queue, args.limit)
    if args.cmd == 'requeue':
        return _requeue(queue, args.order_no, args.target)
    return _worker(queue)


if __name__ == '__main__':
    raise SystemExit(main())
```

- [ ] **Step 6: 구현 — 하네스 배선**

`samba-agent/src/samba_agent/__main__.py` 를 네 군데 고친다.

(1) import 묶음에 추가한다(`from samba_agent.bridge.client ...` 줄 뒤, 알파벳 순서):

```python
from samba_agent.export.notify import ExportNotifier
from samba_agent.export.routing import ExportRouting
from samba_agent.export.stage import ExportFn, make_exporter
from samba_agent.export.store import ExportQueue
```

(2) `make_wave` 함수 **바로 뒤**에 도우미를 넣는다:

```python
def make_export(settings: 'Settings') -> tuple[ExportQueue, ExportFn] | None:
    """외부 기입 큐와 export 단계 함수. 꺼져 있으면 None — 그래프에 export 노드가 붙지 않는다."""
    if not settings.export_enabled:
        return None
    queue = ExportQueue(settings.export_db_path)
    routing = ExportRouting.load(settings.export_routing_file)
    return queue, make_exporter(queue, routing, wait_s=settings.export_wait_s)
```

(3) `graph = build_supervisor(` 호출 **바로 앞**에 넣고, 호출에 `exporter` 인자를 더한다:

```python
    export = make_export(settings)
    if export is None:
        log.info('외부 기입(EMP·샵마인)은 꺼져 있다 — SAMBA_EXPORT_ENABLED')

    graph = build_supervisor(
        reg,
        agents,
        checkpointer=checkpointer,
        gate=True,
        on_stage_start=lambda state, stage: worker.mark_stage(state, stage),
        on_agent_result=_record_agent,
        exporter=export[1] if export is not None else None,
    )
```

(4) `if intake is not None:` 블록(자동 수집 스레드 시작) **바로 앞**에 넣는다:

```python
    if export is not None:
        # 실패한 외부 기입을 그 주문의 슬랙 스레드에 알린다(입력 작업자는 큐에 결과만 적는다)
        def _thread_of(order_no: str) -> str | None:
            job = queue.get(order_no)
            return job.thread_ts if job is not None else None

        notifier = ExportNotifier(export[0], _thread_of, lambda ts, text: bot.post(ts, text))
        threading.Thread(
            target=notifier.run_forever, args=(stop.is_set,), daemon=True, name='export-notify'
        ).start()
```

- [ ] **Step 7: 통과 확인**

Run: `uv run pytest tests/test_export_wiring.py -v`
Expected: PASS (테스트 8개)

- [ ] **Step 8: 전체 테스트**

Run: `uv run pytest -q`
Expected: 실패 0. 통과 개수는 이 계획을 시작하기 전보다 101개 많다
(Task 1~7 의 새 테스트: 19 + 20 + 20 + 8 + 19 + 7 + 8).

계획을 시작하기 전 개수는 첫 작업 전에 `uv run pytest -q` 로 적어 둔다.

- [ ] **Step 9: 린트·형식**

Run: `uv run ruff check src tests && uv run ruff format --check src/samba_agent/export tests/test_export_routing.py tests/test_export_store.py tests/test_export_stage.py tests/test_export_worker.py tests/test_export_notify.py tests/test_export_wiring.py tests/test_supervisor_export.py`
Expected: `All checks passed!` 와 형식 변경 대상 0개. 형식이 다르면 `uv run ruff format` 을 같은 파일들에 돌린 뒤 다시 확인한다.

- [ ] **Step 10: CLI 손으로 확인**

Run (`samba-agent/` 에서): `uv run python -m samba_agent.export list`
Expected: `외부 기입 요청이 없다`

- [ ] **Step 11: 커밋**

```bash
git add samba-agent/src/samba_agent/settings.py samba-agent/src/samba_agent/__main__.py samba-agent/src/samba_agent/export/desktop/__init__.py samba-agent/src/samba_agent/export/__main__.py samba-agent/tests/test_export_wiring.py
git commit -m "기능: 외부 기입 배선 — 설정(기본 꺼짐)·하네스 연결·작업자 CLI"
```

---

## 스펙 대조

| 스펙 | 다루는 곳 |
|---|---|
| §3 구조(큐·단계·라우팅·작업자·어댑터) | Task 1·2·3·5 |
| §4 `export` 단계 — 위치·입력·`dry_run`·승인 게이트 없음 | Task 3·4 |
| §4.1 라우팅 | Task 1 |
| §5 큐 — 열·유일성·값 다른 재요청 거절·개인정보 없음 | Task 2 |
| §6 어댑터 공통 인터페이스 | Task 5 (`Adapter`) |
| §6 어댑터 구현(행 찾기·입력·되읽기·열 위치) | 후속 계획(샵마인·EMP) |
| §7-1·2 검색 1건·입력 직전 주문번호 재확인 | 어댑터 규약(Task 5) → 후속 계획에서 구현 |
| §7-3 덮어쓰지 않음·같으면 입력 없음 | Task 5 |
| §7-4 되읽기 불일치는 재시도 없음 | Task 5 |
| §7-5 사람이 쓰는 중이면 대기 | Task 5 (`user_idle_s`) |
| §7-6 대화상자가 떠 있으면 중단 | 어댑터 규약 `AdapterRetry(BLOCKED)` → 후속 계획 |
| §7-7 한 번에 1건 | Task 5 |
| §8 실패 처리·슬랙 알림·작업자 꺼짐·제한 시간 | Task 3·5·6 |
| §9 단위 테스트 | Task 1~7 |
| §9 어댑터 읽기 전용 시험·실기 1건 | 후속 계획 |
| §10-4 작업 스케줄러 등록 | 후속 계획(EMP) |

스펙 §7-3 과 다른 점 하나: 스펙은 값 충돌을 `needs_human` 이라 적었지만, 이 계획은 큐의 `failed`
(`value_conflict`) + 슬랙 알림으로 처리한다. 주문을 `needs_human` 으로 바꾸면 이미 끝난 주문이
사람 대기로 남아 "외부 기입이 실패해도 주문은 완료" 와 부딪히기 때문이다.

## 이 계획이 끝났을 때

- `SAMBA_EXPORT_ENABLED` 가 꺼져 있으면 하네스는 지금과 똑같이 돈다.
- 켜면 검증이 끝난 주문마다 큐에 요청이 쌓인다. 어댑터가 없으므로 요청은 `pending` 으로 남는다.
- 어댑터를 등록하기 전에는 켜지 않는다.

## 다음 계획에 필요한 것

1. **샵마인 어댑터**: 샵마인 주문 목록 화면(원가·배송비 열이 보이는 상태)을 띄운 뒤 읽기 전용 탐색.
   지금은 `쇼핑몰 연결` → `SSG.COM 2단계 인증` 대화상자가 떠 있어 주문 화면을 볼 수 없다.
2. **EMP 어댑터**: 관리자 권한 셸에서 화면 값 읽기 방법 시험(행 복사 또는 글자 인식).
3. **판매처 문자열 확인**: 삼바웨이브 주문의 실제 `seller` 값이 `export.yaml` 표식과 맞는지 대조.
