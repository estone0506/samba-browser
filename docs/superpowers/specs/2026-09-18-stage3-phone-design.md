# 3단계 설계: 폰 연동 + 문자 인증 자동 입력 + 간편결제 앱 승인

작성일: 2026-09-18 · 상태: 초안 · 선행: [2b 동기화·AI 설정](2026-09-18-stage2b-sync-ai-settings-design.md)

## 목표

안드로이드 폰 3대를 브라우저 안으로 끌어와 **본인인증 문자와 간편결제 앱 승인까지 사람 손 없이** 끝낸다. PRD §12 3단계 완료 기준은 "인증 문자 → 자동 입력 성공, 토스 결제 1건 앱 승인까지 완료".

## 범위

포함: ADB 장치 관리, scrcpy 화면 스트림, 터치·키 전달, 폰 UI 트리 읽기, 폰 AI 도구 6종, SMS 인증번호 자동 입력, 간편결제 앱 승인 흐름, 권한·안전장치, 폰 패널 UI, 설정, `phones`·`auth_events` 테이블.
제외: ARS 전화 인증(5단계), 기록·재생(4단계), 아이폰(범위 밖).

## 하드웨어 전제

- 안드로이드 폰 3대(한/중/일 유심), 각 폰에 **USB 디버깅 1회 활성화**(개발자 옵션) + PC RSA 키 승인. 이 승인은 사람이 폰에서 직접 한다(자동화 불가).
- `adb.exe`, `scrcpy.exe` 는 PATH 미등록, 전체 경로 사용. 기본값 `C:\Users\canno\Downloads\pt\platform-tools\adb.exe`, `...\scrcpy-win64-v4.1\scrcpy.exe` (설정에서 변경).
- **삼성 폰은 문자 DB(`content://sms/inbox`) 접근이 막힐 수 있음** → 차단 확인 시 자동으로 화면 읽기 폴백(아래 SMS 절 참조). 앱 시작 시 폰별로 1회 시험 조회해 `phones.smsQueryOk` 에 기록.
- 폰 화면 항상 켜짐(`svc power stayon usb`) 권장, 화면 잠금 PIN 은 사용자가 해제해 두거나 금고의 `device_pin` 으로 잠금 해제.

## 핵심 결정

| 결정 | 선택 | 이유 |
|---|---|---|
| 장치 감지 | `adb devices -l` **5초 폴링** | PRD 04 배치표 그대로. 이벤트 API 없음 |
| 연결 방식 | USB + WiFi(`adb connect ip:5555`) 병행 | 책상 밖 폰도 사용 |
| 끊김 복구 | `kill-server && start-server` **1회만** 자동 → 실패 시 폰 카드 회색 + 사용자 알림 | 무한 재시도 금지 |
| 식별 | `serial` 이 키, 사용자 지정 **별칭·국가**(KR/CN/JP) 매핑 | 인증 문자 올 폰 고르기 |
| 화면 | scrcpy 4.1 **폰별 프로세스**, 옵션 `--video-codec=h264 --max-size=720 --max-fps=15 --no-audio --stay-awake --video-bit-rate=2M` | 3대 동시에도 CPU·대역 여유. 720px 이면 uiautomator 좌표 환산도 단순 |
| 스트림 방식 | **(b) raw h264 를 stdout 파이프 → 렌더러 `<video>`(WebCodecs 디코드)** 채택, 폴백 **(c) 주기 스크린샷** | 아래 비교표 |
| 터치·키 | 1순위 `adb shell input tap/swipe/text/keyevent`, 2순위 scrcpy 컨트롤 소켓 | input 은 단순·안정. 한글 입력 등 `input text` 실패 시 컨트롤 소켓 |
| 화면 이해 | `uiautomator dump` → 요소 목록, **웹 DOM 스냅샷과 같은 번호 체계** | AI 가 웹과 폰을 같은 방식으로 다룸 |
| SMS | `content query --uri content://sms/inbox` **1초 폴링(인증 대기 중에만)** | PRD 04. 평시 폴링 없음 |
| 인증번호 추출 | 최근 3분 내 수신, 본문에서 **4~8자리 숫자** 정규식, 사이트명/발신번호로 가중치 | 오탐 방지 |
| 폰 선택 | 담당 폰 고정 없음, **3대 동시 감시 → 먼저 온 폰** 사용. 계정에 담당 폰 지정 시 그 폰 우선 | PRD 04 Phone |
| 실패 폴백 | 스크린샷 → **Visual 모델**(로컬 Qwen2.5-VL-3B-Instruct-GGUF 또는 2b 에서 지정한 클라우드 Visual 모델) | HF 조사 문서 1순위 |
| 결제 비밀번호 | 값은 **모델에 절대 안 감**. 금고 `payment_password` 를 앱이 키패드 좌표로 터치 | PRD F4·HF 문서 "보안 키패드 처리 방식" |
| 결제 안전 | 결제 단계는 권한 모드와 무관하게 **guard 확인 카드** 1회 | PRD F11 |

