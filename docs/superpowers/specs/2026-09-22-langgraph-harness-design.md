# SAMBA 주문처리 에이전트 — LangGraph 하네스 + LangSmith LLMOps 설계

작성: 2026-09-22 · 상태: 승인 대기

## 1. 목적

포이즌 등 판매처 주문을 소싱처(무신사·29CM·ABC마트·롯데온)에서 구매하고 SAMBA-WAVE 에 기록하는 일을
**직원 누구나 슬랙 한 줄로 시키고**, **한 주문은 한 번에 한 사람만** 처리하며, **틀린 곳을 숫자로 찾아 고칠 수 있게** 한다.

지금(SAMBA Browser 안의 Claude Agent SDK 러너 + 긴 플레이북 글)의 한계:
- 한 덩어리 자유 실행이라 어디서 틀렸는지 로그를 뒤져야 안다.
- 같은 주문도 매번 다르게 움직인다(카드 빼먹기, 직배 플래그 누락).
- 고치는 방법이 "플레이북 글 수정" 뿐이라 검증이 안 된다.
- 직원 간 공유·충돌 방지 장치가 없다.

## 2. 범위

포함
- 슬랙 봇 창구(지시 받기·진행 보고·결과 답장).
- 작업 큐 + 주문 잠금(한 주문 = 한 실행).
- LangGraph 하네스: 주문 1건을 9단계 그래프로 실행. 단계 사이 이동은 코드가 결정.
- SAMBA Browser 를 "손발"로 쓰는 로컬 브릿지(페이지 읽기·클릭·입력·폰 결제 승인·SAMBA 기록).
- LangSmith 추적(모든 실행)·데이터셋·평가(회귀 점수)·진단 시연.
- 기능 검증 절차와 LLMOps 진단 시연 절차.

제외
- 헤르메스(Hermes Agent) 게이트웨이 도입. 슬랙 봇 하나로 대체(§4.1).
- 새 소싱처 추가, 판매처 확대(절차는 나중에 스크립트로 추가).
- SAMBA Browser 자체의 채팅 UI 개편(그대로 둔다. 하네스가 IPC 로 부른다).
- 여러 일꾼 PC 동시 운영(1대 확정. 확장은 큐를 Supabase 로 옮기면 된다).

## 3. 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 창구 | 슬랙 봇 1개(Socket Mode) | 이미 쓰는 메신저. 공개 URL 불필요 |
| 헤르메스 | 안 씀 | 메신저 창구+큐만 필요. 프레임워크 하나 더 배우는 비용이 큼 |
| 일꾼 PC | 사무실 PC 1대 | 잠금·폰·키마스터가 한 곳. 직원은 슬랙에서 지시만 |
| 하네스 | Python 3.12 + LangGraph, 로컬 `langgraph dev` 서버 | 그래프·체크포인트·재개가 기본 제공 |
| 모델 | Claude **구독**(이 PC 의 Claude Code 로그인, Python `claude-agent-sdk`). API 키 없음 | 지금 앱과 같은 인증. Codex 구독으로 교체 가능하게 어댑터 1개. 구독 한도(5시간·주간) 도달 시 큐를 멈추고 슬랙에 알림 |
| 손발 | SAMBA Browser 에 로컬 HTTP 브릿지(127.0.0.1, 토큰 인증) | 이미 있는 도구(page.get/click/type, run_js, 폰 결제, 키마스터)를 그대로 노출 |
| 잠금 | SQLite `jobs` 표(일꾼 PC) + SAMBA-WAVE 상태 "다른 작업자 처리중" | 로컬 잠금이 진실, SAMBA-WAVE 는 표시용 |
| 추적 | LangSmith 클라우드, 프로젝트 `samba-orders` | 요구사항 |
| 개인정보 | 고객 이름·전화·주소는 마스킹 후 전송(기본 켬). 비밀번호·카드번호·토큰은 절대 전송 안 함 | 진단에는 주문번호·금액·단계 결과면 충분 |

## 4. 구조

