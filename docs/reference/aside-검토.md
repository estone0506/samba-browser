# Aside 브라우저 실물 검토 (v1.0.914.1, 2026-09-18)

이 PC에 설치된 Aside를 직접 열어 화면·설정을 확인한 결과. 삼바브라우저에 가져올 것 / 우리가 더 해야 할 것 정리.

## 1. 엔진·구조 (설치 폴더 분석)

- **Chromium 소스 포크**(Electron 아님). 설치 파일 구성이 Microsoft Edge와 동일(`Microsoft.UI.Xaml`, `WebView2Loader`, `MRM.dll`, `aside_migrator.exe`) → Edge 코드베이스를 통째로 개조한 "자동차 공장" 방식. 개발 인력 많은 회사만 가능.
- 별도 구성요소: `AsidePasswordManager`(Vault), `AsideAgentManager`(에이전트), `AsideDaemon`(백그라운드), `aside_proxy.exe`, `aside_migrator.exe`(타 브라우저 가져오기), `CaptchaProviders/`(캡차 처리 연동 흔적), PWA 런처.
- 결론: 우리는 Electron이 맞음. 기능은 참고하되 구현 방식은 다름.

## 2. 화면 구성

| 영역 | 내용 |
|---|---|
| 왼쪽 사이드바 | 북마크 폴더 트리(작업 공간처럼 사용: 데이터분석·리셀·소싱처·쇼핑…), 아래 Chats 목록 + New Chat |
| 상단 우측 아이콘 | 🔥 에이전트, 🔑 Vault 팝업, 🧩 확장 |
| 새 탭 | 검색/URL 입력(Search ↔ Ask 전환), **Chats | Routines** 카드, "Show suggested tasks" |
| 로고 메뉴 | Profiles(다중 프로필) · New profile · Bookmarks · Downloads · Extensions · History · Developers · Settings(Ctrl+,) · New Tab · Incognito |
| Vault 팝업 | 계정 검색, "All accounts" 금고 선택, This Week 그룹, 오른쪽 상세(아이디·가려진 비밀번호·Website URL) |
| Codex 연결 배너 | "Connect Aside to Codex — Use Aside's browsing agent directly from Codex" |

## 3. 설정 메뉴 전체 지도

```
Personal   General · Appearance · Account · Plan & Usage · Security & Privacy
Agent      Agents · Projects · Models · Plugins & MCPs · Memory(Overview/History) · Context Awareness(Configure)
Features   Passwords · Routines · Channels · Developers · Mini popup · Lasso
기타       Archived chats · Send feedback · Extensions · Docs · Community
```

### General
기본 브라우저 설정, 계정(구글 로그인), 초대, 기본 검색엔진(네이버), 새 탭 모드(Search/Ask), PiP, 스크린샷, 언어, 맞춤법. **Import: "Import from another browser"(히스토리·쿠키·북마크·비밀번호) + "Import bookmarks"**. 이 PC에선 감지된 브라우저 목록이 비어 있었음(크롬·웨일 실행 중이라 잠긴 듯).

### Models ★
- Providers: **Aside(Free) · Claude(Subscription) · ChatGPT(Subscription) · + Connect**
- **Task models — 작업 종류별 모델 지정**: Default(GPT-6 Astra) · Fast(Haiku 4.5: 빠르고 싼 작업) · Standard(Sonnet 5: 백그라운드·메모리) · Deep(GPT-5.6: 계획·판단·합성) · **Visual(Sonnet 5: 이미지·스크린샷·CAPTCHA·페이지 해석)** · Image generation

### Agents
작업 완료 알림(Everything), 완료 사운드, 후속 지시 처리(Queue: 실행 중이면 큐에 쌓음), 탭 전환 시 새 채팅, **에이전트가 연 탭 15분 후 자동 정리**, 샌드박스, 파일 권한(볼 수 있는 폴더 / 편집 가능 폴더).

### Passwords(Vault) ★
- 기본 비밀번호 관리자 사용 토글 / 외부 관리자 연결
- 자동 잠금(1주) · **AI 에이전트 접근 정책: "While unlocked"**
- Vaults(1개, 1,619 항목) · **Import: 1Password · Bitwarden · Proton Pass · Dashlane · LastPass · CSV** · Export CSV/JSON
- Autofill 켜기 · **자동 제출(Auto-submit after autofill)** · 시크릿 모드 제외 · URL 매칭(Domain)

