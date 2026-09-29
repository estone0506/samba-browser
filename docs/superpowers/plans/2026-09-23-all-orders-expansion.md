# 전체 주문 확대 구현 계획 (2026-09-23)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. 스펙: `docs/superpowers/specs/2026-09-23-all-orders-expansion-design.md`(사용자 결정: 수집 경로 A, KREAM 보류, 창 7일·주기 5분).

**Goal:** 하네스가 삼바웨이브의 최근 미이행 주문을 스스로 수집해 국내 소싱처 전부에서 구매 준비까지 하고, 결제만 사람이 승인한 뒤 기록·검증까지 끝낸다.

**Architecture:** (1) 삼바웨이브 백엔드에 내부 API 3개(`/api/v1/internal/harness/*`, X-Internal-Token + X-Tenant-Id). (2) 하네스에 소싱처 표 `sources.yaml` → 등록부 buyer 행·스크립트 이름·상품 ID 규칙을 한 곳에서. (3) 하네스 `wave` 클라이언트로 조회·기록·검증, `intake` 고리로 자동 접수, 승인은 pay 만.

**Tech Stack:** samba-wave: FastAPI·SQLModel(Async)·pytest. samba-agent: Python 3.12·pydantic v2·httpx·respx·pytest·ruff.

## Global Constraints
- 개인정보(이름·전화·주소)는 하네스 state·payload·로그·슬랙·LangSmith 에 남지 않는다. 배송지는 실행 순간만 메모리(기존 `_set_shipping` 규칙).
- 비밀(토큰)은 `.env` 에만. 코드·로그·테스트 파일에 실제 값 금지. 테스트는 `load_settings(env_file=None)`.
- 하네스 코드 스타일: 주석·docstring 한국어, ruff format/check 통과, 새 로직마다 테스트.
- 삼바웨이브 코드 스타일: 파일 머리말 `[무엇]/[언제]/[주의]` 3줄, ruff, 개인정보 필드는 필요한 응답에만.
- 소싱처 id 는 삼바웨이브 `source_site` 값(MUSINSA·29CM·ABCmart·LOTTEON·GSShop·SSG·FashionPlus·…)과 정확히 같다. 한글 이름(무신사 등)은 표시용.
- 결제는 dry-run 기본(SAMBA_DRY_RUN=true). 실기는 사용자 승인 후.

---

### Task A: 삼바웨이브 하네스 내부 API (저장소 `C:\Users\canno\workspace\samba-wave`, 브랜치 main 에서 `feature/harness-internal-api`)

**Files:**
- Create: `backend/backend/api/v1/routers/samba/harness_internal.py`
- Modify: `backend/backend/app_factory.py`(라우터 등록, balju 옆), `backend/backend/middleware/api_gateway.py`(`_EXEMPT_PREFIXES` 에 `"/api/v1/internal/harness/"`)
- Test: `backend/tests/api/test_harness_internal.py`

**Interfaces (Produces):**
- 인증: `X-Internal-Token`(cs_internal 의 `_require_internal_token` 재사용) + `X-Tenant-Id`(필수, 없으면 400). 요청 처리 동안 `backend.core.tenant_context.current_tenant_id` 를 그 값으로 set/reset 해 ORM 테넌트 필터가 걸리게 한다(cs_internal.py 395~412 패턴).
- `GET /api/v1/internal/harness/pending-orders?days=7&limit=100` → `{"items": [PendingOrder…], "count": n}`
  - 조건: `status == "pending"`, `sourcing_order_number` NULL/빈값, `status not in EXCLUDED_ORDER_STATUSES`, `paid_at >= now - days`(paid_at 없으면 created_at), `source_site` 비어 있지 않음. 정렬 paid_at 오름차순.
  - `PendingOrder` 필드(개인정보 없음): `id, order_number, source_site, source_url, product_name, product_option, quantity, sale_price, seller(=sales_channel_alias 없으면 channel 이름), sourcing_account_id, action_tag, paid_at, status`.
- `GET /api/v1/internal/harness/orders/{order_number}` → `PendingOrder` + `order_type`(`kkadaegi` if action_tag 토큰에 kkadaegi, `gift` if gift, else `direct`) + `shipping: {name, phone, address, address_detail, postal_code}` — kkadaegi 면 사무실 배송정보(`proxy/config.py` 의 `_get_setting(session, OFFICE_SHIPPING_KEY)`), 아니면 고객 정보. 없으면 404.
- `PUT /api/v1/internal/harness/orders/{order_number}/sourcing` body `{sourcing_order_number: str, cost: float, shipping_fee: float = 0, sourcing_account_id: str | None, notes: str | None}` → `SambaOrderService.update_order(order.id, data)` 로 저장, `{"ok": true, "order": PendingOrder}`. 이미 다른 소싱주문번호가 있고 다르면 409.
- 테스트(비동기 DB 픽스처는 `backend/tests/conftest.py` 관례): 토큰 없음 503/틀림 403, 테넌트 헤더 없음 400, pending-orders 가 취소·기입·오래된 건을 뺀다, orders/{no} 가 kkadaegi 면 사무실 주소, sourcing PUT 이 저장하고 409.

