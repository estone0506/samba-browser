# 샵마인 일괄 '완료됨' 어댑터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하네스가 주문을 처리한 직후 샵마인 통합주문관리에서 `미지정 · 엑셀생성안됨` 필터에 걸린 주문을 전부 작업상태 `완료됨`으로 바꾸는 어댑터를 입력 작업자에 붙인다.

**Architecture:** 코어(큐·`export` 노드·작업자)는 그대로 두고 두 겹을 더한다. (1) 작업자에 "배치형 어댑터" 분기 — 요청 하나를 집어 일괄 처리를 한 번 돌리고 그 시점의 같은 대상 대기 요청을 전부 성공으로 끝낸다. (2) 샵마인 어댑터는 순수 절차(`ShopMineAdapter`)와 화면 드라이버(`ShopMineUi` 규약, pywinauto 구현)로 나눠 절차는 가짜 드라이버로 시험하고 드라이버는 실기로 시험한다.

**Tech Stack:** Python 3.12, pywinauto(UIA backend, 새 선택 의존성 그룹 `desktop`), SQLite, pytest, ruff, uv

**스펙:** `docs/superpowers/specs/2026-09-28-external-export-design.md` §6.1 (샵마인 일괄 완료됨), §7, §8
**선행 계획:** `docs/superpowers/plans/2026-09-28-external-export-core.md` (병합됨 — `samba_agent/export/*`)

## Global Constraints

- 샵마인은 값 기입이 없다. 절차는 스펙 §6.1 의 1~7 그대로: `(정상전체)` + `수집하기(F5)` → 수집 완료 대기 → 필터(작업상태 `미지정`, 엑셀생성여부 `엑셀생성안됨`) → 행 수 읽기(0 이면 할 일 없음) → 전체 선택 → `작업상태지정` → `완료됨` → 같은 필터로 행 수 0 확인.
- 필터에 걸린 주문 **전부** 처리한다(하네스가 처리한 주문인지 보지 않는다 — 사용자 2026-09-28).
- 실행 시점은 하네스 주문 처리 직후(= 큐에 샵마인 요청이 들어올 때). 일괄 처리 한 번이 그 시점의 샵마인 대기 요청 전부를 덮는다.
- 되읽기(재필터 행 수 0) 가 어긋나면 `verify_mismatch` 실패, 재시도 없음.
- 창이 없거나 최소화·수집 시간 초과·낯선 대화상자 → `AdapterRetry`(WINDOW_MISSING · TIMEOUT · BLOCKED). 우리가 누른 `완료됨` 의 확인 대화상자만 예외적으로 누른다(§6.1 절차의 일부).
- 사람이 PC 를 쓰는 중(입력 20초 이내)이면 작업자가 집지 않는다(코어 규칙 그대로).
- 큐 `detail` 에 화면 글자(고객명 등)를 넣지 않는다 — 건수·상태만.
- 콤보 상자는 automation id 가 숫자(불안정)라 **항목 목록**으로 찾는다. 좌표는 쓰지 않는다.
- 기본 꺼짐: 어댑터는 `SAMBA_EXPORT_TARGETS` 에 `shopmine` 이 있을 때만 등록한다(기본 빈 문자열).
- 코드 주석·문서·커밋 메시지 한국어, 식별자 영어, 작은따옴표, 줄 길이 100, 4칸 들여쓰기(ruff format). 테스트는 `samba-agent/` 에서 `uv run pytest`.
- 작업은 worktree `C:\Users\canno\workspace\samba_browser-shopmine`(브랜치 `feature/shopmine-batch`)에서 한다. 메인 트리는 건드리지 않는다.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `samba-agent/src/samba_agent/export/adapters.py` (수정) | `BatchAdapter` 규약 추가 |
| `samba-agent/src/samba_agent/export/store.py` (수정) | `done_pending(target, detail, *, except_id)` |
| `samba-agent/src/samba_agent/export/worker.py` (수정) | 배치형 어댑터 분기 |
| `samba-agent/src/samba_agent/export/desktop/shopmine.py` (새로) | `ShopMineUi` 규약 + `ShopMineAdapter` 절차 |
| `samba-agent/src/samba_agent/export/desktop/shopmine_ui.py` (새로) | pywinauto 드라이버 `PywinautoShopMineUi` |
| `samba-agent/src/samba_agent/export/desktop/__init__.py` (수정) | `build_adapters(targets)` |
| `samba-agent/src/samba_agent/export/__main__.py` (수정) | `shopmine [--dry]` 명령, 대상 설정 |
| `samba-agent/src/samba_agent/settings.py` (수정) | `export_targets` |
| `samba-agent/pyproject.toml` (수정) | 선택 의존성 `desktop = ["pywinauto>=0.6.8"]` |
| 테스트 | `tests/test_export_worker.py`(추가), `tests/test_export_store.py`(추가), `tests/test_shopmine_adapter.py`(새로), `tests/test_export_wiring.py`(추가) |

---

### Task 1: 배치형 어댑터 규약 · 큐 `done_pending` · 작업자 분기

**Files:**
- Modify: `samba-agent/src/samba_agent/export/adapters.py`
- Modify: `samba-agent/src/samba_agent/export/store.py`
- Modify: `samba-agent/src/samba_agent/export/worker.py`
- Test: `samba-agent/tests/test_export_store.py`, `samba-agent/tests/test_export_worker.py`

**Interfaces:**
- Consumes: 기존 `ExportQueue`, `ExportWorker`, `AdapterRetry`/`AdapterReject`, `ExportFail`
- Produces:
  - `@runtime_checkable class BatchAdapter(Protocol)` — `complete_pending() -> int` (처리 건수)
  - `ExportQueue.done_pending(target: str, detail: str, *, except_id: int) -> int` — 그 대상의 `pending` 행을 전부 `done` 으로(제외 id 는 건드리지 않음). 돌려주는 값은 바꾼 행 수
  - 작업자: 어댑터가 `BatchAdapter` 이면 `read/write` 대신 `complete_pending()` 을 부르고, 성공 시 `done_pending` 으로 나머지도 끝낸다

- [ ] **Step 1: 실패하는 테스트 작성 — 큐**