```
직원(슬랙) → 슬랙 봇 → 작업 큐(잠금) → LangGraph 그래프 → SAMBA Browser 브릿지 → 쇼핑몰·폰
                                              ↓                       ↓
                                          LangSmith            SAMBA-WAVE(기록)
```

### 4.1 슬랙 봇 (`gateway/slack_bot.py`)
- Bolt for Python, Socket Mode(앱 토큰 + 봇 토큰. 둘 다 일꾼 PC 의 `.env`).
- 채널 `#주문처리` 하나. 명령:
  - `@삼바 734501000740906 처리해 [옵션...]` → 큐에 넣고 "접수 · 대기 n번째" 답장. 옵션은 자유 문장(예: "현대카드", "직배").
  - `@삼바 상태` → 진행 중·대기 목록.
  - `@삼바 취소 734501000740906` → 대기 중이면 제거, 실행 중이면 현재 단계 끝난 뒤 중단.
- 진행 보고: 스레드에 단계마다 한 줄("4/8 배송지 결정 — 직배"). 완료·실패·사람 확인 필요는 본문 메시지 + 담당자 멘션.
- 같은 주문을 다른 직원이 또 넣으면 "이미 ○○님이 처리 중(3/8)" 답장. 이것이 충돌 방지의 사용자 접점.

### 4.2 작업 큐 (`queue/`)
- SQLite 표 `jobs(id, order_no UNIQUE, requester, options, state, step, thread_ts, created_at, updated_at, error)`.
- 상태: `queued → running → done | failed | needs_human | cancelled`.
- 실행기(worker)는 한 번에 1건. 다음 건은 앞 건이 끝나야 시작(브라우저·폰이 하나).
- 잠금 = `order_no UNIQUE` + `state in (queued, running, needs_human)` 인 행이 있으면 새로 못 넣는다.
- 실행 시작 시 SAMBA-WAVE 행 상태를 "다른 작업자 처리중"으로, 끝나면 결과 상태로 바꾼다(브릿지 경유).

### 4.3 LangGraph 그래프 (`graph/`)
상태(State): `order_no, requester, options, order(SAMBA 행), source(사이트·계정), item(품번·옵션·수량), shipping(직배|까대기, 주소), payment(수단·카드·원가 후보), result(소싱 주문번호·실결제액), step_log[], handoff(reason)`.

노드(9개) — 각 노드는 "브릿지 호출 + 필요하면 LLM 판단 1회". 노드 사이 이동은 코드 조건.

| # | 노드 | 하는 일 | 다음으로 못 가는 조건 |
|---|---|---|---|
| 1 | read_order | SAMBA-WAVE 에서 행 읽기, 중복 구매 검사 | 소싱주문번호 이미 있음 → `done(skip)` |
| 2 | pick_source | 소싱처·후보 계정 목록 결정, 저장 스크립트 선택 | 지원 안 하는 소싱처 → `needs_human` |
| 3 | select_item | 옵션·수량 선택 → 주문서 진입(기본 계정) | 품절 → `failed(out_of_stock)` + SAMBA 재고X |
| 4 | compare_accounts | 계정마다 프로필 탭에서 같은 주문서를 열고 최대 쿠폰·회원할인·적립 적용 후 **총액·원가 표** 작성 → 가장 싼 계정 확정. 계정 1개면 통과 | 어느 계정도 주문서를 못 만들면 `needs_human` |
| 5 | decide_shipping | 직배/까대기 판정(판매처·정가 규칙 or 지시), 확정 계정 주문서에 배송지 반영 | 배송지 반영 확인 실패 → 재시도 1회 → `needs_human` |
| 6 | decide_payment | 확정 계정에서 허용 수단별 원가 계산, 최저 선택, **카드 이름 확정** | 마진 미달 → `failed(margin)` + 가격X; 카드 없음 → `needs_human` |
| 7 | pay | 웹 결제창 + 폰 승인(카드 지정 필수) | 캡차·2단계 인증·승인 실패 → `needs_human` |
| 8 | record | SAMBA-WAVE 에 계정·소싱주문번호·실구매가·배송비·메모·플래그 저장 | 필드 하나라도 저장 확인 실패 → 재시도 → `needs_human` |
| 9 | verify | 소싱처 주문 상세 + SAMBA 재조회로 대조, 슬랙 보고 | 불일치 → `failed(verify)` |

