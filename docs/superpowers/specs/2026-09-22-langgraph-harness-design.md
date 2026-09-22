# SAMBA 주문처리 에이전트 — 감독자 기반 멀티 에이전트 하네스 + LLMOps 판정 시스템 설계

작성: 2026-09-22 · 개정 2(멀티 에이전트·LLMOps 구체화) · 상태: 승인됨(2026-09-22, 개정 2)

## 1. 목적

포이즌 등 판매처 주문을 소싱처(무신사·29CM·ABC마트·롯데온)에서 구매하고 SAMBA-WAVE 에 기록하는 일을
**직원 누구나 슬랙 한 줄로 시키고**, **한 주문은 한 번에 한 사람만** 처리하며, **에이전트를 소싱처·역할 단위로 늘려 갈 수 있고**,
**지금 에이전트 버전을 운영에 내보낼지 디버그·개선으로 돌릴지 숫자로 결정**할 수 있게 한다.

지금(SAMBA Browser 안의 Claude Agent SDK 러너 1개 + 긴 플레이북 글)의 한계:
- 에이전트 하나가 전부 한다 — 소싱처가 늘면 플레이북만 길어지고 서로 간섭한다.
- 한 덩어리 자유 실행이라 어디서 틀렸는지 로그를 뒤져야 안다.
- 같은 주문도 매번 다르게 움직인다(카드 빼먹기, 직배 플래그 누락).
- "운영에 내보내도 되나"를 판단할 근거가 없다. 고치고 감으로 돌려 본다.
- 직원 간 공유·충돌 방지 장치가 없다.

## 2. 범위

포함
- 슬랙 봇 창구(지시 받기·진행 보고·결과 답장) — 기존 `#sambaorder`.
- 작업 큐 + 주문 잠금(한 주문 = 한 실행).
- **감독자 에이전트** 1개 + **전문 에이전트** 여러 개(소싱처별 구매·결제·기록·검증)로 구성된 LangGraph 하네스. 전문 에이전트는 등록부에 1행 추가로 늘린다.
- SAMBA Browser 를 "손발"로 쓰는 로컬 브릿지.
- **LLMOps 판정 시스템**: 관찰(Observe) → 평가(Evaluate) → 진단(Diagnose) → 결정(Decide) 4단계가 하나의 시스템으로 버전마다 "운영 배포 / 디버그·개선"을 낸다. LangSmith 를 추적·데이터셋·실험·온라인 평가·검수 큐·프롬프트 허브·알림까지 전부 쓴다.
- 자동화 페이지에 감독자·에이전트 흐름 그래프 표시.
- 기능 검증·LLMOps 시연 절차.

제외
- 헤르메스 게이트웨이(슬랙 봇으로 대체).
- 여러 일꾼 PC 동시 운영(1대. 확장은 큐를 Supabase 로 옮기면 된다).
- SAMBA Browser 채팅 UI 개편.

## 3. 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 창구 | 슬랙 봇 1개(Socket Mode), 기존 `#sambaorder`. 기존 연동은 새 봇으로 대체 | 이미 쓰는 채널 |
| 헤르메스 | 안 씀 | 창구+큐만 필요 |
| 일꾼 PC | 사무실 PC 1대 | 잠금·폰·키마스터가 한 곳 |
| 하네스 | Python 3.12 + LangGraph **감독자(supervisor) 패턴**, 로컬 `langgraph dev` | 에이전트 추가·교체·감독이 그래프 단위로 됨 |
| 모델 | Claude **구독**(Claude Code 로그인, `claude-agent-sdk`). API 키 없음 | 지금 앱과 같은 인증. 에이전트마다 모델 어댑터 교체 가능. 구독 한도 도달 시 큐 정지·슬랙 알림 |
| 손발 | SAMBA Browser 로컬 HTTP 브릿지(127.0.0.1, 토큰) | 기존 도구 그대로 노출 |
| 잠금 | SQLite `jobs` + SAMBA-WAVE 상태 "다른 작업자 처리중" | 로컬이 진실 |
| LLMOps | LangSmith(프로젝트 dev/staging/prod, 데이터셋, 실험, 온라인 평가, 검수 큐, 프롬프트 허브, 알림) + 로컬 `releases` 표 | 요구사항: 배포/개선을 결정하는 단위 시스템 |
| 개인정보 | 고객 이름·전화·주소·이메일 마스킹 후 전송. 비밀번호·카드·토큰은 애초에 상태에 없음 | |
| 원가 규칙 | 원가 = (쿠폰·회원할인·카드 청구할인 적용, **적립금 사용 전**) − 확정 신규 적립. 실구매가 = 결제액 + 사용 적립금 − 확정 신규 적립 | 적립금 = 현금 |