`samba-agent/tests/test_export_store.py` 끝에 추가:

```python
def test_done_pending_은_그_대상의_대기_요청만_전부_끝낸다(queue):
    a = queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    c = queue.enqueue('A3', 'shopmine', 3000, 0)
    d = queue.enqueue('A4', 'emp', 4000, 0)
    claimed = queue.claim_next(['shopmine'])  # a 가 running
    assert claimed is not None and claimed.id == a.id
    n = queue.done_pending('shopmine', '일괄 완료됨 2건', except_id=a.id)
    assert n == 2
    assert queue.get(a.id).status == 'running'  # 집은 행은 호출부가 따로 끝낸다
    assert queue.get(b.id).status == 'done'
    assert queue.get(b.id).detail == '일괄 완료됨 2건'
    assert queue.get(c.id).status == 'done'
    assert queue.get(d.id).status == 'pending'


def test_done_pending_은_대기가_없으면_0(queue):
    req = queue.enqueue('A1', 'shopmine', 1000, 0)
    queue.claim_next(['shopmine'])
    assert queue.done_pending('shopmine', '일괄', except_id=req.id) == 0
```

- [ ] **Step 2: 실패하는 테스트 작성 — 작업자**

`samba-agent/tests/test_export_worker.py` 끝에 추가:

```python
class FakeBatch:
    """배치형 어댑터 가짜 — 부를 때마다 정해진 건수를 돌려주거나 예외를 낸다."""

    def __init__(self, count: int = 3) -> None:
        self.count = count
        self.calls = 0
        self.error: Exception | None = None

    def complete_pending(self) -> int:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.count


def batch_worker(queue, adapter, idle: float = 999.0, **kw) -> ExportWorker:
    return ExportWorker(queue, {'shopmine': adapter}, user_idle_s=lambda: idle, **kw)


def test_배치_어댑터는_한_번_돌리고_대기_요청을_전부_끝낸다(queue):
    adapter = FakeBatch(count=5)
    a = queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    c = queue.enqueue('A3', 'shopmine', 3000, 0)
    out = batch_worker(queue, adapter).run_once()
    assert out is not None and out.id == a.id
    assert out.status == 'done'
    assert out.detail == '일괄 완료됨 5건(대기 요청 3건 함께 종료)'
    assert queue.get(b.id).status == 'done'
    assert queue.get(c.id).status == 'done'
    assert adapter.calls == 1
    assert batch_worker(queue, adapter).run_once() is None


def test_배치_처리_건수_0_도_성공이다(queue):
    adapter = FakeBatch(count=0)
    queue.enqueue('A1', 'shopmine', 1000, 0)
    out = batch_worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert out.detail == '일괄 완료됨 0건(대기 요청 1건 함께 종료)'


def test_배치_어댑터의_재시도_사유는_대기_요청을_건드리지_않는다(queue):
    adapter = FakeBatch()
    adapter.error = AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창 없음')
    a = queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    out = batch_worker(queue, adapter, retry_delay_s=0).run_once()
    assert out.status == 'pending'
    assert out.fail_reason == 'window_missing'
    assert queue.get(b.id).status == 'pending'
    assert queue.get(b.id).attempts == 0


def test_배치_어댑터의_거절은_집은_요청만_실패시킨다(queue):
    adapter = FakeBatch()
    adapter.error = AdapterReject(ExportFail.VERIFY_MISMATCH, '재필터 뒤에도 2건 남음')
    a = queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    out = batch_worker(queue, adapter).run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'verify_mismatch'
    assert queue.get(b.id).status == 'pending'  # 다음 요청이 다시 일괄 처리를 돌린다


def test_배치_어댑터와_셀_어댑터가_함께_등록돼도_대상별로_고른다(queue):
    cell = FakeAdapter({'E1': EMPTY})
    batch = FakeBatch(count=1)
    queue.enqueue('E1', 'emp', 62470, 2300)
    queue.enqueue('S1', 'shopmine', 1000, 0)
    w = ExportWorker(queue, {'emp': cell, 'shopmine': batch}, user_idle_s=lambda: 999.0)
    first = w.run_once()
    second = w.run_once()
    assert {first.target, second.target} == {'emp', 'shopmine'}
    assert cell.rows['E1'] == CellValues(62470, 2300)
    assert batch.calls == 1
```

- [ ] **Step 3: 실패 확인**

Run: `uv run pytest tests/test_export_store.py tests/test_export_worker.py -q`
Expected: FAIL — `AttributeError: 'ExportQueue' object has no attribute 'done_pending'` 와 배치 테스트들의 `AttributeError: 'FakeBatch' object has no attribute 'read'`

- [ ] **Step 4: 구현 — 규약**

`samba-agent/src/samba_agent/export/adapters.py` 끝에 추가(`Protocol` 옆에 `runtime_checkable` 도 import):

```python
@runtime_checkable
class BatchAdapter(Protocol):
    """일괄형 외부 프로그램 — 주문별 값 기입이 아니라 화면의 대상 전부를 한 번에 처리한다(샵마인).

    작업자는 요청 하나를 집어 이 함수를 한 번 부르고, 그때 대기 중이던 같은 대상 요청을
    전부 성공으로 끝낸다. 되풀이해 불러도 안전해야 한다(할 일이 없으면 0 을 돌려준다).
    """

    def complete_pending(self) -> int:
        """처리한 건수. 창 없음·시간 초과·대화상자는 AdapterRetry, 되읽기 불일치는 AdapterReject."""
        ...
```

- [ ] **Step 5: 구현 — 큐**

`samba-agent/src/samba_agent/export/store.py` 의 `done` 메서드 **바로 뒤**에 추가:

```python
    def done_pending(self, target: str, detail: str, *, except_id: int) -> int:
        """그 대상의 대기(pending) 요청을 전부 성공으로 끝낸다 — 일괄형 어댑터가 한 번에 덮은 것들.

        except_id(집어서 running 인 행)는 호출부가 따로 끝낸다. 바꾼 행 수를 돌려준다.
        """
        now = self._iso()
        with self._immediate():
            cur = self._db.execute(
                "UPDATE export_requests SET status='done', fail_reason=NULL, detail=?, "
                "updated_at=? WHERE target=? AND status='pending' AND id<>?",
                (detail, now, target, except_id),
            )
        return int(cur.rowcount)
```