### 영상 스트림 방식 비교

| | 방식 | 장점 | 단점 | 판정 |
|---|---|---|---|---|
| a | scrcpy 창을 그대로 띄우고 좌표만 제어 | 구현 0, 지연 최소 | 앱 패널 안에 못 넣음(별도 창), 창 위치·포커스 관리 취약, 사용자 경험 나쁨 | ✗ |
| b | `scrcpy --no-window` 계열로 **raw h264 를 stdout** → 메인이 청크를 IPC 로 전달 → 렌더러가 **WebCodecs `VideoDecoder`** 로 디코드 후 `<canvas>`/`<video>` 표시 | 패널에 자연스럽게 삽입, 지연 낮음(35~70ms), 3대 동시 | 구현량 있음, scrcpy 버전별 출력 옵션 확인 필요, 키프레임 대기 로직 필요 | **추천** |
| c | `adb exec-out screencap -p` 를 0.5~1초 주기로 받아 `<img>` 교체 | 가장 단순, scrcpy 불필요 | 동영상 아님(끊김), CPU·대역 부담, 터치 반응 확인 늦음 | **폴백** |

(b) 가 첫 키프레임을 5초 안에 못 받거나 디코더 초기화에 실패하면 자동으로 (c) 로 내려가고 폰 카드에 "간이 화면" 배지를 띄운다.

## 폰 UI 트리

`adb shell uiautomator dump /sdcard/ui.xml && adb exec-out cat /sdcard/ui.xml` → XML 파싱 →

```
PhoneElement { id(번호), text, resourceId, contentDesc, className, clickable, bounds{l,t,r,b}, center{x,y} }
PhoneScreen  { serial, w, h, app(현재 패키지), elements[≤120] }
```
- 번호 매기기·개수 상한·직렬화는 웹 `PageSnapshot`/`serializeSnapshot`(`src/shared/snapshot.ts`)과 **같은 규칙**을 재사용해 `src/shared/phone-snapshot.ts` 로 둔다.
- `password=true` 또는 `resourceId` 가 핀/비밀번호류인 노드는 값 필드를 비운다(웹의 `isSecret` 과 동일).
- dump 실패(일부 게임·보안 앱)면 스크린샷 + Visual 모델 경로로 전환.

## AI 도구 (기존 `src/main/agent/tools.ts` 에 추가)

| 도구 | 입력 | 출력(AI 가 보는 것) |
|---|---|---|
| `phone_get_screen` | `{phone?}` | `PhoneScreen` 직렬화 텍스트(요소 번호 목록) |
| `phone_tap` | `{phone?, elementId}` 또는 `{phone?, x, y}` | `'ok'` / `'not found'` |
| `phone_type` | `{phone?, text}` | `'ok'` — 비밀값은 이 도구로 넣지 않음 |
| `phone_key` | `{phone?, key}` (back/home/enter/power…) | `'ok'` |
| `phone_swipe` | `{phone?, from, to, ms?}` | `'ok'` |
| `phone_screenshot` | `{phone?}` | 이미지(Visual 모델 전용). 일반 모델에는 요약 텍스트만 |

`phone` 생략 시 현재 작업에 배정된 폰. 도구 호출도 기존 작업당 40회 상한에 함께 계산.

## SMS 인증 자동 입력