**Steps:** 실패 테스트 → 구현 → `cd backend && .venv/Scripts/python.exe -m ruff format . && ruff check --fix . && pytest tests/api/test_harness_internal.py -q` → 커밋(한국어 메시지).

### Task B: 하네스 소싱처 표 `sources.yaml` (저장소 samba_browser, `samba-agent/`)

**Files:**
- Create: `samba-agent/sources.yaml`, `samba-agent/src/samba_agent/sources.py`, `samba-agent/rules/buyer_default.md`, 소싱처별 `rules/buyer_<key>.md`(기존 4개 유지, 나머지는 default 를 include 하는 짧은 파일)
- Modify: `registry.yaml`(buyer 4행 삭제 → `buyers_from: sources.yaml` 한 줄), `agents/registry.py`(로딩 시 sources 로 buyer 행 생성), `agents/buyer.py`(`SNAPSHOT_SCRIPT`·`SET_SHIPPING_SCRIPT`·`_PRODUCT_ID_OF`·`SITE_HOME` 사전 → `sources` 조회), `agents/payer.py`(`CHECKOUT_SCRIPT` → sources), `queue/orders.py`(source 정규화: 한글·id 모두 받아 id 로), `agents/factory.py`(buyer 생성 루프)
- Test: `tests/test_sources.py`, 기존 테스트 갱신

**Interfaces:**
```yaml
# sources.yaml — 한 행 = 소싱처 1개. key 는 스크립트 이름 접두어, id 는 삼바웨이브 source_site
sources:
  - id: MUSINSA      # 삼바웨이브 source_site
    key: musinsa     # 스크립트 접두어: musinsa_product_snapshot · musinsa_set_shipping · checkout_enter_musinsa
    label: 무신사     # 표시·별칭(조회 결과의 '무신사' 도 이 id 로 정규화)
    home: https://www.musinsa.com/
    login_host: musinsa.com
    product_id: null           # 상품 URL 에서 스냅샷 sku 로 넘길 ID 정규식(없으면 URL 그대로)
    status: active             # active | scripts_pending(스크립트 미작성) | hold(KREAM)
  - id: 29CM, key: cm29 … - id: ABCmart, key: abc, product_id: '[?&]prdtNo=(\d+)' … - id: LOTTEON, key: lotteon
  - GSShop(gsshop, gsshop.com) · SSG(ssg, ssg.com) · FashionPlus(fashionplus, fashionplus.co.kr) · GrandStage(grandstage, a-rt.com, ABC 흐름 공유 → key: abc)
  - Nike · Adidas · OliveYoung · WCONCEPT · SHOEMAKER · GMARKET · 11ST · NAVERSTORE · TheHyundai · REXMONDE · SMARKET · KASINA — status: scripts_pending
  - KREAM — status: hold
```
- `sources.py`: `Source` 모델(위 필드), `Sources.load(root)`, `Sources.by_id(id_or_label) -> Source | None`(id·label·key 대소문자 무시), `Sources.active()`.
- 등록부: buyer 행은 `buyer.<key>`, `match: {source: <id>}`, tools 는 기존 buyer 와 동일, `rules: rules/buyer_<key>.md`(없으면 `rules/buyer_default.md`), `prompts: samba/buyer-<key>`, `dataset: ds.buyer.<key>`, `retry: 1`. `hold` 는 등록하지 않는다(→ unsupported needs_human). `scripts_pending` 은 등록하되 buyer 가 시작할 때 `needs_human('스크립트 미작성: <id>')`.
- `lookup_order`/`OrderRef.source` 는 항상 id. 기존 테스트의 `source='무신사'` 는 정규화돼 통과해야 한다.

### Task C: 삼바웨이브 클라이언트 + 조회·기록·검증을 API 로