## 4. 구조

```
직원(슬랙) → 슬랙 봇 → 작업 큐(잠금) → 감독자 에이전트 ─┬→ 구매 에이전트(무신사 | 29CM | ABC | 롯데온)
                                                     ├→ 결제 에이전트
                                                     ├→ 기록 에이전트
                                                     └→ 검증 에이전트
                                      모든 에이전트 → SAMBA Browser 브릿지 → 쇼핑몰·폰·SAMBA-WAVE
                                      모든 이벤트 → LLMOps 판정 시스템(LangSmith + 로컬)
```

### 4.1 슬랙 봇 (`gateway/slack_bot.py`)
- Bolt for Python, Socket Mode. 채널 `#sambaorder`. 명령: `@삼바 <주문번호> 처리해 [옵션]`, `@삼바 상태`, `@삼바 취소 <주문번호>`, `@삼바 이어서 <주문번호>`, `@삼바 진단 <주문번호>`, `@삼바 버전`(운영 중 하네스 버전·판정 결과).
- 진행 보고는 스레드에 "에이전트 이름 · 단계 · 결과" 한 줄씩. 완료·실패·사람 확인은 본문 + 담당자 멘션.
- 같은 주문을 다시 넣으면 "이미 ○○님이 처리 중(구매 에이전트 3/5)" 답장.
- 채널 밖·미등록 사용자 명령은 무시(로그만).

### 4.2 작업 큐 (`queue/`)
- SQLite `jobs(id, order_no UNIQUE, requester, options, state, assignee_agent, step, thread_ts, harness_version, created_at, updated_at, error)`.
- 상태 `queued → running → done | failed | needs_human | cancelled`. 실행기는 한 번에 1건(손발이 하나).
- 잠금 = `order_no` 유일 + 살아 있는 상태면 거절. 실행 시작 시 SAMBA-WAVE "처리중", 끝나면 결과 상태.

### 4.3 감독자 + 전문 에이전트 (`agents/`)

**감독자(supervisor)** — LangGraph 상위 그래프. LLM 이 아니라 **코드가 배정한다**(결정 근거가 남고 채점이 된다). 하는 일:
1. 큐에서 1건 집기 → SAMBA-WAVE 행 읽기·중복 검사(소싱주문번호 있으면 `done(skip)`).
2. **배정**: 등록부에서 `담당 조건(소싱처·판매처·옵션)` 이 맞는 구매 에이전트를 고른다. 없으면 `needs_human(unsupported)`.
3. 구매 에이전트 → 결제 에이전트 → 기록 에이전트 → 검증 에이전트 순으로 **넘기고 결과를 검사**한다. 각 에이전트는 `AgentResult{status: ok|fail|needs_human, payload, evidence[]}` 로만 답한다.
4. **감독 규칙**: 에이전트가 `fail` 이면 재시도 정책(에이전트별 최대 1회) → 그래도 실패면 `needs_human`; 결제 에이전트는 재시도 없음(재결제 위험); 어떤 에이전트도 감독자가 준 `assignment` 밖의 외부 시스템을 건드리지 못한다(브릿지 호출 허용 목록을 감독자가 넘긴다).
5. 사람 넘김·재개(`이어서`)는 감독자가 체크포인트로 처리. 진행 보고를 슬랙에 보낸다.
6. 실행 끝에 **판정 시스템에 결과 제출**(이벤트·증거·버전).

**전문 에이전트(worker)** — 각자 LangGraph 서브그래프. 공통 껍데기 + 개별 규칙·도구·데이터셋.