1. 웹 페이지에서 인증번호 입력칸 감지 — 스냅샷 요소 중 `type=tel|number`, `autocomplete=one-time-code`, 라벨/placeholder 에 "인증번호·확인번호·verification·code" 포함 → 후보 선정
2. 인증 대기 상태 진입 → **폰 3대 동시 1초 폴링** 시작 (`auth_events` 에 `kind='sms'` 행 생성)
3. 새 수신 문자 중 3분 내 + 4~8자리 숫자 → 사이트명/발신번호 매칭 점수가 가장 높은 것 선택
4. 웹 입력칸에 `fillValue`(2단계 preload 함수)로 입력 → 자동 제출 설정(`vaultAutoSubmit`)에 따라 제출
5. **3분 타임아웃**(PRD §9) → 폴링 중단, 스크린샷 → Visual 모델에게 "화면에 보이는 인증번호"만 질의 → 성공 시 4번, 실패 시 사용자 확인 카드
6. 성공/실패·소요 시간을 `auth_events` 에 기록(KPI 무인 처리율 집계)

문자 본문 전체는 로그에 남기지 않고 **추출된 숫자와 발신번호 뒷 4자리만** 기록한다.

## 간편결제 앱 승인 흐름 (토스·페이코·카카오페이·네이버페이)

공통 절차로 설계하고 사이트·앱별 차이는 데이터로 둔다.

1. **웹 결제창**: 결제 수단 선택 → 결제창이 **팝업(별도 WebContents)** 으로 열리는 경우가 많다(메모리 관찰 예: NICE ePAY 가 `m.niceepay.com:7006/epay/pinCert.do` 별도 창). → 팝업 WebContents 도 탭 매니저에 등록해 **스냅샷·조작 대상에 포함**한다.
2. **폰으로 넘어감**: 앱 푸시 또는 딥링크(`supertoss://`, `kakaotalk://`…). 푸시 도착을 기다리지 말고 `phone_get_screen` 으로 잠금화면/알림을 확인, 필요하면 알림 탭 또는 `adb shell am start -a android.intent.action.VIEW -d <딥링크>`.
3. **앱 화면 진행**: UI 트리로 "결제하기 / 확인 / 다음" 버튼을 텍스트·resourceId 로 찾아 `phone_tap`.
4. **결제 비밀번호 입력** — 값은 모델에 가지 않는다.
   - 앱 키패드가 uiautomator 로 숫자 노드를 노출하면 그 노드의 `center` 좌표를 쓴다.
   - 노출하지 않으면(보안 키패드) 스크린샷을 **Visual 모델에 보내 "숫자 → 좌표 배치"만** 얻는다. 모델에게 주는 질문은 "0~9가 각각 어디 있는지"이며 **어떤 숫자를 눌러야 하는지는 묻지 않는다**.
   - 메인 프로세스가 금고에서 `payment_password` 를 복호화해 자릿수만큼 해당 좌표를 `input tap` 한다. 값은 IPC·로그·모델 어디에도 없다.
   - 진행 확인은 화면의 **● 자리수 표시** 개수로 한다(자리수는 보이고 값은 안 보임).
5. **결과 확인**: 앱 완료 화면 + 웹 팝업의 성공 리다이렉트 둘 다 확인해야 성공으로 본다.
6. **실패 시**: 즉시 중단, 사용자에게 스크린샷과 함께 통지. 비밀번호 오입력이 의심되면 **재시도하지 않는다**(계정 잠금 방지).

## 권한·안전

- 폰 도구도 기존 권한 모드(`PERMISSION_MODES`)를 그대로 적용: `read_only` 는 `phone_get_screen`·`phone_screenshot` 만 허용, `phone_tap/type/key/swipe` 거부. `guard` 는 결제 앱 패키지에서의 조작에 확인 카드.
- **결제는 권한 모드와 무관하게 확인 카드 1회**(금액·가맹점·결제수단 표시). 결제 상한(기본 50만원) 초과 시 무조건 사람 확인.
- **소액 테스트 규칙**: 새 사이트/새 결제수단 조합의 첫 자동 결제는 **1만원 이하** 건으로만 수행하고 성공 기록이 있어야 일반 금액으로 확장한다.
- 폰 화면 스크린샷은 작업 로그에 저장하되 결제 비밀번호 입력 화면은 저장하지 않는다(자리수 표시만 있는 화면도 제외).
- 금고 잠금 상태에서는 결제 비밀번호 터치 자체를 거부하고 잠금 해제를 요청한다.
- `phone_type` 으로 비밀값을 넣는 경로는 코드상 차단(금고 값은 전용 내부 함수만 접근).