- 노드 4 의 비교 표(계정·쿠폰·총액·원가)는 상태에 남아 LangSmith 채점 대상이 된다("정답 계정을 골랐나").
- 비교에 쓴 다른 계정의 주문서 탭은 결제 전에 닫는다(잘못된 탭에서 결제하지 않게 노드 7 은 확정 계정 탭만 받는다).
- `needs_human`: 그래프는 체크포인트에 멈추고 슬랙에 스크린샷(비밀 화면 제외)과 사유. 직원이 브라우저에서 처리 후 `@삼바 이어서 734501000740906` 치면 같은 노드부터 재개(LangGraph interrupt/resume).
- LLM 판단이 있는 노드(2·4·5·6)는 `claude-agent-sdk` 로 부르고 **구조화 출력**(JSON 스키마 → Pydantic)만 받는다. 예: `decide_payment` 는 `{method, card, unit_cost, margin_pct, reason}`. 카드 없는 답은 스키마에서 거부.
- 노드마다 프롬프트는 짧은 고정 문장 + 그 노드에 필요한 화면 요약만. 18,000자 플레이북은 노드별로 쪼개 넣는다(재사용 자산).

### 4.4 SAMBA Browser 브릿지 (`src/main/bridge/`)
- 앱 안에 127.0.0.1:47811 HTTP 서버. 헤더 `X-Samba-Token`(앱 설정에서 생성, `.env` 로 하네스에 전달). 외부 인터페이스 바인딩 금지.
- 엔드포인트(모두 기존 에이전트 도구를 그대로 감싼다):
  - `POST /page/get`, `/page/find`, `/page/click`, `/page/type`, `/page/select`, `/page/scroll`, `/page/dismiss_overlay`
  - `POST /run_js` (지금 run_js 샌드박스), `POST /script/run` (저장 스크립트)
  - `POST /tabs/open|switch|close`, `GET /tabs`
  - `POST /vault/login`, `/vault/fill_secret` (값은 브릿지 응답에 절대 안 실림. 성공 여부만)
  - `POST /phone/approve_payment` (provider, amount, merchant, card 필수)
  - `POST /samba/order/get`, `/samba/order/update`, `/samba/order/flag`
  - `GET /screenshot` (비밀 화면이면 거부)
- 브릿지가 켜져 있으면 앱 채팅창의 AI 는 그대로 쓸 수 있다(두 경로 병존). 브릿지 호출 중에는 채팅 실행을 막는다(한 손발).

### 4.5 LangSmith (`ops/`)
- 추적: 그래프 실행 전체가 1 trace, 노드 = span, LLM 호출·브릿지 호출 = 하위 span. 메타데이터: `order_no, source, requester, job_id`.
- 마스킹: 전송 직전 훅에서 고객 이름·전화(010-…)·주소(도로명·동·호)·이메일을 `***` 처리. 비밀번호·카드번호는 애초에 상태에 없다(브릿지가 안 돌려준다).
- 데이터셋 `samba-orders-regression`: 실제 처리한 주문의 입력(상태 스냅샷)과 기대 출력(노드별 판단 결과)을 저장. 초기 20건(무신사 10·ABC 5·29CM 3·롯데온 2)은 지난 실기 기록으로 만든다.
- 평가(`evals/`): 브라우저 없이 노드 2·4·5·6 만 돌리는 오프라인 평가(노드 4 는 저장된 비교 표를 입력으로). 채점기: 정확 일치(소싱처·계정·배송 방식·결제수단·카드), 허용 오차(원가 ±1%), LLM 채점(사유 문장 타당성). 명령 `python -m ops.eval --dataset samba-orders-regression` → LangSmith 실험 링크 + 요약표.
- 진단: 슬랙에서 `@삼바 진단 734501000740906` → 그 실행의 LangSmith trace 링크 + 단계별 소요·재시도·실패 사유 표.

