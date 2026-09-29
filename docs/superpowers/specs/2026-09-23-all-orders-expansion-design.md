# 주문처리 하네스 — 전체 주문 확대 설계 (2026-09-23)

상태: 초안(사용자 검토 대기). 기준 스펙: `2026-09-22-langgraph-harness-design.md`(감독자 + LLMOps).

## 1. 목표

포이즌 1건씩 처리하던 하네스를 **삼바웨이브의 모든 미이행 주문**으로 넓힌다.

- 판매처(마켓)는 이미 제한이 없다 — 등록부는 소싱처로만 배정한다(2026-09-23 실기: 신세계몰 주문 통과).
- 넓히는 축은 둘: **소싱처(국내 전부)** 와 **접수(자동 수집 + 결제만 승인)**.

## 2. 근거 데이터 (삼바웨이브 API, 2026-01-01 ~ 09-23, 취소·반품 제외)

| 소싱처 | 올해 주문 | 소싱주문번호 없음(주문접수) |
|---|---:|---:|
| GSSHOP | 1,247 | 751 |
| MUSINSA | 414 | 205 |
| (미지정) | 371 | 297 |
| KREAM | 213 | 1 |
| ABCmart | 152 | 105 |
| LOTTEON | 73 | 11 |
| SSG | 41 | 20 |
| 29CM · FashionPlus · SHOEMAKER · GrandStage | 7 · 6 · 4 · 1 | 1 · 1 · 0 · 0 |

- 소싱주문번호 없는 건 1,977건 중 1,865건이 4~5월(엑셀 발주 시절 잔재). **최근 14일은 4건**(KREAM 1, 미지정 3). 자동 수집은 **기간 창(기본 7일)** 을 둔다.
- 삼바웨이브 확장앱은 이미 7개 소싱처(MUSINSA·SSG·LOTTEON·ABCmart·GrandStage·GSShop·FashionPlus)에서 "주문처리" 버튼 → 옵션 선택 → 배송지(직배=고객, 까대기=사무실) → 쿠폰 → **결제 직전**까지 간다(`extension/content-purchase-*-order.js`). 결제·기록은 사람 손. 하네스는 그 뒤(결제·기록·검증)까지 맡는 것이 차이다.

## 3. 소싱처 범위 = 국내 전부 (사용자 결정)

삼바웨이브 `SUPPORTED_SOURCING_SITES` 의 KR 23개 중 중고(BUNJANG·DAANGN)·가격비교(DANAWA)를 뺀 **20개**.

| 단계 | 소싱처 | 근거 |
|---|---|---|
| 1 (있음) | MUSINSA · 29CM · ABCmart · LOTTEON | 스크립트 있음, ABCmart dry-run 통과 |
| 2 | **GSShop · SSG · FashionPlus** | 주문량 1·7·9위, 확장앱 흐름을 그대로 옮길 수 있다 |
| 3 | KREAM · SHOEMAKER · Nike · Adidas · OliveYoung · WCONCEPT | 주문 있거나 계정 있음(나이키 12계정) |
| 4 | GMARKET · 11ST · NAVERSTORE · TheHyundai · REXMONDE · SMARKET · KASINA · GrandStage(ABC 흐름 공유) | 올해 주문 0~1건 — 스크립트만 만들어 두고 실기는 주문 생기면 |
| 제외 | (미지정) 소싱처 | 어디서 살지 정하는 문제 — 하네스 밖. needs_human 으로 넘김 |

소싱처 1개 추가 = **등록부 1행 + 규칙 파일 1개 + 앱 스크립트 3개**(`<key>_product_snapshot`·`<key>_set_shipping`·`checkout_enter_<key>`) + `source_order_detail` 분기 1개. 지금은 이름표를 코드 4곳(buyer·payer 사전, 조회 platformMap, 등록부)에 흩어 적는다 → **소싱처 표(`sources.yaml`) 하나**로 모은다(§5).

## 4. 접수 = 자동 수집 + 결제만 승인 (사용자 결정)

### 4.1 미이행 주문의 정의
`status == pending(주문접수)` ∧ `sourcing_order_number` 비어 있음 ∧ 취소·반품 상태 아님 ∧ `paid_at` 이 최근 N일(기본 7) ∧ 소싱처가 등록부에 있음.
- 소싱처 미지정·미등록 소싱처는 큐에 넣되 바로 `needs_human`(사유 `unsupported`)로 슬랙에 한 줄.
- `wait_ship(배송대기중)` 은 사람이 이미 산 뒤 바꾸는 상태 — 수집하지 않는다.

### 4.2 수집 경로 — 두 안
| 안 | 방법 | 장점 | 단점 |
|---|---|---|---|
| **A. 삼바웨이브 내부 API(권장)** | 백엔드에 `GET /internal/harness/pending-orders?days=7` + `PUT /internal/harness/orders/{id}/sourcing`(소싱주문번호·실구매가·배송비·계정) 추가. `balju_internal` 과 같은 `X-Internal-Token` 인증 | 빠르고 정확(JSON), 기록도 API 로 → 화면 스크립트 3개(`samba_find_order`·`samba_save_order`·`samba_read_order`) 불필요, 개인정보는 배송지 입력 순간만 하네스 메모리에 | 삼바웨이브 백엔드 수정·배포 필요(사용자 검토·승인) |
| B. 앱 화면 스크립트 | 삼바웨이브 주문 페이지에 필터(주문접수·주문번호X·최근)를 걸고 목록을 읽는 `samba_pending_orders` 스크립트 | 삼바웨이브 무수정 | 느림(탭 필요), 페이지 구조 변경에 약함, 기록도 화면으로 |