- [ ] **Step 6: 구현 — 작업자 분기**

`samba-agent/src/samba_agent/export/worker.py`:

(1) import 에 `BatchAdapter` 를 더한다:

```python
from samba_agent.export.adapters import (
    Adapter,
    AdapterReject,
    AdapterRetry,
    BatchAdapter,
    CellValues,
)
```

(2) `_process` 를 아래로 바꾼다(배치형이면 `_decide_batch`, 성공 뒤 나머지 대기 요청도 끝낸다):

```python
    def _process(self, req: ExportRequest, adapter: Adapter | BatchAdapter) -> None:
        batch = isinstance(adapter, BatchAdapter)
        outcome = self._decide_batch(req, adapter) if batch else self._decide(req, adapter)
        # 큐 기록은 어댑터 try 바깥에서 한 번만 한다 — 기입은 성공했는데 그 뒤 큐 쓰기가
        # 실패하면(예: sqlite 오류) 리뷰 지적 M2 이전에는 UNKNOWN 실패로 잘못 남았다.
        # 여기서 나는 예외는 run_once 밖으로 그대로 나가고, running 인 행은 재시작 때
        # recover_running 이 되돌린다(같은 값이면 다시 입력하지 않으니 안전하다).
        if outcome.kind == 'done':
            detail = outcome.detail
            if batch:
                # 일괄 처리 한 번이 그때 대기 중이던 같은 대상 요청을 전부 덮었다
                others = self._queue.done_pending(req.target, detail, except_id=req.id)
                detail = f'{detail}(대기 요청 {others + 1}건 함께 종료)'
            self._queue.done(req.id, detail)
        elif outcome.kind == 'retry':
            assert outcome.reason is not None
            self._queue.retry_later(req.id, outcome.reason, outcome.detail, self._retry_delay_s)
        else:
            assert outcome.reason is not None
            self._queue.fail(req.id, outcome.reason, outcome.detail)
```

(3) `_decide` **바로 뒤**에 추가:

```python
    def _decide_batch(self, req: ExportRequest, adapter: BatchAdapter) -> _Outcome:
        """일괄형 어댑터 — 한 번 돌리고 건수만 받는다. 실패 분류는 _decide 와 같다."""
        try:
            count = adapter.complete_pending()
            return _Outcome('done', f'일괄 완료됨 {count}건')
        except AdapterRetry as e:
            if req.attempts >= self._max_attempts:
                return _Outcome('fail', f'재시도 {req.attempts}회 모두 실패 — {e.detail}', e.reason)
            return _Outcome('retry', e.detail, e.reason)
        except AdapterReject as e:
            return _Outcome('fail', e.detail, e.reason)
        except Exception as e:
            log.exception('외부 일괄 처리 중 오류: %s(%s)', req.order_no, req.target)
            return _Outcome('fail', f'{type(e).__name__}: {e}'[:200], ExportFail.UNKNOWN)
```

`ExportWorker.__init__` 의 `adapters: Mapping[str, Adapter]` 는 `Mapping[str, Adapter | BatchAdapter]` 로 바꾼다.

- [ ] **Step 7: 통과 확인**

Run: `uv run pytest tests/test_export_store.py tests/test_export_worker.py -q`
Expected: PASS (기존 + 새 테스트 7개)

- [ ] **Step 8: 린트·전체 테스트·커밋**

Run: `uv run ruff format --check src/samba_agent/export tests/test_export_store.py tests/test_export_worker.py && uv run ruff check src/samba_agent/export tests/test_export_store.py tests/test_export_worker.py && uv run pytest -q`
Expected: 형식·린트 깨끗, 전체 통과(기존 881 + 7)

```bash
git add samba-agent/src/samba_agent/export/adapters.py samba-agent/src/samba_agent/export/store.py samba-agent/src/samba_agent/export/worker.py samba-agent/tests/test_export_store.py samba-agent/tests/test_export_worker.py
git commit -m "기능: 일괄형 어댑터 — 한 번 돌리고 같은 대상 대기 요청을 전부 끝낸다"
```

---

### Task 2: 샵마인 어댑터 절차(순수 로직) + 화면 드라이버 규약

**Files:**
- Create: `samba-agent/src/samba_agent/export/desktop/shopmine.py`
- Test: `samba-agent/tests/test_shopmine_adapter.py`

**Interfaces:**
- Consumes: `AdapterRetry`, `AdapterReject`, `ExportFail`
- Produces:
  - `class ShopMineUi(Protocol)`:
    - `ensure_ready() -> None` — 창·통합주문관리 탭·대화상자 없음을 보장(못 하면 `AdapterRetry`)
    - `collect() -> None` — `(정상전체)` 로 두고 `수집하기(F5)`
    - `wait_collected(timeout_s: float) -> None` — 수집 완료까지 대기(초과 시 `AdapterRetry(TIMEOUT)`)
    - `set_filters() -> None` — 작업상태 `미지정`, 엑셀생성여부 `엑셀생성안됨`
    - `row_count() -> int`
    - `select_all() -> int` — 전체 선택 뒤 선택된 행 수
    - `set_status_done() -> None` — `작업상태지정` → `완료됨`(확인 대화상자 포함)
  - `class ShopMineAdapter` — `__init__(ui: ShopMineUi, *, collect_timeout_s: float = 120.0, dry_run: bool = False)`, `complete_pending() -> int`
  - `dry_run=True` 면 전체 선택까지만 하고 `완료됨` 은 누르지 않는다(실기 시험용). 돌려주는 값은 필터 행 수.

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_shopmine_adapter.py`:

```python
# 샵마인 일괄 '완료됨' 절차 — 화면 드라이버는 가짜, 순서·되읽기·실패 분류를 본다
import pytest

from samba_agent.export.adapters import AdapterReject, AdapterRetry
from samba_agent.export.desktop.shopmine import ShopMineAdapter
from samba_agent.export.failures import ExportFail