| 에이전트 | 담당 | 내부 단계 | 도구(브릿지 허용 목록) | LLM 판단 |
|---|---|---|---|---|
| 구매 `buyer.musinsa` | 무신사 | 옵션·수량 선택 → 계정별 쿠폰 비교(프로필 탭) → 배송지 결정·반영 → 결제수단·카드 확정(원가 규칙) | page.*, run_js, run_script, tabs.*, vault.login | 옵션 매칭, 계정 선택 근거, 배송 방식, 수단·카드 |
| 구매 `buyer.29cm` / `buyer.abc` / `buyer.lotteon` | 각 소싱처 | 같은 단계, 사이트별 스크립트·규칙 | 같음 | 같음 |
| 결제 `payer` | 모든 소싱처 | 결제창 진입 → 키마스터 신원정보 → 폰 승인(카드 필수) → 성공 확인 | run_script, vault.fill_secret, phone.approve_payment | 없음(코드+도구). 캡차·실패 → needs_human |
| 기록 `recorder` | SAMBA-WAVE | 계정·소싱주문번호·실구매가·배송비·메모·플래그 저장 → 각 필드 저장 확인 | run_script(samba_*), page.* | 메모 문장만 |
| 검증 `verifier` | 대조 | 소싱처 주문 상세 vs SAMBA 행 vs 감독자 기대값 대조 → 불일치 표 | run_script, page.get | 불일치 설명만 |

- **등록부** `agents/registry.yaml`: `name, kind(buyer|payer|recorder|verifier), match(소싱처·판매처 조건), tools(허용 목록), rules(규칙 파일 경로), prompts(프롬프트 허브 이름), dataset(평가 데이터셋 이름), retry(최대 재시도)`. 새 소싱처 = 구매 에이전트 1행 + 규칙 파일 + 스크립트. 감독자 코드 수정 없음.
- **에이전트 계약**(공통): 입력 `Assignment{order, options, account_candidates, evidence_so_far}`, 출력 `AgentResult`. LLM 판단은 전부 구조화 출력(Pydantic). 판단마다 `reason` 필드 필수 — 채점·진단이 이 문장을 본다.
- 확장 대비: 감독자는 `kind` 만 알고 이름은 등록부에서 고른다. 병렬 실행이 필요해지면(일꾼 PC 여러 대) 감독자만 큐를 분산하면 된다.

### 4.4 SAMBA Browser 브릿지 (`src/main/bridge/`)
- 앱 안 127.0.0.1:47811 HTTP, 헤더 `X-Samba-Token`. `GET /health`, `POST /tool/{name}`(채팅 AI 와 같은 도구 이름). 브릿지 호출 중엔 채팅 실행 거부(한 손발). 상세는 계획 1/3.
- 감독자가 에이전트마다 허용 도구 목록을 주고, 브릿지 클라이언트가 목록 밖 호출을 거절한다(권한 부족 사례의 근거).

### 4.4b 자동화 페이지 "처리 흐름"
- 해당 플레이북 카드(예: "포이즌 소싱 주문 처리") 바로 아래에 감독자 → 전문 에이전트 그래프. 하네스 `GET /graph`(등록부·단계)·`GET /jobs`(현재 배정·단계)를 5초마다 읽어 현재 위치를 색으로. 에이전트 클릭 → 규칙 파일 편집(`PUT /graph/rules/{agent}`), 저장 전 확인 카드, 다음 실행부터 반영(새 버전이 되므로 판정 시스템을 다시 통과해야 운영 반영).
- 그래프 아래에 **판정 카드**: 하네스 `GET /releases`(운영 버전·후보 버전·조건 6개 충족 여부·진단 상위 사유)를 읽어 §4.5 화면 3 과 같은 표를 보인다. 승인 버튼은 두지 않는다(승인은 슬랙 `@삼바 승인 <v>` 또는 명령줄 — 외부 반영은 사용자 검토 규칙을 따른다).

### 4.5 LLMOps 판정 시스템 (`ops/`)

목적: **버전마다 "운영 배포"인지 "디버그·개선"인지 판정을 내는 하나의 시스템.** 4단계는 파이프라인이고 결과는 판정 기록 1건이다. 4단계 중 하나라도 비면 판정은 자동으로 "개선".

**버전** `harness_version` = 감독자 코드 + 등록부 + 규칙 파일 + 프롬프트(허브 커밋) 의 해시. 무엇이든 바뀌면 새 버전. 운영 버전은 로컬 `releases(version, verdict, decided_by, decided_at, report_path, prompt_commits)` 표와 LangSmith 프롬프트 허브의 `prod` 태그가 가리킨다.

**환경** — LangSmith 프로젝트 3개: `samba-dev`(개발 실행), `samba-staging`(판정용 dry-run·평가), `samba-prod`(운영 실행). 실행기는 `HARNESS_ENV` 로 프로젝트를 고른다. 운영 실행은 `prod` 태그 프롬프트만 쓴다.