**Files:**
- Create: `samba-agent/src/samba_agent/wave/__init__.py`, `wave/client.py`, `tests/test_wave_client.py`
- Modify: `settings.py`(`SAMBA_WAVE_URL` 기본 `https://api.samba-wave.co.kr`, `SAMBA_WAVE_INTERNAL_TOKEN: SecretStr | None`, `SAMBA_WAVE_TENANT_ID: str | None`, `SAMBA_INTAKE_DAYS=7`, `SAMBA_INTAKE_INTERVAL_S=300`), `queue/orders.py`(`lookup_order_api(wave, order_no)` 우선, 클라이언트 없으면 기존 스크립트 경로), `agents/buyer.py`(`_fetch_shipping`: Assignment 에 배송지 공급자 콜러블이 있으면 그것, 없으면 스크립트), `agents/recorder.py`(wave 가 있으면 `record_sourcing` PUT 후 GET 되읽기, 없으면 스크립트), `agents/verifier.py`(삼바 쪽 값은 wave GET), `__main__.py` 배선
- Test: 위 파일별 respx 테스트

**Interfaces:**
- `WaveClient(base_url, token: str, tenant_id: str, timeout_s=10)`: `pending_orders(days, limit) -> list[WaveOrder]`, `get_order(order_no) -> WaveOrderDetail`(shipping 포함 — 호출부는 즉시 쓰고 버린다), `record_sourcing(order_no, *, sourcing_order_number, cost, shipping_fee, sourcing_account_id=None, notes=None) -> WaveOrder`. 오류는 `WaveError(reason: FailReason, status)`: 401/403/503 → PERMISSION_DENIED, 404 → UNKNOWN, 409 → DUPLICATE, 연결 실패 → BRIDGE_DOWN.
- `WaveOrder` → `OrderRef` 변환 `to_order_ref()`: `order_no=order_number, source=source_site, seller, sku=f'{product_name} [{product_option}]', option=product_option, qty=quantity, product_url=source_url, account=sourcing_account_id(라벨이 있으면 라벨), order_type`.
- `OrderRef.order_type: Literal['direct','kkadaegi','gift'] = 'direct'` 추가.

### Task D: 자동 수집 고리 + 슬랙 최상위 게시 + 결제만 승인

**Files:**
- Create: `samba-agent/src/samba_agent/queue/intake.py`, `tests/test_intake.py`
- Modify: `gateway/slack_bot.py`(`post_new(text) -> ts | None` 최상위 메시지; `_dispatch` 에 `intake_now`·`intake_pause`·`intake_resume`), `gateway/commands.py`(`주문처리 전체` → `intake_now`, `수집 중지`/`수집 재개`), `supervisor/graph.py`(`EXTERNAL_STAGES = ('pay',)`), `__main__.py`(intake 스레드), `queue/db.py`(필요 시 `enqueue` 가 `source`·`thread_ts` 저장은 기존 그대로)
- Test: 명령 파싱, intake 가 중복을 거절하고 슬랙 최상위 메시지 1개/주문, 일시정지, wave 오류 시 다음 주기, `EXTERNAL_STAGES` pay 만(record 는 interrupt 없이 지나감 — 기존 승인 테스트 갱신)

**Interfaces:**
- `Intake(wave, queue, post_new: Callable[[str], str | None], days, requester='intake', paused=False)`: `run_once() -> IntakeReport(seen, enqueued, skipped_live, skipped_unsupported)`, `run_forever(stop, interval_s)`. `unsupported`(등록부에 없는 소싱처·hold)는 enqueue 후 즉시 `queue.finish(needs_human, error='unsupported: <source>')` + 스레드 한 줄.
- 슬랙 최상위 메시지 형식: `접수: {order_no} · {source} · {sku 앞 40자} · {qty}개` → 반환 ts 를 `enqueue(thread_ts=ts)` 에 넘긴다.

### Task E: 앱 저장 스크립트 — GSShop · SSG · FashionPlus (앱 AI 대화, 컨트롤러가 직접)
- 확장앱 `samba-wave/extension/content-purchase-{gs,ssg,fashionplus}-order.js` 의 셀렉터·순서를 프롬프트에 넣어 `gsshop_product_snapshot`·`gsshop_set_shipping`·`checkout_enter_gsshop`(저장만) 등 3×3 을 만들고 `source_order_detail` 분기 추가. 사이트당 dry-run 1건(결제 없음).

### Task F: 배포·실기 진입
- 삼바웨이브: `docker compose --env-file local.env -f docker-compose.tunnel.yml up -d --build samba-api`(worker·reconciler·kream 은 같은 이미지지만 재생성 불필요 — api 만) → `curl -H X-Internal-Token …` 스모크. `.env` 에 `SAMBA_WAVE_INTERNAL_TOKEN`(local.env 의 cs_internal_token)·`SAMBA_WAVE_TENANT_ID` 추가(값은 파일에만).
- 하네스 재시작 → 최근 7일 미이행 주문이 슬랙에 뜨는지 → 각 소싱처 dry-run.