class FakeUi:
    """샵마인 화면 가짜. rows 는 필터에 걸린 행 수, done 을 누르면 0 이 된다."""

    def __init__(self, rows: int = 3) -> None:
        self.rows = rows
        self.calls: list[str] = []
        self.ready_error: Exception | None = None
        self.wait_error: Exception | None = None
        # 완료됨을 눌러도 남는 행 수(되읽기 불일치 시험용)
        self.leftover = 0

    def ensure_ready(self) -> None:
        self.calls.append('ready')
        if self.ready_error is not None:
            raise self.ready_error

    def collect(self) -> None:
        self.calls.append('collect')

    def wait_collected(self, timeout_s: float) -> None:
        self.calls.append(f'wait {timeout_s:g}')
        if self.wait_error is not None:
            raise self.wait_error

    def set_filters(self) -> None:
        self.calls.append('filters')

    def row_count(self) -> int:
        self.calls.append('count')
        return self.rows

    def select_all(self) -> int:
        self.calls.append('select_all')
        return self.rows

    def set_status_done(self) -> None:
        self.calls.append('done')
        self.rows = self.leftover


def test_필터_결과를_전부_완료됨으로_바꾸고_되읽어_0을_확인한다():
    ui = FakeUi(rows=3)
    n = ShopMineAdapter(ui, collect_timeout_s=90).complete_pending()
    assert n == 3
    assert ui.calls == [
        'ready', 'collect', 'wait 90', 'filters', 'count',
        'select_all', 'done', 'filters', 'count',
    ]


def test_필터_결과가_0이면_아무것도_누르지_않는다():
    ui = FakeUi(rows=0)
    assert ShopMineAdapter(ui).complete_pending() == 0
    assert 'select_all' not in ui.calls
    assert 'done' not in ui.calls


def test_dry_run_은_전체_선택까지만_한다():
    ui = FakeUi(rows=4)
    assert ShopMineAdapter(ui, dry_run=True).complete_pending() == 4
    assert ui.calls[-1] == 'select_all'
    assert 'done' not in ui.calls
    assert ui.rows == 4


def test_전체_선택_수가_행_수와_다르면_누르지_않고_거절한다():
    class Partial(FakeUi):
        def select_all(self) -> int:
            self.calls.append('select_all')
            return self.rows - 1

    ui = Partial(rows=3)
    with pytest.raises(AdapterReject) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.AMBIGUOUS
    assert 'done' not in ui.calls


def test_완료됨_뒤에도_행이_남으면_verify_mismatch():
    ui = FakeUi(rows=3)
    ui.leftover = 2
    with pytest.raises(AdapterReject) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.VERIFY_MISMATCH
    assert '2' in e.value.detail


def test_창이_없으면_AdapterRetry_가_그대로_나간다():
    ui = FakeUi()
    ui.ready_error = AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창 없음')
    with pytest.raises(AdapterRetry) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.WINDOW_MISSING
    assert ui.calls == ['ready']


def test_수집_시간_초과는_AdapterRetry_timeout():
    ui = FakeUi()
    ui.wait_error = AdapterRetry(ExportFail.TIMEOUT, '수집 120초 초과')
    with pytest.raises(AdapterRetry) as e:
        ShopMineAdapter(ui).complete_pending()
    assert e.value.reason is ExportFail.TIMEOUT
    assert 'filters' not in ui.calls
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_shopmine_adapter.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'samba_agent.export.desktop.shopmine'`

- [ ] **Step 3: 구현**

`samba-agent/src/samba_agent/export/desktop/shopmine.py`:

```python
"""샵마인 어댑터 — 통합주문관리의 '미지정 · 엑셀생성안됨' 주문을 전부 작업상태 '완료됨'으로(스펙 §6.1).

절차만 있다. 화면을 실제로 만지는 일은 ShopMineUi 드라이버(shopmine_ui.py, pywinauto)가 한다 —
그래서 절차는 가짜 드라이버로 시험하고, 드라이버는 실기로 시험한다.
"""

from typing import Protocol

from samba_agent.export.adapters import AdapterReject
from samba_agent.export.failures import ExportFail


class ShopMineUi(Protocol):
    """샵마인 통합주문관리 화면 조작. 못 하는 상황은 AdapterRetry 로 던진다."""

    def ensure_ready(self) -> None:
        """창이 있고 통합주문관리 탭이 앞에 있으며 낯선 대화상자가 없다."""
        ...

    def collect(self) -> None:
        """상태 콤보를 (정상전체) 로 두고 수집하기(F5)."""
        ...

    def wait_collected(self, timeout_s: float) -> None:
        """수집이 끝날 때까지 기다린다. 넘기면 AdapterRetry(TIMEOUT)."""
        ...

    def set_filters(self) -> None:
        """작업상태 = 미지정, 엑셀생성여부 = 엑셀생성안됨."""
        ...

    def row_count(self) -> int:
        """지금 필터에 걸린 행 수."""
        ...

    def select_all(self) -> int:
        """헤더 전체 선택을 켜고, 선택된 행 수를 돌려준다."""
        ...

    def set_status_done(self) -> None:
        """작업상태지정 → 완료됨(우리 조작이 띄운 확인 대화상자는 누른다)."""
        ...