**1단계 Observe — 모든 이벤트의 상세 이력**
- LangSmith 추적(`langsmith` SDK `@traceable` + LangGraph 자동 추적): 실행 1건 = trace, 감독자 결정·각 에이전트·단계·LLM 호출·브릿지 도구 호출(도구명·인자 요약·결과 앞 500자·소요)·재시도·사람 넘김·재개·취소·큐 이벤트·슬랙 명령 전부 span/metadata.
- 태그·메타데이터(필수): `harness_version, env, order_no, source, agent, requester, job_id, prompt_commit`. 결과 span 에 `outcome(done|failed|needs_human|cancelled)`, `fail_reason`, `cost_krw`, `margin_pct`, `duration_ms`.
- 마스킹: `langsmith` 의 `hide_inputs/hide_outputs` 훅으로 고객 이름·전화·주소·이메일 `***`. 비밀값은 상태에 없다.
- 로컬 사본: 같은 이벤트를 `events.sqlite` 에 30일 보관(LangSmith 장애·회선 대비, 진단은 로컬로도 가능).
- 완료 조건: 실기 trace 3건에 위 항목이 전부 있고 마스킹 검사(정규식) 0건 검출.

**2단계 Evaluate — 오프라인 회귀 + 온라인 평가**
- 데이터셋(에이전트별): `ds.supervisor.assign`(배정 정답), `ds.buyer.<site>`(옵션·계정·배송·수단·카드·원가), `ds.payer`(카드 지정·거절 사례), `ds.recorder`(필드 값), `ds.verifier`(불일치 판정). 예시 = 그 에이전트의 입력 스냅샷 + 기대 출력. **성공·실패 사례 둘 다**: 품절·마진 미달·카드 없음·캡차·중복·권한 부족·브릿지 끊김은 "기대 = 올바른 거절/넘김".
- 예시 공급: (a) 실기 실행 → 슬랙 ✅ → 데이터셋 자동 추가(`Client.create_examples`), (b) 검수 큐(Annotation queue)에서 사람이 고친 답, (c) 초기 20건은 지난 실기 기록으로 수작업.
- 채점기(`ops/evaluators.py`, LangSmith `evaluate()`): 정확 일치(배정·계정·배송·수단·카드·최종 상태), 원가 ±1%, 안전(결제 진입 시 카드 없음 0건, 거절돼야 할 사례에서 결제 시도 0건, 허용 목록 밖 도구 호출 0건), LLM 채점(`reason` 타당성, Claude 구독으로), 소요·도구 호출 수 회귀(직전 운영 대비 +30% 초과면 감점).
- 오프라인: `python -m ops.eval --version <v>` → 에이전트별 실험(`samba-staging`), 실험 메타데이터에 `harness_version`. 브라우저 없이 스냅샷으로 돈다.
- **온라인 평가**(LangSmith Online evaluators/Rules): `samba-prod` trace 의 `outcome`·`fail_reason`·안전 채점을 실행마다 자동 채점, 실패는 검수 큐로 자동 이관.
- 완료 조건: 에이전트별 데이터셋 각 ≥ 10건(실패 사례 포함), 채점기 5종 동작, 실험 링크 생성.

**3단계 Diagnose — 실패 원인 표**
- `python -m ops.diagnose --version <v> [--since 7d]` 및 슬랙 `@삼바 진단`: LangSmith 실험·prod trace 를 읽어 표 생성 — 에이전트별·단계별 실패율, 상위 실패 사유, 재시도 횟수, 소요 분포, 직전 운영 버전 대비 차이, 실패 예시 링크. 검수 큐 미처리 건수.
- 실패 사유는 코드 enum(`out_of_stock, margin, card_missing, captcha, bridge_down, permission_denied, duplicate, verify_mismatch, unknown`)으로 고정 — 표가 안정된다.
- 완료 조건: 표 1개 + trace 링크. "어느 에이전트의 어느 규칙을 고칠지"가 표에서 읽힌다.