### Security & Privacy
방문 기록 삭제/보기, 광고·추적 차단 + 필터, 서드파티 쿠키, 사이트 권한, DNS/SSL/Safe Browsing.

### Plan & Usage
Free, 월 500 크레딧, 추가 구매, 자동 충전. 월별 사용량 표.

### 기타
- **Routines**: 반복 실행 작업("Every hour"). 우리 "자동화"와 동일 개념.
- **Channels**(Pro): Slack·Discord·Telegram에서 원격 지시.
- **Plugins & MCPs**: Skills 탭(내 스킬 + 내장 13개: Chrome, DOCX, Google Docs/Gmail/Sheets, Notion, PDF, PPTX, Slack, XLSX…) / MCPs 탭 / Import.
- **Memory / Context Awareness**: 브라우징 활동을 기록해 나중에 에이전트가 참조.
- Mini popup, Lasso(화면 영역 지정 질문), Developers.

## 4. 삼바브라우저에 가져올 것 (채택)

| 항목 | 반영 |
|---|---|
| 작업 종류별 모델 지정 (Fast/Standard/Deep/Visual) | 설정 → AI 제공자 + 작업별 모델. 재생 실패 복구=Fast, 계획=Deep, 폰 화면 읽기=Visual |
| Vault 접근 정책 + 자동 잠금 + 자동 제출 | Vault 설정에 그대로 |
| 비밀번호 가져오기 (CSV·1Password·Bitwarden·크롬/웨일 브라우저) | 계정 화면 Import. 1순위 크롬/웨일/엣지 직접, 2순위 CSV |
| 브라우저 가져오기 (북마크·히스토리·쿠키) | 설정 → 가져오기. 첫 실행 마법사에도 |
| 다중 프로필 | 이미 계획(계정=프로필) |
| Routines = 자동화, Chats 목록 사이드바 | 이미 계획 |
| 에이전트 탭 자동 정리, 완료 알림·사운드, 후속 지시 큐 | 작업 설정에 추가 |
| Skills/MCP 플러그인 화면 | 추후(2차 버전) |
| 광고 차단 | 추후 |
| Channels(텔레그램에서 지시) | 추후 — 폰 알림 대체 가능 |

## 5. 우리가 더 하는 것 (Aside에 없음)

- 폰 3대 연동(화면·터치), 문자 인증 자동 입력, ARS 전화 인증
- Vault에 **결제비밀번호·카드·여권·신분증** + 결제 흐름 학습 (Aside는 로그인 자격증명 위주)
- 기록·재생(AI 호출 절감) — Aside Routines는 매번 AI 실행
- 계정별 탭 배지·비교 흐름, 작업 예외 규칙(메모+다음)
- PC/모바일 전환 버튼(웨일 방식)
- 동일 계정 다중 PC 동기화 명시(Supabase)

---

## 6. 2차 검토 (나머지 화면 전부, 2026-09-18 오후)