class ShopMineAdapter:
    """BatchAdapter 구현. complete_pending 한 번이 필터에 걸린 주문 전부를 처리한다."""

    def __init__(
        self, ui: ShopMineUi, *, collect_timeout_s: float = 120.0, dry_run: bool = False
    ) -> None:
        self._ui = ui
        self._collect_timeout_s = collect_timeout_s
        # 실기 시험용 — 전체 선택까지만 하고 완료됨은 누르지 않는다
        self._dry_run = dry_run

    def complete_pending(self) -> int:
        ui = self._ui
        ui.ensure_ready()
        ui.collect()
        ui.wait_collected(self._collect_timeout_s)
        ui.set_filters()
        rows = ui.row_count()
        if rows == 0:
            return 0
        selected = ui.select_all()
        if selected != rows:
            # 일부만 선택된 채 완료됨을 누르면 어느 행이 바뀌었는지 알 수 없다 — 누르지 않는다
            raise AdapterReject(
                ExportFail.AMBIGUOUS, f'전체 선택 {selected}건 ≠ 필터 행 {rows}건 — 누르지 않았다'
            )
        if self._dry_run:
            return rows
        ui.set_status_done()
        # 되읽기 — 같은 필터에 아무것도 남지 않아야 한다
        ui.set_filters()
        left = ui.row_count()
        if left != 0:
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH, f'완료됨 지정 뒤에도 필터에 {left}건 남음(처리 대상 {rows}건)'
            )
        return rows
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_shopmine_adapter.py -q`
Expected: PASS (7개)

- [ ] **Step 5: 린트·커밋**

Run: `uv run ruff format --check src/samba_agent/export/desktop tests/test_shopmine_adapter.py && uv run ruff check src/samba_agent/export/desktop tests/test_shopmine_adapter.py`

```bash
git add samba-agent/src/samba_agent/export/desktop/shopmine.py samba-agent/tests/test_shopmine_adapter.py
git commit -m "기능: 샵마인 어댑터 절차 — 수집·필터·전체 선택·완료됨·되읽기(드라이버는 규약만)"
```

---

### Task 3: pywinauto 드라이버 · `shopmine` CLI · 실기 시험

**Files:**
- Modify: `samba-agent/pyproject.toml` (`[project.optional-dependencies]` 에 `desktop = ["pywinauto>=0.6.8"]`)
- Create: `samba-agent/src/samba_agent/export/desktop/shopmine_ui.py`
- Modify: `samba-agent/src/samba_agent/export/__main__.py` (`shopmine [--dry]` 명령)
- Test: `samba-agent/tests/test_export_wiring.py` (CLI 인자 파싱만)

**Interfaces:**
- Consumes: `ShopMineUi` 규약, `ShopMineAdapter`, `AdapterRetry`, `ExportFail`
- Produces:
  - `class PywinautoShopMineUi` — `ShopMineUi` 구현. `__init__(*, poll_s: float = 0.5)`
  - CLI `python -m samba_agent.export shopmine [--dry]` — 어댑터를 큐 없이 한 번 돌리고 건수를 출력(종료 코드 0), `AdapterRetry`/`AdapterReject` 는 사유를 출력하고 2

화면 사실(2026-09-28 읽기 전용 탐색, `samba_browser` 스크래치 `probe_shopmine.txt`):
- 창 제목 `ShopMine::쇼핑몰 통합관리 솔루션[…]`(WinForms, 일반 권한). 같은 프로세스에 `CS메모관리` 등 다른 창도 뜰 수 있다 — 통합주문관리 탭이 있는 창을 고른다.
- 탭 `TabItem` 이름 `통합주문관리`.
- 상단: `ComboBox auto_id=ComboBoxProcessStatus`(항목 `(정상/클레임 전체)`, `(정상전체)`, `(클레임전체)`), `Button auto_id=ButtonSearch` 이름 `수집하기(F5)`.
- 수집 전 안내: `Pane auto_id=PanelLoading` 이름 `[수집하기(F5)]을 클릭해 데이터를 수집 하십시오.` — 수집이 끝나면 사라진다(또는 보이지 않는다).
- 주문필터 툴바 `ToolBar auto_id=ToolStripOrderFilter` 안 콤보 8개, id 는 숫자(불안정). 항목 목록으로 구분: 작업상태 = `(작업상태전체)/미지정/진행중/완료됨/…`, 엑셀생성여부 = `(엑셀생성여부)/엑셀생성안됨/엑셀생성됨`.
- 그리드 `Table auto_id=DataGridView1`, 헤더 전체 선택 `CheckBox auto_id=CheckBoxAll`.
- 하단 툴바 `ToolBar auto_id=ToolStripSub` 에 `MenuItem 작업상태지정` → 하위 `MenuItem 미지정/진행중/완료됨/대기중/지연됨`.

- [ ] **Step 1: 의존성 그룹 추가**

`samba-agent/pyproject.toml` 의 `[project.optional-dependencies]`:

```toml
[project.optional-dependencies]
dev = ["pytest>=8.3", "pytest-asyncio>=0.24", "respx>=0.21", "ruff>=0.7"]
# 입력 작업자(샵마인·EMP 화면 조작) — 하네스 본체에는 필요 없다
desktop = ["pywinauto>=0.6.8"]
```

Run: `uv sync --all-extras --group dev && uv run python -c "import pywinauto; print(pywinauto.__version__)"`
Expected: 버전이 찍힌다. `uv.lock` 이 갱신된다(커밋에 포함).

- [ ] **Step 2: CLI 파싱 테스트 작성(실패 확인)**

`samba-agent/tests/test_export_wiring.py` 끝에 추가:

```python
def test_shopmine_명령은_드라이버를_만들어_한_번_돌린다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    import samba_agent.export.__main__ as cli

    made: dict[str, object] = {}

    class FakeAdapter:
        def __init__(self, ui, *, dry_run=False, **_kw):
            made['dry_run'] = dry_run

        def complete_pending(self):
            return 4

    monkeypatch.setattr(cli, 'PywinautoShopMineUi', lambda: object())
    monkeypatch.setattr(cli, 'ShopMineAdapter', FakeAdapter)
    assert export_main(['shopmine', '--dry']) == 0
    assert made['dry_run'] is True
    assert '4' in capsys.readouterr().out


def test_shopmine_명령은_재시도_사유를_출력하고_2를_돌려준다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    import samba_agent.export.__main__ as cli
    from samba_agent.export.adapters import AdapterRetry

    class Failing:
        def __init__(self, ui, **_kw):
            pass

        def complete_pending(self):
            raise AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창 없음')

    monkeypatch.setattr(cli, 'PywinautoShopMineUi', lambda: object())
    monkeypatch.setattr(cli, 'ShopMineAdapter', Failing)
    assert export_main(['shopmine']) == 2
    assert 'window_missing' in capsys.readouterr().out