## 5. 데이터 흐름(정상 1건)
1. 직원: `@삼바 734501000740906 처리해 현대카드`.
2. 봇: 큐 삽입(잠금) → "접수". 실행기가 집어 `running`, SAMBA-WAVE 상태 "처리중".
3. 그래프 1→9. 노드마다 스레드에 한 줄. 노드 4 에서 계정 확정, 노드 6 에서 `card="현대"` 확정 → 노드 7 은 이 값 없이는 호출 불가.
4. 노드 8 저장 뒤 노드 9 가 재조회로 대조. 통과 → `done`, 슬랙 본문에 결과 표(소싱 주문번호·실결제·원가·마진·배송 방식).
5. 전체가 LangSmith 에 trace 로 남고, 결과는 회귀 데이터셋 후보로 표시(직원이 슬랙 반응 이모지로 "정답" 승인 → 데이터셋 추가).

## 6. 오류 처리
- 브릿지 호출 실패(타임아웃 20초·앱 꺼짐): 노드 재시도 1회 → `failed(bridge)`. 앱이 죽었으면 봇이 "삼바 브라우저 꺼짐" 알림.
- LLM 구조화 출력 실패: 재요청 1회 → `needs_human`.
- 결제 후 기록 실패: 절대 재결제 안 함. `needs_human` 에 "결제는 됐음, 기록만 남음" 명시.
- 실행기 프로세스 재시작: `running` 이던 건은 LangGraph 체크포인트에서 마지막 완료 노드 다음부터 재개. 노드 7(결제)이 진행 중이었으면 재개하지 않고 `needs_human`.
- 취소: 노드 경계에서만. 결제 노드 진입 후엔 취소 불가.

## 7. 검증 계획

### 7.1 기능 검증
1. 단위: 각 노드를 가짜 브릿지로 테스트(pytest). 조건 분기(품절·마진 미달·카드 없음·중복)를 전부 표로.
2. 통합(브릿지): SAMBA Browser 실제 실행 + 하네스 → 무신사 주문 1건을 결제 직전(노드 6 종료)까지. 노드 7 은 `dry_run` 플래그로 건너뜀.
3. 실기: 무신사 1건 끝까지(결제·기록·검증). 이어서 ABC 1건, 29CM 1건.
4. 충돌: 두 직원이 같은 주문을 10초 간격으로 넣기 → 두 번째는 거절 답장, 큐에 1건.
5. 재개: 노드 5 에서 강제 `needs_human` → 브라우저에서 처리 → `이어서` → 노드 5 부터 완료.

### 7.2 LLMOps 진단 시연
1. 실기 3건의 trace 를 LangSmith 에서 열어 단계별 시간·토큰·재시도 확인.
2. 회귀 데이터셋 20건으로 `ops.eval` 실행 → 기준 점수 기록.
3. 노드 6 프롬프트를 일부러 고쳐(카드 규칙 삭제) 다시 평가 → 점수 하락과 실패 사례가 표로 잡히는 것 시연.
4. 원상복구 후 재평가 → 점수 복귀. 이것이 "주먹구구 수정" 대신 쓰는 절차.

## 8. 저장소 구성
```
samba_browser/            (기존, 브릿지 추가: src/main/bridge/)
samba-agent/              (신규, Python)
  gateway/slack_bot.py
  queue/{db.py, worker.py}
  graph/{state.py, nodes/, build.py}
  bridge/client.py        (HTTP 클라이언트)
  ops/{tracing.py, masking.py, eval.py, datasets/}
  tests/
  .env.example            (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, LANGSMITH_API_KEY, SAMBA_BRIDGE_TOKEN — 모델은 Claude Code 로그인)
```

## 9. 남는 위험
- 브릿지가 앱 안에 있어 앱이 꺼지면 전부 멈춘다 → 봇이 앱 실행 상태를 30초마다 확인하고 알린다.
- 폰 승인은 여전히 실기 의존(알림·키패드 변화). 노드 6 실패는 `needs_human` 으로 흡수.
- LangSmith 마스킹은 정규식 기반 — 새 형식의 개인정보는 새 규칙이 필요.