**4단계 Decide — 배포/개선 판정**
- `python -m ops.gate --version <v>` 가 1~3단계 산출물을 읽어 판정한다. 규칙:
  1. Observe 완료 조건 충족.
  2. 에이전트별 정확도 ≥ 직전 운영 버전(하락 0), 안전 채점 100%, 실패 사례 데이터셋 전 건 통과.
  3. 소요·도구 호출 회귀 없음(+30% 이내).
  4. staging dry-run 실기 1건 통과(결제 에이전트는 dry_run).
  5. 검수 큐에 미처리 "차단" 항목 0건.
  6. **사용자 승인**(슬랙 `@삼바 승인 <v>` 또는 명령줄 `--approve`). 자동으로 운영에 올라가지 않는다.
- 판정 결과 `verdict: promote | improve` 를 `releases` 표와 LangSmith 실험 메타데이터에 기록. `promote` 면 프롬프트 허브 `prod` 태그 이동 + 실행기 `HARNESS_ENV=prod` 재시작. `improve` 면 진단 표의 상위 사유가 "다음 할 일"로 슬랙에 게시.
- 롤백: `ops.gate --rollback` 이 직전 `promote` 버전으로 태그를 되돌린다(사람이 실행).
- 운영 감시(알림): LangSmith Alerts — `samba-prod` 실패율(24h) 직전 대비 2배, `needs_human` 비율 30% 초과, 평균 소요 +50% → 슬랙 알림 + 진단 표 자동 첨부. 자동 롤백 없음.

**한 화면 요약**
```
Observe(trace·로컬 events) → Evaluate(오프라인 실험 + 온라인 채점 + 검수 큐) → Diagnose(원인 표) → Decide(gate → promote|improve, 사용자 승인)
```

## 5. 데이터 흐름(정상 1건)
1. 직원 `@삼바 734501000740906 처리해 현대카드` → 큐 삽입(잠금) → 접수 답장.
2. 감독자: 행 읽기·중복 검사 → 등록부에서 `buyer.musinsa` 배정.
3. `buyer.musinsa`: 옵션 → 계정별 쿠폰 비교 → 배송지 → 수단·카드(`현대`) 확정 → `AgentResult{ok, payload{account, card, cost, margin}}`.
4. 감독자 검사(카드 있음·마진 통과) → `payer` 에 결제 배정 → 폰 승인 → 성공.
5. `recorder` 저장 → `verifier` 대조 → 감독자 `done` → 슬랙 결과 표 + ✅ 반응 요청.
6. 전 과정 trace(`samba-prod`) → 온라인 채점 → ✅ 시 데이터셋 예시 추가.

## 6. 오류 처리
- 브릿지 실패(20초 타임아웃·앱 꺼짐): 에이전트 `fail(bridge_down)` → 감독자 재시도 1회 → `needs_human`. 봇이 앱 상태 30초 감시.
- 구조화 출력 실패: 재요청 1회 → `needs_human`.
- 결제 후 기록 실패: 재결제 절대 없음. `needs_human("결제됨, 기록만 남음")`.
- 실행기 재시작: 체크포인트에서 재개. 결제 에이전트 진행 중이었으면 재개 없이 `needs_human`.
- 취소: 에이전트 경계에서만. 결제 에이전트 진입 후 취소 불가.
- 권한 부족: 허용 목록 밖 도구 호출·키마스터 잠김·계정 접근 거부 → `fail(permission_denied)` → `needs_human`, 재시도 없음.
- 중복: 큐가 거절. 감독자도 시작 시 SAMBA-WAVE 소싱주문번호 재검사.

## 7. 검증 계획

각 단계는 **완료 조건**과 **다음 단계 진입 조건**을 나눈다. 성공만이 아니라 **실패·재시도·중복 요청·권한 부족**을 단계마다 검증한다.