```

Run: `uv run pytest tests/test_export_wiring.py -q`
Expected: FAIL — `AttributeError: module 'samba_agent.export.__main__' has no attribute 'PywinautoShopMineUi'`

- [ ] **Step 3: 구현 — 드라이버**

`samba-agent/src/samba_agent/export/desktop/shopmine_ui.py`:

```python
"""샵마인 화면 드라이버 — pywinauto(UIA). ShopMineUi 규약을 실제 창에 대고 수행한다.

컨트롤은 automation id·이름·항목 목록으로 찾는다. 좌표는 쓰지 않는다.
못 하는 상황(창 없음·최소화·수집 시간 초과·낯선 대화상자)은 AdapterRetry 로 던진다.
"""

import logging
import time

from pywinauto import Desktop
from pywinauto.findwindows import ElementNotFoundError
from pywinauto.timings import TimeoutError as PwTimeoutError

from samba_agent.export.adapters import AdapterRetry
from samba_agent.export.failures import ExportFail

log = logging.getLogger(__name__)

WINDOW_TITLE_MARK = 'ShopMine::'
ORDER_TAB = '통합주문관리'
NORMAL_ALL = '(정상전체)'
FILTER_STATUS = '미지정'
FILTER_EXCEL = '엑셀생성안됨'
STATUS_MENU = '작업상태지정'
STATUS_DONE = '완료됨'
# 우리가 완료됨을 누른 뒤 뜨는 확인 대화상자에서 눌러도 되는 버튼 이름
CONFIRM_BUTTONS = ('예(Y)', '확인', 'OK', 'Yes')


class PywinautoShopMineUi:
    """ShopMineUi 구현."""

    def __init__(self, *, poll_s: float = 0.5) -> None:
        self._poll_s = poll_s
        self._win = None

    # ---- 창·탭 ----
    def _window(self):
        """통합주문관리 탭이 있는 ShopMine 창. 없으면 AdapterRetry(WINDOW_MISSING)."""
        for w in Desktop(backend='uia').windows():
            title = w.window_text() or ''
            if not title.startswith(WINDOW_TITLE_MARK):
                continue
            if w.descendants(control_type='TabItem', title=ORDER_TAB):
                return w
        raise AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 통합주문관리 창이 없다')

    def ensure_ready(self) -> None:
        win = self._window()
        if win.is_minimized():
            win.restore()
            time.sleep(self._poll_s)
        self._refuse_if_dialog(win)
        tab = win.child_window(control_type='TabItem', title=ORDER_TAB)
        try:
            tab.select()
        except Exception:  # noqa: BLE001 — 일부 탭은 select 패턴이 없어 클릭으로 고른다
            tab.click_input()
        self._win = win

    def _refuse_if_dialog(self, win) -> None:
        """같은 프로세스의 다른 최상위 창(인증·오류 대화상자)이 있으면 건드리지 않고 물러난다."""
        pid = win.process_id()
        for w in Desktop(backend='uia').windows():
            if w.process_id() != pid or w.handle == win.handle:
                continue
            title = w.window_text() or ''
            # 다른 업무 창(CS메모관리 등)은 대화상자가 아니다 — 확인·취소 버튼만 있는 작은 창을 본다
            if w.rectangle().width() > 900:
                continue
            raise AdapterRetry(ExportFail.BLOCKED, f'샵마인에 대화상자가 떠 있다: {title[:40]!r}')

    # ---- 수집 ----
    def collect(self) -> None:
        win = self._win
        win.child_window(auto_id='ComboBoxProcessStatus', control_type='ComboBox').select(
            NORMAL_ALL
        )
        win.child_window(auto_id='ButtonSearch', control_type='Button').click_input()

    def wait_collected(self, timeout_s: float) -> None:
        """수집 안내 패널이 사라지고 수집 버튼이 다시 눌리게 될 때까지 기다린다."""
        win = self._win
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            loading = win.child_window(auto_id='PanelLoading', control_type='Pane')
            button = win.child_window(auto_id='ButtonSearch', control_type='Button')
            try:
                busy = loading.exists(timeout=0.1) and loading.is_visible()
                if not busy and button.is_enabled():
                    return
            except ElementNotFoundError:
                pass
            time.sleep(self._poll_s)
        raise AdapterRetry(ExportFail.TIMEOUT, f'수집이 {timeout_s:g}초 안에 끝나지 않았다')

    # ---- 필터 ----
    def _filter_combo(self, item: str):
        """주문필터 툴바에서 그 항목을 가진 콤보 상자(id 가 숫자라 항목 목록으로 찾는다)."""
        toolbar = self._win.child_window(auto_id='ToolStripOrderFilter', control_type='ToolBar')
        for combo in toolbar.children(control_type='ComboBox'):
            try:
                if item in combo.texts():
                    return combo
            except Exception:  # noqa: BLE001 — 열리지 않은 콤보는 목록을 못 줄 수 있다
                continue
        raise AdapterRetry(ExportFail.BLOCKED, f'주문필터에 {item!r} 항목을 가진 콤보 상자가 없다')

    def set_filters(self) -> None:
        self._filter_combo(FILTER_STATUS).select(FILTER_STATUS)
        self._filter_combo(FILTER_EXCEL).select(FILTER_EXCEL)
        time.sleep(self._poll_s)

    # ---- 그리드 ----
    def _grid(self):
        return self._win.child_window(auto_id='DataGridView1', control_type='Table')

    def row_count(self) -> int:
        grid = self._grid()
        try:
            return int(grid.iface_grid.CurrentRowCount)
        except Exception:  # noqa: BLE001 — GridPattern 이 없으면 행 요소를 센다
            rows = [
                c for c in grid.children() if c.element_info.control_type in ('DataItem', 'Custom')
            ]
            return len(rows)

    def select_all(self) -> int:
        box = self._win.child_window(auto_id='CheckBoxAll', control_type='CheckBox')
        if box.get_toggle_state() != 1:
            box.toggle()
            time.sleep(self._poll_s)
        if box.get_toggle_state() != 1:
            return 0
        return self.row_count()

    # ---- 완료됨 ----
    def set_status_done(self) -> None:
        win = self._win
        toolbar = win.child_window(auto_id='ToolStripSub', control_type='ToolBar')
        toolbar.child_window(control_type='MenuItem', title=STATUS_MENU).click_input()
        time.sleep(self._poll_s)
        # 펼쳐진 메뉴는 창 밖 팝업일 수 있다 — 바탕화면 전체에서 찾는다
        Desktop(backend='uia').window(control_type='MenuItem', title=STATUS_DONE).click_input()
        self._confirm_own_dialog(win)

    def _confirm_own_dialog(self, win, wait_s: float = 5.0) -> None:
        """우리가 방금 띄운 확인 대화상자만 누른다. 없으면 그냥 지나간다."""
        pid = win.process_id()
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            for w in Desktop(backend='uia').windows():
                if w.process_id() != pid or w.handle == win.handle or w.rectangle().width() > 900:
                    continue
                for name in CONFIRM_BUTTONS:
                    try:
                        w.child_window(control_type='Button', title=name).click_input()
                        log.info('샵마인 확인 대화상자 %r 에서 %r 을 눌렀다', w.window_text()[:40], name)
                        time.sleep(self._poll_s)
                        return
                    except (ElementNotFoundError, PwTimeoutError):
                        continue
            time.sleep(self._poll_s)