## 폰 패널 UI

- 오른쪽 채팅 아래 폰 카드 3장(별칭·국가 배지·연결 상태). 클릭하면 확대.
- **인증 대기 진입 시 해당 폰 카드 자동 펼침 + 테두리 강조**, 완료 시 접힘.
- 화면 위 클릭·드래그 → 좌표 환산해 `input tap/swipe`(사용자 수동 조작 가능).
- 끊김: 회색 처리 + "재연결" 버튼(내부적으로 kill/start-server 1회 재시도).
- 간이 화면(폴백 c) 사용 중이면 배지로 알림.

## 설정 (설정 → 폰)

adb 경로 · scrcpy 경로 · 경로 자동 탐지 버튼 · 폰 목록(별칭·국가·담당 계정·WiFi 주소) · 화면 품질(720/1080, fps) · 자동 재연결 · **Pro 요금제 3대 제한**(Free 는 폰 연동 없음, PRD §7-1).

## 데이터

```
phones       id, serial(unique), label, country('KR'|'CN'|'JP'), transport('usb'|'wifi'),
             wifiAddress?, smsQueryOk(boolean), lastSeenAt, workspaceId
auth_events  id, jobId?, phoneId, kind('sms'|'app_approve'), siteHost, ok,
             method('sms_query'|'visual'|'manual'), elapsedMs, at
```
`phones` 는 **PC별 정보라 동기화하지 않는다**(기술스택 §4 "폰 연결 정보는 PC별"). `auth_events` 는 KPI 집계용 로컬 기록.

## 모듈

- `src/main/phone/` — `adb.ts`(경로·명령 래퍼·5초 폴링), `scrcpy.ts`(프로세스·h264 파이프·폴백), `input.ts`(tap/swipe/text/key), `uitree.ts`(dump·XML 파싱), `sms.ts`(폴링·인증번호 추출 — 순수 추출 함수는 단위 테스트), `pay.ts`(간편결제 흐름 상태기계), `service.ts`(폰 배정·이벤트 기록)
- `src/shared/phone-snapshot.ts` — `PhoneElement`·`PhoneScreen`·직렬화(웹 스냅샷과 규칙 공유)
- `src/main/ai/visual.ts` — Visual 모델 호출(로컬 GGUF 또는 클라우드), 키패드 배치 전용 프롬프트
- 렌더러 `components/phone/*` — 카드·확대 뷰·WebCodecs 디코더 훅
- IPC 추가: `phone:list` `phone:connect` `phone:disconnect` `phone:screen`(스트림 청크 이벤트) `phone:tap` `phone:updated` `phone:authWaiting`

## 테스트 · 완료 기준

1. 폰 3대 연결 → 목록에 별칭·국가 표시, USB 뽑았다 꽂으면 5초 내 상태 갱신
2. WiFi 연결 폰 1대가 끊겼을 때 자동 복구 1회 시도 후 회색 처리
3. 폰 화면이 패널에서 (b) 방식으로 재생, 30분 연속 유지. 강제로 (c) 폴백 전환도 확인
4. `phone_get_screen` 요소 번호로 `phone_tap` 이 실제 버튼을 누름(앱 3종에서 확인)
5. **본인인증 문자 수신 → 웹 입력칸 자동 입력 성공** (사이트 10회 중 8회 이상, 무인)
6. 문자 DB 차단 폰에서 Visual 폴백으로 인증번호 인식 성공
7. **토스 결제 1건을 앱 승인까지 완료** — 결제 비밀번호 값이 로그·모델 입출력·스크린샷 어디에도 없음을 수동 확인
8. 결제 확인 카드가 모든 권한 모드에서 뜸, 상한 초과 시 차단
9. `auth_events` 로 무인 처리율 계산 가능
10. 수동 검수 15회 이상(PRD §12 각 단계 규칙) → 결과를 `docs/검수/2026-09-XX-3단계-폰인증.md` 에 기록