| 화면 | 내용 | 우리 반영 |
|---|---|---|
| **Appearance** | 테마(System), 줌, 탭 스타일(San Francisco/New York), 새 탭 위치, 사이드바 최근 채팅 수, **사이드바 구성 선택(Chats, Bookmarks)**, 탭 전환 순서, 키보드 단축키(사이드바 토글·Ask·새 작업·URL 복사·탭 분할) | 설정→모양: 테마·줌·사이드바 구성·단축키. 사이드바에 북마크 트리 옵션 |
| **Account** | 아바타·이름·이메일, **기기 목록**(7대, 마지막 활동·버전), 브라우저 데이터 복구 토글, 위험 구역(계정 삭제) | 계정 화면에 기기 목록 + 원격 로그아웃(Supabase 세션) |
| **Projects** | 비어 있음(Create만). 작업 묶음 단위 | 자동화 레시피 그룹으로 대체 |
| **Routines** | Free 플랜 활성 3개 제한, 루틴 토글·주기("Every hour"), **"반복 작업에서 루틴 찾기 → 히스토리 스캔"** 제안 | 자동화: Free 3개 제한(요금제표와 일치), 히스토리 기반 레시피 추천 |
| **Memory** | 파일 기반 마크다운 메모리: `episodic/날짜.md`, `projects/`, `users/`, `sites/`, `routines/`, `MEMORY.md`, `USER.md`, `TAXONOMY.md`. 에피소드에 시각·요약·근거(sessions.get 참조) 기록. **History**: 세션별 트리거·소요·모델·토큰(in/out)·캐시율·비용·변경 파일·요약 | 메모리 모듈을 사이트별/사용자별 마크다운으로 설계(F16). 로그 화면에 세션별 토큰·비용 표시 |
| **Developers** | Aside CLI(Codex/Claude Code에서 웹 작업 실행), Skills·MCP 서버(Aside를 MCP 서버로 노출), 원격 제어(Pro), FAQ | 2차: 삼바브라우저 MCP 서버 노출(외부 에이전트가 우리 브라우저 조작) |
| **Mini popup** | 단축키로 어디서나 채팅 팝업 | 추후 |
| **Lasso** | 텍스트 드래그/영역 원 그리기 → 요약·번역·단축 동작(Alt+Alt) | 추후 |
| **Extensions** | 크롬 확장 설치 가능(ShopBack 캐시백 설치돼 있음) | Electron도 크롬 확장 로드 가능(제한적). 2차 |
| **채팅 실행 화면** | 채팅이 **탭으로 열림**("Chats" 탭), 단계 묶음 "Worked for 9m 53s", 산출물 카드(ZIP 다운로드), Share, 입력창 하단에 Project·Guard·모델 선택 | 사이드바 패널 외에 "채팅을 탭으로 크게 보기" 옵션. 입력창에 모델 선택·안전모드(Guard) 토글 |
| 사이드바 | 상단 북마크 폴더 트리(작업공간처럼), 하단 최근 채팅 3개 + New Chat | 우리 IA에 북마크 트리 추가(Appearance 설정으로 표시 선택) |

### 결론 보강
- Aside 메뉴가 "단순"해 보이는 이유: 설정 안에 기능이 다 들어가고 사이드바는 북마크+채팅만. 우리도 사이드바 7개 메뉴를 **브라우저 / 채팅 / 북마크**(+설정 안에 작업·자동화·개인정보·폰·로그)로 줄이는 안 검토 → 5차 UI에서 결정.
- 멀티 기기 동기화(Account→Devices)는 Aside도 있음. 우리 Supabase 설계와 동일 방향.
- 세션 비용 가시화(History)는 SaaS 크레딧 모델에 필수 → 로그 화면 요구사항에 추가.

### 추가 관찰 (채팅 입력창 Guard 메뉴)
- 입력창 하단 **Guard 권한 모드**: Read only(읽기만) / Guard(위험 행동 확인) / Full access(자동) + **Final confirm** 토글(마지막 단계 확인). → 삼바 2단계 설정·채팅 입력창에 동일 개념 도입(현재는 Guard 고정).

### Vault 등록·필터 UI (팝오버 실물)
- **+ 새 항목**: Login / Password / Credit Card / Secure Note / Identity / Document / More › · 비밀번호 생성기 · Import…
- 목록: 검색, 금고 선택(All accounts), **Suggestions**(현재 사이트 계정 자동 필터), This Week(최근 사용)
- 상세: Personal › Personal, **Autofill 버튼**, Credentials(Username·••••), Website(로그인 URL)
- 삼바 반영: 항목 6종 재편(로그인/비밀번호/신용카드/보안메모/신원정보/문서), + 메뉴 동일, 추천 섹션, 자동 채우기 버튼, 툴바 열쇠 팝오버 (2단계 Task 11)
- **New Login 폼**: 금고 선택(Personal) · Cancel/Save · 제목 New Login + 부제 **현재 사이트 호스트 자동** · Credentials(Username, Password + 생성 버튼 ↻) · Website(**현재 URL 자동 입력** + 도메인/전체URL 전환 ⇄ + **URL 추가**로 여러 URL) → 삼바 Task 11: 로그인 추가 시 현재 탭 호스트/URL 자동, 비밀번호 생성, 계정당 URL 여러 개(sites.loginUrl → login_urls 목록)
- **New Credit Card 폼**: 섹션(Section 이름) 단위 필드 그룹, 드래그 핸들(≡)로 필드 순서 변경, 필드: cardholder name · type(선택) · card number · CVC · (만료 등). 1Password 식 "섹션+필드" 스키마 → 삼바 Task 11: 카드 항목 필드(소유자·카드사/종류·번호·유효기간·CVC·결제비밀번호), 필드 단위 암호화(값별 ciphertext) 고려