```

- [ ] **Step 4: 구현 — CLI**

`samba-agent/src/samba_agent/export/__main__.py`:

(1) 파일 머리 설명에 한 줄 추가: `shopmine [--dry]        샵마인 일괄 완료됨을 큐 없이 한 번 돌린다(--dry 는 완료됨을 누르지 않는다)`

(2) import 추가:

```python
from samba_agent.export.adapters import AdapterReject, AdapterRetry
from samba_agent.export.desktop.shopmine import ShopMineAdapter
```

그리고 `PywinautoShopMineUi` 는 pywinauto 가 없는 하네스 환경에서도 `list` 가 돌아야 하므로 지연 import 한다:

```python
def _shopmine_ui():
    from samba_agent.export.desktop.shopmine_ui import PywinautoShopMineUi

    return PywinautoShopMineUi()


# 테스트가 바꿔 끼울 수 있게 모듈 이름으로 둔다
PywinautoShopMineUi = _shopmine_ui
```

(3) 명령 함수:

```python
def _shopmine(dry: bool) -> int:
    """샵마인 일괄 완료됨을 큐 없이 한 번 돌린다 — 실기 시험용."""
    adapter = ShopMineAdapter(PywinautoShopMineUi(), dry_run=dry)
    try:
        n = adapter.complete_pending()
    except (AdapterRetry, AdapterReject) as e:
        print(f'샵마인 처리 못 함 — {e.reason.value}: {e.detail}')
        return 2
    print(f'샵마인 {"필터 행(누르지 않음)" if dry else "완료됨 처리"} {n}건')
    return 0
```

(4) 파서·분기:

```python
    p_shop = sub.add_parser('shopmine', help='샵마인 일괄 완료됨을 한 번 돌린다')
    p_shop.add_argument('--dry', action='store_true', help='완료됨을 누르지 않고 행 수만 본다')
    ...
    if args.cmd == 'shopmine':
        return _shopmine(args.dry)
```

`shopmine` 명령은 큐를 열 필요가 없으므로 `queue = ExportQueue(db_path)` 앞에서 분기한다.

- [ ] **Step 5: 테스트 통과·린트**

Run: `uv run pytest tests/test_export_wiring.py -q && uv run ruff format --check src/samba_agent/export tests/test_export_wiring.py && uv run ruff check src/samba_agent/export tests/test_export_wiring.py`
Expected: PASS, 깨끗

- [ ] **Step 6: 실기 시험 1 — 읽기 전용(`--dry`)**

사용자가 화면을 보는 상태에서(샵마인 통합주문관리 열려 있음, 마우스·키보드 20초 이상 안 만짐):

Run (`samba-agent/` 에서): `uv run python -m samba_agent.export shopmine --dry`
Expected: 수집하기가 눌리고, 필터 두 개가 바뀌고, 전체 선택이 켜진 뒤 `샵마인 필터 행(누르지 않음) N건` 이 찍힌다. `완료됨` 은 눌리지 않는다.

안 되는 단계가 있으면 그 단계의 컨트롤 찾기(`_filter_combo`, `row_count`, `select_all`)를 고치고 다시 돌린다. 고친 내용은 보고서에 적는다.

- [ ] **Step 7: 실기 시험 2 — 실제 1회(사용자 확인 뒤)**

사용자가 "진행" 이라고 한 뒤에만: `uv run python -m samba_agent.export shopmine`
Expected: `샵마인 완료됨 처리 N건`, 화면의 필터 결과가 0건. 확인 대화상자가 떴다면 로그에 `샵마인 확인 대화상자 … 을 눌렀다` 가 남는다.

- [ ] **Step 8: 커밋**

```bash
git add samba-agent/pyproject.toml samba-agent/uv.lock samba-agent/src/samba_agent/export/desktop/shopmine_ui.py samba-agent/src/samba_agent/export/__main__.py samba-agent/tests/test_export_wiring.py
git commit -m "기능: 샵마인 pywinauto 드라이버와 shopmine 시험 명령(--dry)"
```

---

### Task 4: 어댑터 등록(설정으로 켬)

**Files:**
- Modify: `samba-agent/src/samba_agent/settings.py` (`export_wait_s` 뒤)
- Modify: `samba-agent/src/samba_agent/export/desktop/__init__.py`
- Modify: `samba-agent/src/samba_agent/export/__main__.py` (`_worker` 가 대상 목록을 넘긴다)
- Test: `samba-agent/tests/test_export_wiring.py`

**Interfaces:**
- Produces:
  - 설정 `export_targets: str = ''` (`SAMBA_EXPORT_TARGETS`, 쉼표 목록. 예 `shopmine`)
  - `build_adapters(targets: Collection[str]) -> dict[str, Adapter | BatchAdapter]` — 이름이 있는 대상만 만든다. `shopmine` → `ShopMineAdapter(PywinautoShopMineUi())`. 모르는 이름은 `ValueError`

- [ ] **Step 1: 실패하는 테스트 작성**

`samba-agent/tests/test_export_wiring.py` 의 `test_이_계획에서는_등록된_어댑터가_없다` 를 아래로 **바꾸고** 두 개를 더한다:

```python
def test_대상을_주지_않으면_어댑터가_없다():
    assert build_adapters(()) == {}