두 안 모두 **주문 데이터 계약은 같다**: `order_no, source(소싱처 id), seller, sku, option, qty, product_url, account, order_type(direct|kkadaegi|gift), shipping(이름·전화·주소 — 실행 순간만)`. 안 A 를 골라도 B 스크립트는 폴백으로 남긴다.

### 4.3 수집 고리
- 하네스 `intake` 스레드: 주기(기본 5분)마다 미이행 주문을 읽어 `JobQueue.enqueue`(살아 있는 건은 중복 거절 — 이미 있음). 접수마다 슬랙 채널에 **최상위 메시지 1개** → 그 스레드에 진행·승인 카드.
- 슬랙 명령 추가: `주문처리 전체`(즉시 1회 수집), `수집 중지/재개`.
- 처리 순서: 결제일 오래된 순. 동시 1건(브릿지가 한 번에 한 세션).

### 4.4 승인 게이트
`EXTERNAL_STAGES = ('pay',)` — **결제만** 사람이 승인. 기록(삼바웨이브 소싱주문번호 입력)은 자동, 검증 단계가 되읽어 대조한다. 거부·실패는 지금처럼 needs_human.

### 4.5 배송 방식
삼바웨이브 주문의 직배/까대기/선물 플래그를 읽어 배송지를 정한다(까대기 = 사무실 주소, 삼바웨이브 `proxy/config/office-shipping`). 플래그가 없으면 직배. 스냅샷·배송지 스크립트 인자에 `orderType` 추가.

## 5. 코드 구조 변경(하네스)

- `samba-agent/sources.yaml`: 소싱처 표 — `id`(삼바웨이브 source_site) · `label` · `home` · `product_id_regex` · `login_host`. 등록부의 buyer 행은 이 표에서 **생성**(`registry.yaml` 의 buyer 4행은 표로 옮긴다). 스크립트 이름은 관례 `<id 소문자>_product_snapshot` 등.
- `queue/intake.py`: 미이행 주문 수집(안 A 클라이언트 또는 B 스크립트) → enqueue → 슬랙 최상위 메시지.
- `agents/buyer.py`: `order_type` → 배송지 선택, `sources.yaml` 로 스크립트 이름·상품 ID.
- `agents/recorder.py`: 안 A 면 API 로 기록, 아니면 기존 스크립트.
- 앱 저장 스크립트: 소싱처마다 3개. 2단계(GSShop·SSG·FashionPlus)는 확장앱 `content-purchase-*-order.js` 의 셀렉터·순서를 옮겨 적는다(앱 AI 대화, 사이트당 1회).
- 판정: 소싱처마다 데이터셋 `ds.buyer.<id>`(10건, 실기 기록에서 채움) — `gate_eligible` 은 실제 에이전트 데이터셋이 생겨야 true.

## 6. 단계별 완료·진입 조건

| 단계 | 진입 조건 | 완료 조건 | 검증(실패·재시도·중복·권한) |
|---|---|---|---|
| S1 소싱처 표·등록부 생성 | 이 스펙 승인 | 기존 4개 소싱처 dry-run 회귀 통과(테스트) | 모르는 소싱처 → unsupported needs_human |
| S2 자동 수집(안 A 또는 B) | 수집 경로 결정 | 최근 7일 미이행 주문이 큐·슬랙에 뜨고, 같은 주문 두 번 안 뜸 | 중복 접수 거절, 인증 실패 → 알림 후 다음 주기, 수집 중 브릿지 busy → 건너뜀 |
| S3 결제만 승인 | S2 | 승인 카드 pay 만, 기록 자동 → 검증 대조 | 거부 → needs_human, 기록 실패 → 재시도 1회 뒤 needs_human |
| S4 GSShop·SSG·FashionPlus 스크립트 | S1 | 각 소싱처 dry-run 1건(결제창까지, 결제 없음) | 품절·계정 없음·캡차 각 1회 유도 |
| S5 3·4단계 소싱처 | S4 | 스크립트 저장 + 상품 1개로 dry-run | 동일 |
| S6 실기 | 사용자 승인 | 실주문 1건 결제·기록·검증 통과 | 재결제 없음(pay_started), 검증 불일치 → needs_human |

## 7. 사용자 결정 필요

1. 수집 경로: **안 A(삼바웨이브 내부 API)** 승인 여부 — 백엔드에 엔드포인트 2개 추가·배포.
2. KREAM 포함 여부 — 웹 구매 가능하나 삼바웨이브는 별도 회선 릴레이로 다루는 사이트(차단 위험). 3단계에 두되 실기는 따로 승인.
3. 수집 기간 창 7일·주기 5분 기본값.