| 단계 | 검증 항목(성공 / 실패 / 재시도 / 중복 / 권한) | 완료 조건 | 다음 단계 진입 조건 |
|---|---|---|---|
| ① 브릿지 | 도구 호출 / 없는 도구·JSON 오류·도구 예외 / 90초 초과 뒤 세션 정리 / 동시 요청 두 번째 409 / 토큰 없음·틀림 401, 채팅 실행 중 409 | 단위 테스트 전부 + curl 3건 | 사용자가 브릿지 켜고 health 확인. 외부 변경 없음 |
| ② 큐·감독자 뼈대 | 접수→배정→완료(가짜 에이전트) / 에이전트 fail→재시도→needs_human / 재시작 재개 / 같은 주문 2회 → 거절 / 허용 목록 밖 도구 → permission_denied | pytest 분기표 전부 | 사용자 검토(배정·재시도·권한 규칙) |
| ③ 전문 에이전트 | 에이전트별 정상 / 품절·마진·카드 없음·배송지 실패 / 재시도 1회 / 중복 구매 검사 / 키마스터 잠김·계정 거부 | 에이전트별 테스트 + 원가 규칙 테스트 | 사용자 검토(규칙 파일) |
| ④ 슬랙 봇 | 명령 6종 / 잘못된 명령·없는 주문 / 슬랙 재연결 / 두 직원 동시 접수 / 미등록 사용자 무시 | 테스트 채널 왕복 | **사용자 검토 후** #sambaorder 초대(외부 변경) |
| ⑤ LLMOps 1~2단계 | trace 항목 전부 / 마스킹 0건 / LangSmith 끊김 시 로컬만 남고 실행 계속 / 중복 전송 없음 / 키 틀림 → 경고만 / 데이터셋·채점기·온라인 평가 동작 | 실기 trace 3건 + 실험 1회 | 사용자 검토(나가는 데이터 항목 표) |
| ⑥ 실기 | 무신사 dry-run → 1건 끝까지 → ABC·29CM / 결제 실패·캡차 → needs_human → 이어서 / 재개 / 재요청 거절 / 키마스터 잠근 채 시도 → 거절 | 각 사이트 1건 + SAMBA 기록 검증 | **결제·기록은 매 건 사용자 승인 뒤**(dry-run 검토 → 승인 → 실제) |
| ⑦ LLMOps 3~4단계 시연 | 기준 판정 / 규칙 고장 → 점수 하락·실패 목록·`improve` / 복구 → `promote` 후보 / 실패 사례 전 건 / 안전 100% / 알림 발화 | `ops/reports/<v>.md` + releases 기록 | 사용자 승인으로 첫 `promote` |

## 8. 저장소 구성
```
samba_browser/            (기존, 브릿지: src/main/bridge/, 흐름 화면: components/automation/FlowGraph.tsx)
samba-agent/              (신규, Python)
  gateway/slack_bot.py
  queue/{db.py, worker.py}
  supervisor/{graph.py, assign.py, policy.py}
  agents/{registry.yaml, base.py, buyer_musinsa.py, buyer_29cm.py, buyer_abc.py, buyer_lotteon.py, payer.py, recorder.py, verifier.py}
  rules/{buyer_musinsa.md, ..., payer.md, recorder.md}
  bridge/client.py
  ops/{tracing.py, masking.py, datasets.py, evaluators.py, eval.py, diagnose.py, gate.py, alerts.py, reports/}
  tests/
  .env.example            (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, LANGSMITH_API_KEY, SAMBA_BRIDGE_URL, SAMBA_BRIDGE_TOKEN, HARNESS_ENV)
```

## 9. 남는 위험
- 브릿지가 앱 안에 있어 앱이 꺼지면 전부 멈춤 → 봇 감시·알림.
- 폰 승인은 실기 의존. 결제 에이전트 실패는 needs_human 으로 흡수.
- 마스킹은 정규식 — 새 형식은 규칙 추가. LangSmith 에는 마스킹된 주문·금액·판단 근거가 나간다(미국 클라우드).
- 감독자를 코드로 두어 유연성은 줄지만 판정 가능성이 생긴다. 새 종류의 에이전트(예: 반품)는 `kind` 추가가 필요.

## 10. 진행 규칙
1. **외부 시스템을 실제로 바꾸기 전에는 반드시 사용자가 검토한다.** 대상: 슬랙 채널 봇 초대·기존 연동 제거, Supabase 표·정책, 쇼핑몰 주문·결제, SAMBA-WAVE 기록, LangSmith 로 나가는 데이터 항목, 프롬프트 허브 `prod` 태그 이동. 검토 전에는 dry-run·가짜 백엔드·테스트 채널·staging 만 쓴다.
2. **단계마다 완료 조건과 다음 단계 진입 조건을 구분해 제시한다**(§7). 진입 조건에 "사용자 검토/승인"이 있으면 답을 받기 전에는 시작하지 않는다.
3. **성공 사례만 검증하지 않는다.** 실패·재시도·중복 요청·권한 부족을 테스트와 데이터셋 양쪽에 넣는다.
4. **운영 배포는 판정 시스템(§4.5 Decide)을 통과하고 사용자가 승인한 버전만.** 자동 승격·자동 롤백 없음.