def test_shopmine_대상은_샵마인_어댑터를_만든다(monkeypatch):
    import samba_agent.export.desktop as desktop
    from samba_agent.export.adapters import BatchAdapter

    monkeypatch.setattr(desktop, '_shopmine_ui', lambda: object())
    made = build_adapters(('shopmine',))
    assert set(made) == {'shopmine'}
    assert isinstance(made['shopmine'], BatchAdapter)


def test_모르는_대상은_거부한다():
    with pytest.raises(ValueError):
        build_adapters(('emp',))


def test_export_targets_설정은_쉼표_목록이다(monkeypatch, tmp_path):
    s = settings(monkeypatch, tmp_path, SAMBA_EXPORT_TARGETS='shopmine, emp')
    assert s.export_target_list == ('shopmine', 'emp')
    assert settings(monkeypatch, tmp_path).export_target_list == ()
```

Run: `uv run pytest tests/test_export_wiring.py -q`
Expected: FAIL — `TypeError: build_adapters() takes 0 positional arguments but 1 was given`

- [ ] **Step 2: 구현 — 설정**

`samba-agent/src/samba_agent/settings.py` 의 `export_wait_s` 필드 뒤:

```python
    # 입력 작업자가 맡을 대상(쉼표). 비우면 어댑터를 만들지 않는다. 예: shopmine
    export_targets: str = Field(default='', alias='SAMBA_EXPORT_TARGETS')

    @property
    def export_target_list(self) -> tuple[str, ...]:
        return tuple(x.strip() for x in self.export_targets.split(',') if x.strip())
```

(`@property` 는 `_split_users` 검증기 위에 둔다.)

- [ ] **Step 3: 구현 — 등록 지점**

`samba-agent/src/samba_agent/export/desktop/__init__.py` 전체:

```python
"""외부 프로그램 어댑터 등록 지점.

여기 등록된 대상만 입력 작업자가 큐에서 집는다 — 등록되지 않은 대상의 요청은 큐에 대기로 남는다.
드라이버(pywinauto)는 지연 import 한다 — 하네스 본체에는 그 의존성이 없다.
"""

from collections.abc import Collection

from samba_agent.export.adapters import Adapter, BatchAdapter
from samba_agent.export.desktop.shopmine import ShopMineAdapter


def _shopmine_ui():
    from samba_agent.export.desktop.shopmine_ui import PywinautoShopMineUi

    return PywinautoShopMineUi()


def build_adapters(targets: Collection[str]) -> dict[str, Adapter | BatchAdapter]:
    """설정에 적힌 대상만 만든다(대상 이름 → 어댑터). 모르는 이름은 거부한다."""
    made: dict[str, Adapter | BatchAdapter] = {}
    for target in targets:
        if target == 'shopmine':
            made[target] = ShopMineAdapter(_shopmine_ui())
        else:
            raise ValueError(f'모르는 외부 기입 대상: {target!r} (EMP 어댑터는 아직 없다)')
    return made
```

- [ ] **Step 4: 구현 — CLI 가 설정을 넘긴다**

`samba-agent/src/samba_agent/export/__main__.py`:
- `main()` 에서 `settings = load_settings(DEFAULT_ROOT / '.env')` 를 한 번 읽고 `db_path` 는 그 값(또는 `--db`)으로.
- `_worker(queue, targets)` 시그니처로 바꾸고 `adapters = build_adapters(targets)`; 호출부는 `_worker(queue, settings.export_target_list)`.
- `_shopmine` 의 `PywinautoShopMineUi()` 는 `samba_agent.export.desktop._shopmine_ui()` 를 쓰도록 통일해도 되지만, Task 3 테스트가 `cli.PywinautoShopMineUi` 를 바꿔 끼우므로 그 이름은 유지한다.

- [ ] **Step 5: 통과·전체 테스트·린트·커밋**

Run: `uv run pytest -q && uv run ruff format --check src tests && uv run ruff check src/samba_agent/export tests/test_export_wiring.py`
Expected: 전체 통과(Task 1~4 새 테스트 7+7+2+4 = 20), 형식 깨끗(기존 파일의 이전부터 있던 형식 지적은 제외)

```bash
git add samba-agent/src/samba_agent/settings.py samba-agent/src/samba_agent/export/desktop/__init__.py samba-agent/src/samba_agent/export/__main__.py samba-agent/tests/test_export_wiring.py
git commit -m "기능: 외부 기입 대상 설정(SAMBA_EXPORT_TARGETS)으로 샵마인 어댑터를 등록한다"
```

---

## 스펙 대조

| 스펙 | 다루는 곳 |
|---|---|
| §6.1 절차 1~7 | Task 2(절차), Task 3(드라이버) |
| §6.1 배치 규약·대기 요청 전부 종료·반복 안전 | Task 1 |
| §7-5 사람 사용 중 대기 | 코어 그대로(작업자 idle 검사) |
| §7-6 대화상자 → 중단(우리 확인 대화상자만 예외) | Task 3 `_refuse_if_dialog` · `_confirm_own_dialog` |
| §7-4 되읽기 불일치 재시도 없음 | Task 2 → `AdapterReject(VERIFY_MISMATCH)` → 코어 `fail` |
| §8 실패 알림 | 코어 그대로 |
| §9 어댑터 읽기 전용 시험 → 실기 1건 | Task 3 Step 6·7 |
| §10-4 작업 스케줄러 등록 | EMP 계획에서(작업자 하나가 둘 다 맡는다) |

## 켜는 순서(이 계획 뒤)

1. `.env` 에 `SAMBA_EXPORT_TARGETS=shopmine` → 입력 작업자 `python -m samba_agent.export worker` 를 일반 권한으로 띄운다(샵마인은 일반 권한).
2. `SAMBA_EXPORT_ENABLED=true` 로 하네스를 다음 재시작 때 켠다(큐가 빌 때).
3. 첫 실주문은 사용자가 지켜본다(첫 실주문 직접 가이드 규칙).
