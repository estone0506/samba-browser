# 3단계 구현 계획: 폰 연동 + 문자 인증 자동 입력 + 간편결제 앱 승인

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 안드로이드 폰 3대를 브라우저 안으로 끌어와 **본인인증 문자 자동 입력과 간편결제 앱 승인**까지 사람 손 없이 끝낸다. PRD §12 3단계 완료 기준은 "인증 문자 → 자동 입력 성공, 토스 결제 1건 앱 승인까지 완료".

**Architecture:** `src/main/phone/` 이 adb 프로세스 실행을 **단 하나의 인터페이스(`AdbRunner`)** 뒤에 숨기고, 그 위에 기기 관리(`devices.ts`)·화면(`screen.ts`)·UI 트리(`uitree.ts`)·입력(`input.ts`)·문자(`sms.ts`)·결제(`pay.ts`)·배정(`service.ts`)을 올린다. 파싱·추출·점수 계산·상태 전이는 전부 **순수 함수**로 빼서 폰 없이 테스트한다(테스트는 adb/scrcpy 를 한 번도 실행하지 않는다). AI 는 웹 스냅샷과 **같은 번호 체계**의 `PhoneScreen` 으로 폰을 본다. 결제 비밀번호는 금고 → 메인 내부 함수 → `input tap` 좌표로만 흐르고 **IPC·로그·모델 입출력 어디에도 값이 없다**.

**Tech Stack:** 2b 단계 스택(Electron 39 · React 19 · TypeScript · sql.js · drizzle-orm · zod · zustand · i18next · Tailwind · Claude Agent SDK) + 외부 실행 파일 `adb.exe`(platform-tools v37) · `scrcpy.exe`(4.1). **새 npm 의존성 없음**(XML·H.264 파싱은 자체 순수 함수).

---

## Global Constraints

2단계·2b단계 계획의 Global Constraints 를 전부 유지하고, 아래를 추가한다.

**코드 스타일 / 공통**
- 세미콜론 없음 · 작은따옴표 · 들여쓰기 2칸 · `any` 타입 금지 · 주석과 커밋 메시지는 한국어
- 모든 사용자 노출 문자열은 `t()` 경유, i18n `ko`/`en` 두 파일(`src/renderer/src/i18n/{ko,en}.json`)을 항상 함께 갱신
- UI 는 기존 애플 풍(흰 카드 `rounded-2xl border border-[var(--line)] bg-white`, 얇은 선, 검정 기본 버튼) — `components/settings/shared.tsx` 의 `SettingsSection`/`SettingsRow`/`SegmentedGroup` 재사용
- IPC 응답 형식은 기존 `IpcResult<T>` = `{ok:true,data}|{ok:false,error}` 유지
- **새 렌더러 채널은 예외 없이 `handleFromRenderer`(invoke) 또는 `onFromRenderer`(send) 로 등록**한다. 3단계에서 **페이지 프리로드가 쓰는 채널은 하나도 늘지 않으므로** `src/preload/page-constants.ts` 는 건드리지 않는다(`tests/preload-bundle.test.ts` 가 계속 통과해야 한다)
- 페이지 프리로드(`src/preload/page*.ts`)는 `src/shared/*` 의 값(value)을 import 하지 않는다 — 3단계 코드는 이 파일들을 수정하지 않는다
- 커밋 트레일러: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- 브랜치: `feature/stage3-phone` (main 직접 커밋 금지)

**폰 안전장치 (스펙 "권한·안전" 의 정확한 값)**
- **외부 프로세스 실행은 `AdbRunner`/`ProcessSpawner` 인터페이스를 통해서만** 한다. `child_process` 를 직접 부르는 파일은 `src/main/phone/process.ts` 하나뿐이고, 테스트는 이 인터페이스의 가짜 구현(`tests/stubs/fake-adb.ts`)만 쓴다. **테스트가 adb·scrcpy 를 실행하면 실패로 본다**
- **결제 비밀번호(금고 `password` 항목)는 모델·렌더러·로그 어디에도 가지 않는다.** 복호화는 `src/main/phone/pay-secret.ts` 의 `tapPaymentPassword()` 안에서만 일어나고, 그 함수는 좌표 탭만 수행한 뒤 `'ok'` 또는 `'error'` 문자열만 돌려준다. 진행 로그 라벨은 `결제 비밀번호 입력(N자리)` 처럼 **자리수만** 남긴다
- **결제는 권한 모드와 무관하게 확인 카드 1회.** `mode === 'full'` 이어도 건너뛰지 않는다. 카드에는 금액·가맹점·결제수단·폰 별칭을 표시한다
- **결제 상한**: 기본 50만원(`DEFAULT_PAYMENT_LIMIT_KRW = 500_000`) 초과 시 무조건 사람 확인. **새 (사이트 × 결제수단) 조합의 첫 자동 결제는 1만원 이하**(`FIRST_RUN_LIMIT_KRW = 10_000`)만 허용한다
- **비밀번호 오입력이 의심되면 재시도하지 않는다**(`attempts = 1`, 계정 잠금 방지)
- **금고가 잠겨 있으면 결제 비밀번호 터치 자체를 거부**하고 잠금 해제를 요청한다
- 폰 스크린샷은 작업 로그에 남기되 **비밀번호 입력 화면(자리수 표시 포함)은 저장하지 않는다** — `isSecretScreen()` 판정에 걸리면 저장·전송 모두 건너뛴다
- 문자 본문 전체는 로그에 남기지 않는다. **추출된 숫자와 발신번호 뒷 4자리만** `auth_events` 에 남긴다
- `phone_type` 도구는 금고에 접근할 수 없다 — `PhoneToolContext` 에 `vault` 필드가 **존재하지 않는다**(테스트로 단언)
- 권한 모드 적용: `read_only` = `phone_get_screen`·`phone_screenshot` 만 허용, `phone_tap/type/key/swipe` 는 `refused: read-only mode`. `guard` = 결제 앱 패키지(`PAYMENT_PACKAGES`)에서의 조작에 확인 카드
- **폰 연동은 Pro 요금제부터.** `AuthState.plan !== 'pro'` 이면 기기 폴링을 시작하지 않고, 폰 도구는 `refused: phone requires Pro plan` 을 돌려주며, 폰 화면은 업그레이드 안내 카드를 보여 준다. **실제 결제(구독) 연동은 3단계 범위 밖**이다(요금제 값은 2b 의 `profiles.plan` 을 그대로 읽는다). 연결 대수 상한은 3대(`PHONE_LIMIT_PRO = 3`)
- **끊김 복구는 `kill-server && start-server` 1회만.** 실패하면 폰 카드를 회색 처리하고 사용자에게 알린다(무한 재시도 금지)
- `phones` 표는 **PC별 정보라 동기화하지 않는다** — `SYNC_TABLES` 에 추가하지 않고, `tests/phone-repo.test.ts` 에서 단언한다. `auth_events` 도 로컬 KPI 전용이라 동기화하지 않는다

---

## 스펙 대비 조정 3가지

| 스펙 | 계획 | 이유 |
|---|---|---|
| 영상 (b) = `scrcpy --no-window` 의 **raw h264 stdout** | (b) = **`adb exec-out screenrecord --output-format=h264 -`** 의 raw H.264 stdout → WebCodecs 디코드 | scrcpy 4.1 은 stdout 으로 raw 스트림을 내보내는 공식 옵션이 없다(`--record` 는 파일 컨테이너). `screenrecord` 는 Android 7+ 표준이고 raw Annex-B 를 그대로 파이프한다. **디코드·폴백·터치 좌표 환산 로직은 스펙 그대로** 재사용된다. 170초마다 재시작(screenrecord 180초 상한)을 `ScreenStream` 이 이어 붙인다 |
| scrcpy 는 (b)의 구현 수단 | scrcpy 는 **"큰 창으로 열기"(별도 창) 전용**으로 남긴다 | 사용자가 직접 폰을 오래 만질 때는 별도 창이 더 빠르다. 앱 안 임베드는 (b)/(c)가 담당 |
| ARS 는 5단계 | **수신 감지·안내까지만** 3단계에 포함(자동 응답은 5단계) | 문자 인증 대기 중 전화가 오면 사용자가 알아야 한다. `dumpsys telephony.registry` 의 통화 상태만 읽고 알린다 |

---

## 파일 구조

```
src/shared/
  phone.ts                 PhoneDto·PhoneCountry·PhoneState·AuthEventDto·상수(폴링 주기·상한)
  phone-snapshot.ts        PhoneElement·PhoneScreen·serializePhoneScreen(웹 스냅샷과 같은 규칙)
  ipc.ts                   (수정) phone:* 채널 추가
  settings.ts              (수정) adbPath·scrcpyPath·phoneScreenMaxSize·phoneScreenFps·
                                  phoneAutoReconnect·paymentLimitKrw 추가

src/main/phone/
  process.ts               child_process 를 쓰는 유일한 파일(AdbRunner·ProcessSpawner 구현)
  adb.ts                   경로 자동 탐지 · `adb devices -l` 파싱 · 명령 래퍼
  devices.ts               5초 폴링 · WiFi connect · 끊김 1회 복구 · 상태 통지
  uitree.ts                uiautomator dump XML 파싱 → PhoneElement[]
  input.ts                 tap/swipe/text/key + 화면 좌표 ↔ 폰 좌표 환산
  h264.ts                  Annex-B NAL 분리 · 키프레임 판정(순수)
  screen.ts                ScreenStream: (b) screenrecord 파이프 → 실패 시 (c) screencap 폴백
  sms.ts                   content query 출력 파싱 · 인증번호 추출·점수(순수)
  auth-flow.ts             SMS 인증 오케스트레이션(3분 타임아웃·Visual 폴백) · ARS 감지
  pay.ts                   간편결제 승인 상태기계(순수 전이 + 실행기)
  pay-secret.ts            결제 비밀번호 좌표 탭(값이 밖으로 나가지 않는 유일한 경로)
  repo.ts                  phones · auth_events · account_phones 저장소
  service.ts               PhoneService: 배정·이벤트 기록·Pro 게이트

src/main/ai/
  visual.ts                Visual 모델 호출(화면 속 인증번호 읽기 · 키패드 배치)

src/main/agent/
  tools-phone.ts           폰 AI 도구 6종(tools.ts 에 등록)

src/main/db/
  schema.ts                (수정) phones · authEvents · accountPhones
  migrations.ts            (수정) 0009 추가

src/main/ipc/
  handlers.ts              (수정) phone:* 배선

src/renderer/src/
  stores/phoneStore.ts
  pages/PhonesPage.tsx                       사이드바 "폰" 화면
  components/phone/{PhoneCard,PhoneScreenView,PhoneManualPad,PhoneAssignDialog}.tsx
  components/phone/useH264Player.ts          WebCodecs 디코더 훅
  components/settings/PhoneSection.tsx       설정 → 폰
  components/settings/sections.ts            (수정) 'phone' 섹션 추가
  components/layout/Sidebar.tsx              (수정) 폰 항목에 view 연결

tests/
  phone-adb.test.ts  phone-uitree.test.ts  phone-snapshot.test.ts  phone-input.test.ts
  phone-h264.test.ts  phone-screen.test.ts  phone-sms.test.ts  phone-devices.test.ts
  phone-repo.test.ts  phone-tools.test.ts  phone-auth-flow.test.ts  phone-pay.test.ts
  phone-pay-secret.test.ts  ai-visual.test.ts
  stubs/fake-adb.ts
```

---

### Task 1: 공용 타입 · 설정 · adb 경로 탐지와 명령 래퍼

폰 기능의 **바닥**을 깐다. 여기서 만든 `AdbRunner` 인터페이스 위로는 아무도 `child_process` 를 모른다.

**Files:** Create `src/shared/phone.ts`, `src/main/phone/{process,adb}.ts`, `tests/stubs/fake-adb.ts`; Modify `src/shared/settings.ts`; Test `tests/phone-adb.test.ts`

**Interfaces:**
```ts
// src/main/phone/adb.ts
export interface AdbResult { code: number; stdout: string; stderr: string }
export interface AdbRunner {
  // adb 인자 배열을 그대로 실행한다(serial 지정은 호출부가 -s 로 붙인다)
  run: (args: string[], timeoutMs?: number) => Promise<AdbResult>
  // stdout 을 바이너리로 그대로 받는 실행(screencap·screenrecord)
  runBinary: (args: string[], timeoutMs?: number) => Promise<Buffer>
}
export function parseDevices(stdout: string): RawDevice[]
export function detectAdbPath(candidates: string[], exists: (p: string) => boolean): string
export function shellArgs(serial: string, command: string): string[]
```

- [ ] Step 1: `src/shared/phone.ts` 작성.
```ts
// 폰 연동 공용 타입·상수. 메인·렌더러·preload 가 모두 이 파일 하나만 본다

export const PHONE_COUNTRIES = ['KR', 'CN', 'JP'] as const
export type PhoneCountry = (typeof PHONE_COUNTRIES)[number]

export const PHONE_TRANSPORTS = ['usb', 'wifi'] as const
export type PhoneTransport = (typeof PHONE_TRANSPORTS)[number]

// adb 가 보고하는 상태 + 목록에는 있으나 지금 안 보이는 상태(disconnected)
export const PHONE_STATES = ['online', 'unauthorized', 'offline', 'disconnected'] as const
export type PhoneState = (typeof PHONE_STATES)[number]

// 화면 전송 방식: 동영상(h264) · 간이 화면(주기 스크린샷)
export const SCREEN_MODES = ['video', 'still'] as const
export type ScreenMode = (typeof SCREEN_MODES)[number]

export interface PhoneDto {
  id: number
  serial: string
  label: string
  country: PhoneCountry
  transport: PhoneTransport
  wifiAddress: string | null
  model: string
  state: PhoneState
  // 문자 DB 조회가 되는 폰인가. null 은 아직 시험 조회 전
  smsQueryOk: boolean | null
  lastSeenAt: number
  // 지금 이 폰의 화면을 어떤 방식으로 보내고 있는가(안 보내면 null)
  screenMode: ScreenMode | null
}

export type AuthEventKind = 'sms' | 'app_approve' | 'ars'
export type AuthEventMethod = 'sms_query' | 'visual' | 'manual'

export interface AuthEventDto {
  id: number
  jobId: string | null
  phoneId: number | null
  kind: AuthEventKind
  siteHost: string
  ok: boolean
  method: AuthEventMethod
  elapsedMs: number
  at: number
}

// 인증 대기 알림(메인 → 렌더러). 해당 폰 카드를 펼치고 테두리를 강조한다
export interface PhoneAuthWaitingDto {
  waiting: boolean
  kind: AuthEventKind
  siteHost: string
  // 인증을 받기로 배정된 폰(없으면 3대 동시 감시)
  phoneId: number | null
}

// --- 상수(스펙 "핵심 결정" 의 값) -------------------------------------------
/** adb devices 폴링 주기 5초 */
export const DEVICE_POLL_INTERVAL_MS = 5000
/** 문자함 폴링 주기 1초 — 인증 대기 중에만 돈다 */
export const SMS_POLL_INTERVAL_MS = 1000
/** 인증 대기 상한 3분(PRD §9) */
export const AUTH_TIMEOUT_MS = 3 * 60 * 1000
/** 인증번호로 인정하는 문자 수신 최대 경과 시간 3분 */
export const SMS_RECENT_MS = 3 * 60 * 1000
/** Pro 요금제 폰 연결 상한 3대 */
export const PHONE_LIMIT_PRO = 3
/** 화면 해상도 선택지(긴 변 기준) */
export const SCREEN_SIZES = [720, 1080] as const
export type ScreenSize = (typeof SCREEN_SIZES)[number]
/** 화면 프레임률 선택지 */
export const SCREEN_FPS = [10, 15, 30] as const
export type ScreenFps = (typeof SCREEN_FPS)[number]
/** 결제 상한 기본값(원) */
export const DEFAULT_PAYMENT_LIMIT_KRW = 500_000
/** 새 (사이트 × 결제수단) 조합의 첫 자동 결제 상한(원) */
export const FIRST_RUN_LIMIT_KRW = 10_000

export function isPhoneCountry(v: unknown): v is PhoneCountry {
  return typeof v === 'string' && (PHONE_COUNTRIES as readonly string[]).includes(v)
}
```
- [ ] Step 2: `src/shared/settings.ts` 에 폰 설정을 추가한다. `DEFAULT_SETTINGS` 에:
```ts
  // === 폰 연동(3단계 추가분) ================================================
  // adb/scrcpy 실행 파일 경로. 빈 문자열이면 설정 화면의 "자동 찾기" 를 안내한다
  adbPath: '',
  scrcpyPath: '',
  // 폰 화면 품질(긴 변 픽셀 · 초당 프레임)
  phoneScreenMaxSize: 720 as ScreenSize,
  phoneScreenFps: 15 as ScreenFps,
  // 끊겼을 때 kill-server/start-server 로 1회 자동 복구할지
  phoneAutoReconnect: true,
  // 결제 상한(원). 초과하면 권한 모드와 무관하게 사람 확인을 받는다
  paymentLimitKrw: DEFAULT_PAYMENT_LIMIT_KRW
  // === 폰 연동 끝 ===========================================================
```
  zod 스키마에도 같은 순서로 추가한다(`adbPath: z.string().catch('')`, `phoneScreenMaxSize: z.union([z.literal(720), z.literal(1080)]).catch(720)`, `phoneScreenFps: z.union([z.literal(10), z.literal(15), z.literal(30)]).catch(15)`, `phoneAutoReconnect: z.boolean().catch(true)`, `paymentLimitKrw: z.number().int().min(0).catch(DEFAULT_PAYMENT_LIMIT_KRW)`). 경로는 **기기별 값이라 동기화하지 않는다** — `SYNCED_SETTING_KEYS` 에 넣지 않는다.
- [ ] Step 3: 실패 테스트 `tests/phone-adb.test.ts` — ① `parseDevices` 가 `List of devices attached` 머리줄과 빈 줄을 건너뛰고 serial·state·model 을 뽑는다 ② `192.168.0.5:5555` 는 `transport: 'wifi'`, 그 외는 `'usb'` ③ `unauthorized`/`offline` 상태를 그대로 보존 ④ `detectAdbPath` 가 후보 중 **처음 존재하는 경로**를 돌려주고, 하나도 없으면 빈 문자열 ⑤ `shellArgs('R3C', 'input tap 1 2')` → `['-s','R3C','shell','input','tap','1','2']` ⑥ 따옴표가 필요한 인자(`content query --uri content://sms/inbox`)가 **공백 기준으로 쪼개지지 않게** `shellArgs` 가 배열 인자 형태도 받는다.
- [ ] Step 4: `src/main/phone/adb.ts` 구현.
```ts
// adb 경로 탐지와 명령 조립. 여기에는 프로세스 실행 코드가 없다(process.ts 가 담당).
// 전부 순수 함수라 폰 없이 테스트한다

import type { PhoneTransport, PhoneState } from '../../shared/phone'

export interface RawDevice {
  serial: string
  state: PhoneState
  model: string
  transport: PhoneTransport
}

// 경로 자동 찾기 후보(앞에서부터 먼저 존재하는 것을 쓴다).
// 사용자의 실제 설치 위치를 1순위에 둔다 — PATH 에는 등록돼 있지 않다
export const ADB_CANDIDATES = [
  'C:\\Users\\canno\\Downloads\\pt\\platform-tools\\adb.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Android\\Sdk\\platform-tools\\adb.exe`,
  `${process.env.USERPROFILE ?? ''}\\Downloads\\pt\\platform-tools\\adb.exe`
]

export const SCRCPY_CANDIDATES = [
  'C:\\Users\\canno\\Downloads\\pt\\scrcpy-win64-v4.1\\scrcpy.exe',
  `${process.env.USERPROFILE ?? ''}\\Downloads\\pt\\scrcpy-win64-v4.1\\scrcpy.exe`
]

// 와이파이 연결은 serial 이 'ip:port' 꼴이다
const WIFI_SERIAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/

export function isWifiSerial(serial: string): boolean {
  return WIFI_SERIAL_RE.test(serial)
}

/** 후보 중 처음 존재하는 경로. 하나도 없으면 빈 문자열 */
export function detectAdbPath(candidates: string[], exists: (p: string) => boolean): string {
  for (const c of candidates) {
    if (c && exists(c)) return c
  }
  return ''
}

/** `adb devices -l` 출력 파싱 */
export function parseDevices(stdout: string): RawDevice[] {
  const out: RawDevice[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices')) continue
    if (trimmed.startsWith('*') || trimmed.startsWith('adb server')) continue
    const parts = trimmed.split(/\s+/)
    const serial = parts[0]
    const rawState = parts[1] ?? ''
    if (!serial || !rawState) continue
    const model = /(?:^|\s)model:(\S+)/.exec(trimmed)?.[1]?.replace(/_/g, ' ') ?? ''
    out.push({
      serial,
      state: toState(rawState),
      model,
      transport: isWifiSerial(serial) ? 'wifi' : 'usb'
    })
  }
  return out
}

function toState(raw: string): PhoneState {
  if (raw === 'device') return 'online'
  if (raw === 'unauthorized') return 'unauthorized'
  return 'offline'
}

/**
 * `adb -s <serial> shell <command>` 인자 배열.
 * 문자열을 넘기면 공백으로 쪼개고, 배열을 넘기면 그대로 쓴다.
 * `content query --uri content://sms/inbox` 처럼 쪼개면 안 되는 인자는 배열로 넘긴다
 */
export function shellArgs(serial: string, command: string | string[]): string[] {
  const rest = typeof command === 'string' ? command.split(' ').filter(Boolean) : command
  return ['-s', serial, 'shell', ...rest]
}

/** exec-out(바이너리 stdout) 용 인자 배열 */
export function execOutArgs(serial: string, command: string[]): string[] {
  return ['-s', serial, 'exec-out', ...command]
}
```
- [ ] Step 5: `src/main/phone/process.ts` — **`child_process` 를 쓰는 유일한 파일**.
```ts
// adb 실행기. child_process 를 쓰는 파일은 이 하나뿐이고,
// 그 위의 모든 모듈은 AdbRunner 인터페이스만 본다(테스트는 가짜 구현을 쓴다)

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface AdbResult {
  code: number
  stdout: string
  stderr: string
}

export interface AdbRunner {
  run: (args: string[], timeoutMs?: number) => Promise<AdbResult>
  runBinary: (args: string[], timeoutMs?: number) => Promise<Buffer>
  // 오래 도는 스트림(screenrecord). 종료 함수를 돌려준다
  stream: (
    args: string[],
    onData: (chunk: Buffer) => void,
    onEnd: (code: number | null) => void
  ) => () => void
}

// 한 번짜리 명령 기본 상한 15초(uiautomator dump 가 느린 기기가 있다)
const DEFAULT_TIMEOUT_MS = 15_000
// stdout 상한 32MB(screencap PNG 여유)
const MAX_BUFFER = 32 * 1024 * 1024

export function createAdbRunner(adbPath: () => string): AdbRunner {
  const bin = (): string => {
    const p = adbPath()
    if (!p) throw new Error('adb path is not set')
    return p
  }

  return {
    run: (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      new Promise((resolve) => {
        execFile(
          bin(),
          args,
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
          (err, stdout, stderr) => {
            const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0
            resolve({ code, stdout: String(stdout), stderr: String(stderr) })
          }
        )
      }),

    runBinary: (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      new Promise((resolve, reject) => {
        execFile(
          bin(),
          args,
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'buffer', windowsHide: true },
          (err, stdout) => {
            if (err && (!stdout || stdout.length === 0)) reject(err)
            else resolve(Buffer.from(stdout))
          }
        )
      }),

    stream: (args, onData, onEnd) => {
      let child: ChildProcessWithoutNullStreams | null = spawn(bin(), args, { windowsHide: true })
      child.stdout.on('data', (c: Buffer) => onData(c))
      // stderr 는 화면 크기 안내 등 잡음이라 버린다(비밀값이 들어올 경로가 아니다)
      child.stderr.resume()
      child.on('close', (code) => {
        child = null
        onEnd(code)
      })
      return () => {
        child?.kill()
        child = null
      }
    }
  }
}
```
- [ ] Step 6: `tests/stubs/fake-adb.ts` — 명령별 응답을 미리 넣어 두는 가짜 실행기.
```ts
// 테스트용 가짜 adb. 실제 프로세스를 절대 띄우지 않는다.
// 인자 배열을 공백으로 이어 붙인 문자열을 키로 응답을 고른다

import type { AdbResult, AdbRunner } from '../../src/main/phone/process'

export class FakeAdb implements AdbRunner {
  readonly calls: string[][] = []
  private replies = new Map<string, AdbResult>()
  private binaries = new Map<string, Buffer>()
  private streams: ((chunk: Buffer) => void)[] = []

  /** 부분 일치(포함)로 응답을 지정한다 */
  reply(match: string, stdout: string, code = 0): void {
    this.replies.set(match, { code, stdout, stderr: '' })
  }

  replyBinary(match: string, data: Buffer): void {
    this.binaries.set(match, data)
  }

  run(args: string[]): Promise<AdbResult> {
    this.calls.push(args)
    const key = args.join(' ')
    for (const [match, res] of this.replies) {
      if (key.includes(match)) return Promise.resolve(res)
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }

  runBinary(args: string[]): Promise<Buffer> {
    this.calls.push(args)
    const key = args.join(' ')
    for (const [match, data] of this.binaries) {
      if (key.includes(match)) return Promise.resolve(data)
    }
    return Promise.resolve(Buffer.alloc(0))
  }

  stream(args: string[], onData: (chunk: Buffer) => void, onEnd: (code: number | null) => void) {
    this.calls.push(args)
    this.streams.push(onData)
    return () => onEnd(0)
  }

  /** 테스트에서 스트림 청크를 흘려보낸다 */
  push(chunk: Buffer): void {
    for (const s of this.streams) s(chunk)
  }
}
```
- [ ] Step 7: `pnpm test -- phone-adb` 통과(기대 출력 `Test Files  1 passed`) → `pnpm lint` → 커밋
```
git commit -m "$(cat <<'EOF'
폰 연동 바닥 공사: 공용 타입·설정과 adb 경로 탐지·명령 조립

- src/shared/phone.ts: PhoneDto·AuthEventDto·폴링 주기·상한 상수
- src/main/phone/adb.ts: devices -l 파싱·경로 자동 찾기·shell 인자 조립(순수)
- src/main/phone/process.ts: child_process 를 쓰는 유일한 파일(AdbRunner)
- 설정에 adb/scrcpy 경로·화면 품질·자동 재연결·결제 상한 추가(동기화 제외)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: phones · auth_events · account_phones 표와 저장소

**Files:** Create `src/main/phone/repo.ts`; Modify `src/main/db/{schema,migrations}.ts`; Test `tests/phone-repo.test.ts`

**Interfaces:**
```ts
export class PhoneRepo {
  constructor(db: Db)
  upsertSeen(input: { serial: string; model: string; transport: PhoneTransport; state: PhoneState; at: number }): PhoneRow
  list(): PhoneRow[]
  setLabel(id: number, label: string, country: PhoneCountry): void
  setSmsQueryOk(id: number, ok: boolean): void
  setWifiAddress(id: number, address: string | null): void
  markMissing(serials: string[], at: number): void
  assignAccount(accountId: number, phoneId: number | null): void
  phoneForAccount(accountId: number): PhoneRow | null
  recordAuthEvent(input: Omit<AuthEventDto, 'id'>): void
  listAuthEvents(limit?: number): AuthEventDto[]
  /** 무인 처리율 = ok 인 건 / 전체 건 */
  unattendedRate(kind: AuthEventKind, sinceMs: number): { total: number; ok: number }
}
```

- [ ] Step 1: `src/main/db/schema.ts` 에 표 3개를 추가한다.
```ts
// 연결된 폰. PC 별 정보라 동기화하지 않는다(remote_id 컬럼이 없다)
export const phones = sqliteTable('phones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serial: text('serial').notNull().unique(),
  label: text('label').notNull(),
  // 'KR' | 'CN' | 'JP'
  country: text('country').notNull(),
  // 'usb' | 'wifi'
  transport: text('transport').notNull(),
  wifiAddress: text('wifi_address'),
  model: text('model').notNull().default(''),
  // 문자 DB 조회 가능 여부. NULL 이면 아직 시험 조회 전
  smsQueryOk: integer('sms_query_ok', { mode: 'boolean' }),
  lastSeenAt: integer('last_seen_at').notNull(),
  workspaceId: integer('workspace_id')
})

// 인증 이벤트(KPI 집계용 로컬 기록). 문자 본문은 담지 않는다 —
// 추출된 코드와 발신번호 뒷 4자리만 남긴다
export const authEvents = sqliteTable('auth_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id'),
  phoneId: integer('phone_id'),
  // 'sms' | 'app_approve' | 'ars'
  kind: text('kind').notNull(),
  siteHost: text('site_host').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  // 'sms_query' | 'visual' | 'manual'
  method: text('method').notNull(),
  elapsedMs: integer('elapsed_ms').notNull(),
  // 추출한 인증번호(숫자만) — 본문은 남기지 않는다
  code: text('code'),
  // 발신번호 뒷 4자리
  senderTail: text('sender_tail'),
  at: integer('at').notNull()
})

// 계정 ↔ 폰 매핑. 작업 시 사용자가 고르고 기억한다. 동기화하지 않는다
export const accountPhones = sqliteTable('account_phones', {
  accountId: integer('account_id').primaryKey(),
  phoneId: integer('phone_id').notNull(),
  updatedAt: integer('updated_at').notNull()
})
```
- [ ] Step 2: `src/main/db/migrations.ts` 에 `0009_phones` 를 추가한다(기존 배열 맨 뒤).
```ts
  {
    // 3단계 폰 연동 — 폰 목록·인증 이벤트·계정 매핑. 셋 다 PC 로컬 전용이라
    // remote_id/deleted_at 컬럼이 없고 SYNC_TABLES 에도 들어가지 않는다
    tag: '0009_phones',
    sql: [
      'CREATE TABLE `phones` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`serial` text NOT NULL,\n\t`label` text NOT NULL,\n\t`country` text NOT NULL,\n\t`transport` text NOT NULL,\n\t`wifi_address` text,\n\t`model` text DEFAULT \'\' NOT NULL,\n\t`sms_query_ok` integer,\n\t`last_seen_at` integer NOT NULL,\n\t`workspace_id` integer\n);',
      'CREATE UNIQUE INDEX `phones_serial_unique` ON `phones` (`serial`);',
      'CREATE TABLE `auth_events` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`job_id` text,\n\t`phone_id` integer,\n\t`kind` text NOT NULL,\n\t`site_host` text NOT NULL,\n\t`ok` integer NOT NULL,\n\t`method` text NOT NULL,\n\t`elapsed_ms` integer NOT NULL,\n\t`code` text,\n\t`sender_tail` text,\n\t`at` integer NOT NULL\n);',
      'CREATE INDEX `auth_events_at_idx` ON `auth_events` (`at`);',
      'CREATE TABLE `account_phones` (\n\t`account_id` integer PRIMARY KEY NOT NULL,\n\t`phone_id` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);'
    ]
  }
```
- [ ] Step 3: 실패 테스트 `tests/phone-repo.test.ts` — ① `upsertSeen` 이 처음 보는 serial 에 기본 별칭(`model` 또는 serial 뒤 4자리)과 `country: 'KR'` 로 행을 만든다 ② 같은 serial 을 다시 보면 행이 늘지 않고 `lastSeenAt`·`transport`·`model` 만 갱신된다 ③ `markMissing` 이 목록에 없는 serial 들의 상태 판정을 위해 `lastSeenAt` 을 유지하고 조회 시 `disconnected` 로 계산된다 ④ `setLabel`·`setSmsQueryOk`·`setWifiAddress` 반영 ⑤ `assignAccount(1, 2)` 후 `phoneForAccount(1)` 이 그 폰, `assignAccount(1, null)` 이면 null ⑥ `recordAuthEvent` 가 **본문 컬럼을 갖지 않으며** `code`·`senderTail` 만 저장한다 ⑦ `unattendedRate('sms', since)` 가 `{total, ok}` 를 센다 ⑧ **`SYNC_TABLES` 에 `phones`·`auth_events`·`account_phones` 가 없다**(동기화 제외 단언).
- [ ] Step 4: `src/main/phone/repo.ts` 구현. 조회 시 `state` 는 폴링 결과(메모리)로 덮어쓰므로 저장소는 `lastSeenAt` 만 다루고, 기본 별칭은 `defaultLabel(serial, model)` 순수 함수로 만든다.
```ts
/** 처음 본 폰의 기본 별칭 — 모델명이 있으면 모델명, 없으면 serial 뒤 4자리 */
export function defaultLabel(serial: string, model: string): string {
  return model.trim() || `폰 ${serial.slice(-4)}`
}
```
- [ ] Step 5: `pnpm test -- phone-repo` 통과 → `pnpm typecheck` → 커밋: `폰 표 추가: phones·auth_events·account_phones(전부 동기화 제외)`

---

### Task 3: 기기 관리 — 5초 폴링 · WiFi 연결 · 끊김 1회 복구 · IPC

**Files:** Create `src/main/phone/devices.ts`, `src/main/phone/service.ts`; Modify `src/shared/ipc.ts`, `src/main/ipc/handlers.ts`, `src/preload/renderer.ts`, `src/renderer/src/types/samba.d.ts`; Test `tests/phone-devices.test.ts`

**Interfaces:**
```ts
export interface DeviceManagerDeps {
  adb: AdbRunner
  repo: PhoneRepo
  now: () => number
  // Pro 요금제가 아니면 폴링을 시작하지 않는다
  isPro: () => boolean
  autoReconnect: () => boolean
  onChange: (phones: PhoneDto[]) => void
  // 테스트에서 가짜 타이머를 넣는다
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export class DeviceManager {
  constructor(deps: DeviceManagerDeps)
  start(): void
  stop(): void
  /** 1회 즉시 스캔(설정 화면의 "지금 찾기") */
  refresh(): Promise<PhoneDto[]>
  list(): PhoneDto[]
  connectWifi(address: string): Promise<{ ok: boolean; message: string }>
  disconnect(serial: string): Promise<void>
  /** 폰 카드의 "재연결" — kill-server && start-server 를 1회만 시도한다 */
  recover(serial: string): Promise<boolean>
}
```

- [ ] Step 1: `src/shared/ipc.ts` 에 채널을 추가한다.
```ts
  // --- 폰 연동(3단계) — 값(결제 비밀번호·문자 본문)은 어느 채널에도 흐르지 않는다 ---
  phoneList: 'phone:list',
  phoneRefresh: 'phone:refresh', // 즉시 스캔
  phoneDetectPaths: 'phone:detectPaths', // adb/scrcpy 경로 자동 찾기
  phoneConnect: 'phone:connect', // 와이파이 주소로 연결
  phoneDisconnect: 'phone:disconnect',
  phoneRecover: 'phone:recover', // kill/start-server 1회 재시도
  phoneSetLabel: 'phone:setLabel', // 별칭·국가
  phoneAssign: 'phone:assign', // 계정 ↔ 폰 매핑
  phoneScreenStart: 'phone:screenStart',
  phoneScreenStop: 'phone:screenStop',
  phoneScreenChunk: 'phone:screenChunk', // main → renderer 이벤트(영상 청크/스틸 이미지)
  phoneOpenWindow: 'phone:openWindow', // scrcpy 별도 창으로 크게 보기
  phoneTap: 'phone:tap', // 사용자가 화면을 직접 눌렀을 때
  phoneSwipe: 'phone:swipe',
  phoneKey: 'phone:key',
  phoneUpdated: 'phone:updated', // main → renderer 이벤트(목록·상태)
  phoneAuthWaiting: 'phone:authWaiting', // main → renderer 이벤트(카드 자동 펼침)
  phoneAuthEvents: 'phone:authEvents' // KPI 목록
```
  타입 재수출도 추가한다: `export type { PhoneDto, AuthEventDto, PhoneAuthWaitingDto, PhoneCountry, ScreenMode } from './phone'`
- [ ] Step 2: 실패 테스트 `tests/phone-devices.test.ts`(가짜 adb·가짜 타이머) — ① `start()` 후 5초마다 `devices -l` 을 부른다 ② 새 폰이 보이면 `repo.upsertSeen` + `onChange` 1회 ③ 같은 목록이 반복되면 `onChange` 를 **다시 부르지 않는다**(상태 해시 비교) ④ 목록에서 사라진 폰은 `state: 'disconnected'` 로 바뀌며 `onChange` ⑤ `unauthorized` 는 그대로 보고된다(자동 복구 대상 아님) ⑥ 끊긴 폰에 `recover()` 하면 `kill-server` → `start-server` → `devices` 순으로 **정확히 1회씩** 부르고, 여전히 없으면 `false` 를 돌려주며 **두 번째 시도를 하지 않는다** ⑦ `autoReconnect()` 가 false 면 끊겨도 자동 복구를 시도하지 않는다 ⑧ `isPro()` 가 false 면 `start()` 가 폴링을 시작하지 않고 `list()` 는 빈 배열 ⑨ 연결 대수가 `PHONE_LIMIT_PRO` 를 넘으면 초과분은 목록에 담되 `state: 'offline'` 로 두고 경고 메시지를 `onChange` 와 함께 통지 ⑩ `connectWifi('192.168.0.5')` 가 포트 생략 시 `:5555` 를 붙여 `adb connect 192.168.0.5:5555` 를 부른다.
- [ ] Step 3: `src/main/phone/devices.ts` 구현. 핵심 로직만 발췌:
```ts
// 기기 감시. adb 는 장치 이벤트 API 가 없어 5초 폴링으로 본다(PRD 04 배치표).
// 복구는 정확히 1회만 — 무한 재시도는 adb 서버를 더 망가뜨린다

const WIFI_DEFAULT_PORT = 5555

export class DeviceManager {
  private handle: unknown = null
  private phones: PhoneDto[] = []
  private lastHash = ''
  // 이번 연결 주기에 이미 복구를 시도한 serial(끊겼다 붙으면 비운다)
  private recovered = new Set<string>()

  constructor(private deps: DeviceManagerDeps) {}

  start(): void {
    if (this.handle !== null || !this.deps.isPro()) return
    const setI = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    void this.refresh()
    this.handle = setI(() => void this.refresh(), DEVICE_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.handle === null) return
    const clearI = this.deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout))
    clearI(this.handle)
    this.handle = null
  }

  async refresh(): Promise<PhoneDto[]> {
    if (!this.deps.isPro()) return []
    const res = await this.deps.adb.run(['devices', '-l'])
    const raw = parseDevices(res.stdout)
    const now = this.deps.now()
    const seen = new Set<string>()
    for (const d of raw) {
      seen.add(d.serial)
      this.deps.repo.upsertSeen({ ...d, at: now })
      if (d.state === 'online') this.recovered.delete(d.serial)
    }
    // 저장된 폰 중 이번에 안 보인 것은 끊김으로 본다
    const rows = this.deps.repo.list()
    const next: PhoneDto[] = rows.map((row, index) => {
      const live = raw.find((d) => d.serial === row.serial)
      const overLimit = index >= PHONE_LIMIT_PRO
      return toDto(row, live, overLimit)
    })
    // 끊긴 폰 자동 복구 1회
    if (this.deps.autoReconnect()) {
      for (const p of next) {
        if (p.state !== 'disconnected' || this.recovered.has(p.serial)) continue
        this.recovered.add(p.serial)
        void this.recover(p.serial)
      }
    }
    this.phones = next
    const hash = next.map((p) => `${p.serial}:${p.state}`).join('|')
    if (hash !== this.lastHash) {
      this.lastHash = hash
      this.deps.onChange(next)
    }
    return next
  }

  async recover(serial: string): Promise<boolean> {
    await this.deps.adb.run(['kill-server'])
    await this.deps.adb.run(['start-server'])
    const res = await this.deps.adb.run(['devices', '-l'])
    return parseDevices(res.stdout).some((d) => d.serial === serial && d.state === 'online')
  }

  async connectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    const target = address.includes(':') ? address : `${address}:${WIFI_DEFAULT_PORT}`
    const res = await this.deps.adb.run(['connect', target], 10_000)
    const ok = /connected to/i.test(res.stdout)
    if (ok) await this.refresh()
    return { ok, message: res.stdout.trim() || res.stderr.trim() }
  }

  async disconnect(serial: string): Promise<void> {
    await this.deps.adb.run(['disconnect', serial])
    await this.refresh()
  }
}
```
- [ ] Step 4: `src/main/phone/service.ts` — `PhoneService` 가 `DeviceManager`·`PhoneRepo`·설정·요금제를 묶고, 앱 시작 시 폰별 **문자 DB 시험 조회 1회**(`content query --uri content://sms/inbox --projection _id` 가 0 이 아닌 코드/`Permission Denial` 이면 `smsQueryOk = false`)를 수행해 저장한다. `assignForJob(accountId)` 는 계정 매핑 폰 → 없으면 null(3대 동시 감시)을 돌려준다.
- [ ] Step 5: `handlers.ts` 배선. 전부 `handleFromRenderer` 로 등록한다.
```ts
  // --- 폰 연동(3단계) ------------------------------------------------------
  const phones = new PhoneService({
    adb: createAdbRunner(() => settings.get().adbPath),
    repo: new PhoneRepo(db),
    settings,
    isPro: () => auth.state().plan === 'pro',
    emit: (list) => send(IPC.phoneUpdated, list),
    emitAuthWaiting: (dto) => send(IPC.phoneAuthWaiting, dto)
  })
  handleFromRenderer(IPC.phoneList, () => phones.list())
  handleFromRenderer(IPC.phoneRefresh, () => phones.refresh())
  handleFromRenderer(IPC.phoneDetectPaths, () => phones.detectPaths())
  handleFromRenderer(IPC.phoneConnect, (address: string) => phones.connectWifi(address))
  handleFromRenderer(IPC.phoneDisconnect, (serial: string) => phones.disconnect(serial))
  handleFromRenderer(IPC.phoneRecover, (serial: string) => phones.recover(serial))
  handleFromRenderer(IPC.phoneSetLabel, (id: number, label: string, country: string) =>
    phones.setLabel(id, label, country)
  )
  handleFromRenderer(IPC.phoneAssign, (accountId: number, phoneId: number | null) =>
    phones.assign(accountId, phoneId)
  )
  handleFromRenderer(IPC.phoneAuthEvents, (limit?: number) => phones.authEvents(limit))
```
  창이 닫힐 때 `phones.dispose()` 를 `win.once('closed')` 블록에 추가한다.
- [ ] Step 6: `preload/renderer.ts` 에 `phone` 네임스페이스를 추가하고(`import type { PhoneDto, AuthEventDto, PhoneAuthWaitingDto } from '../shared/ipc'` — **타입만**), `samba.d.ts` 에 같은 모양을 선언한다.
```ts
  phone: {
    list: (): Promise<IpcResult<PhoneDto[]>> => invoke(IPC.phoneList),
    refresh: (): Promise<IpcResult<PhoneDto[]>> => invoke(IPC.phoneRefresh),
    detectPaths: (): Promise<IpcResult<{ adb: string; scrcpy: string }>> =>
      invoke(IPC.phoneDetectPaths),
    connect: (address: string): Promise<IpcResult<{ ok: boolean; message: string }>> =>
      invoke(IPC.phoneConnect, address),
    disconnect: (serial: string): Promise<IpcResult<void>> => invoke(IPC.phoneDisconnect, serial),
    recover: (serial: string): Promise<IpcResult<boolean>> => invoke(IPC.phoneRecover, serial),
    setLabel: (id: number, label: string, country: string): Promise<IpcResult<void>> =>
      invoke(IPC.phoneSetLabel, id, label, country),
    assign: (accountId: number, phoneId: number | null): Promise<IpcResult<void>> =>
      invoke(IPC.phoneAssign, accountId, phoneId),
    authEvents: (limit?: number): Promise<IpcResult<AuthEventDto[]>> =>
      invoke(IPC.phoneAuthEvents, limit),
    onUpdated: (cb: (list: PhoneDto[]) => void): (() => void) => {
      const h = (_: unknown, list: PhoneDto[]): void => cb(list)
      ipcRenderer.on(IPC.phoneUpdated, h)
      return () => ipcRenderer.off(IPC.phoneUpdated, h)
    },
    onAuthWaiting: (cb: (dto: PhoneAuthWaitingDto) => void): (() => void) => {
      const h = (_: unknown, dto: PhoneAuthWaitingDto): void => cb(dto)
      ipcRenderer.on(IPC.phoneAuthWaiting, h)
      return () => ipcRenderer.off(IPC.phoneAuthWaiting, h)
    }
  },
```
- [ ] Step 7: `pnpm test -- phone-devices` 통과 → `pnpm typecheck` → 커밋: `폰 기기 관리 추가: 5초 폴링·와이파이 연결·끊김 1회 복구와 IPC 배선`

---

### Task 4: 폰 UI 트리 + 화면 좌표 환산 + 입력 전달

**Files:** Create `src/shared/phone-snapshot.ts`, `src/main/phone/{uitree,input}.ts`; Test `tests/phone-uitree.test.ts`, `tests/phone-snapshot.test.ts`, `tests/phone-input.test.ts`

**Interfaces:**
```ts
// src/shared/phone-snapshot.ts — 웹 PageSnapshot 과 같은 번호 체계·상한 규칙
export interface PhoneElement {
  id: number
  text: string
  resourceId?: string
  contentDesc?: string
  className: string
  clickable: boolean
  bounds: { l: number; t: number; r: number; b: number }
  center: { x: number; y: number }
  isSecret: boolean
}
export interface PhoneScreen {
  serial: string
  width: number
  height: number
  app: string
  elements: PhoneElement[]
}
export const MAX_PHONE_ELEMENTS = 120
export function serializePhoneScreen(s: PhoneScreen): string
export function findElement(s: PhoneScreen, id: number): PhoneElement | null

// src/main/phone/uitree.ts
export function parseUiXml(xml: string, serial: string, app: string): PhoneScreen
export function isSecretNode(attrs: Record<string, string>): boolean
export async function dumpScreen(adb: AdbRunner, serial: string): Promise<PhoneScreen>

// src/main/phone/input.ts
export function toDeviceCoord(point, viewSize, deviceSize): { x: number; y: number }
export async function tap(adb, serial, x, y): Promise<void>
export async function swipe(adb, serial, from, to, ms): Promise<void>
export async function typeText(adb, serial, text): Promise<void>
export async function pressKey(adb, serial, key: PhoneKey): Promise<void>
```

- [ ] Step 1: 실패 테스트 `tests/phone-uitree.test.ts` — 고정 XML(`tests/fixtures/uiautomator-toss.xml`, 실제 덤프를 축약해 저장)로 ① `bounds="[0,100][720,200]"` 이 `{l:0,t:100,r:720,b:200}` 와 `center {x:360,y:150}` 로 파싱 ② `clickable="true"` 이거나 텍스트가 있는 노드만 요소가 되고, 번호는 **1부터** 순서대로 ③ 요소 수가 `MAX_PHONE_ELEMENTS` 를 넘으면 앞에서 잘린다 ④ `password="true"` 노드는 `isSecret: true` 이고 `text` 가 빈 문자열 ⑤ `resource-id` 가 `...:id/pin_keypad`·`password`·`pwd` 류면 `isSecret: true` ⑥ 깨진 XML 이면 빈 `elements` 를 돌려주고 던지지 않는다 ⑦ 화면 크기는 루트 `<hierarchy rotation>` 이 아니라 최상위 노드 bounds 에서 얻는다.
- [ ] Step 2: `src/main/phone/uitree.ts` 구현(의존성 없이 속성 정규식으로 파싱).
```ts
// uiautomator dump XML 파싱. 외부 XML 파서를 쓰지 않는다 —
// 덤프는 자기 종료 <node .../> 만 있는 단순 구조라 속성 스캔으로 충분하고,
// 새 의존성 없이 순수 함수로 테스트할 수 있다

import {
  MAX_PHONE_ELEMENTS,
  type PhoneElement,
  type PhoneScreen
} from '../../shared/phone-snapshot'

const NODE_RE = /<node\b([^>]*)\/?>/g
const ATTR_RE = /(\S+?)="([^"]*)"/g
const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/
// 비밀 입력칸으로 보는 resource-id 패턴(웹 스냅샷의 isSecret 과 같은 취지)
const SECRET_ID_RE = /(pin|passwd|password|pwd|keypad|secure)/i

export function isSecretNode(attrs: Record<string, string>): boolean {
  if (attrs.password === 'true') return true
  return SECRET_ID_RE.test(attrs['resource-id'] ?? '')
}

function readAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m = ATTR_RE.exec(raw)
  while (m) {
    out[m[1]] = unescapeXml(m[2])
    m = ATTR_RE.exec(raw)
  }
  return out
}

function unescapeXml(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function parseUiXml(xml: string, serial: string, app: string): PhoneScreen {
  const elements: PhoneElement[] = []
  let width = 0
  let height = 0
  NODE_RE.lastIndex = 0
  let m = NODE_RE.exec(xml)
  while (m) {
    const attrs = readAttrs(m[1])
    const b = BOUNDS_RE.exec(attrs.bounds ?? '')
    m = NODE_RE.exec(xml)
    if (!b) continue
    const bounds = { l: +b[1], t: +b[2], r: +b[3], b: +b[4] }
    // 가장 바깥 노드가 화면 크기다
    width = Math.max(width, bounds.r)
    height = Math.max(height, bounds.b)
    const secret = isSecretNode(attrs)
    const text = secret ? '' : (attrs.text ?? '').trim()
    const desc = secret ? '' : (attrs['content-desc'] ?? '').trim()
    const clickable = attrs.clickable === 'true'
    // 누를 수 있거나 읽을 거리가 있는 노드만 AI 에게 보인다
    if (!clickable && !text && !desc && !secret) continue
    if (bounds.r <= bounds.l || bounds.b <= bounds.t) continue
    if (elements.length >= MAX_PHONE_ELEMENTS) continue
    elements.push({
      id: elements.length + 1,
      text,
      resourceId: attrs['resource-id'] || undefined,
      contentDesc: desc || undefined,
      className: attrs.class ?? '',
      clickable,
      bounds,
      center: {
        x: Math.round((bounds.l + bounds.r) / 2),
        y: Math.round((bounds.t + bounds.b) / 2)
      },
      isSecret: secret
    })
  }
  return { serial, width, height, app, elements }
}

/** 폰에서 덤프를 떠 와 파싱한다. 실패(보안 앱·게임)하면 elements 가 빈 화면을 돌려준다 */
export async function dumpScreen(adb: AdbRunner, serial: string): Promise<PhoneScreen> {
  const app = await currentApp(adb, serial)
  const dumped = await adb.run(shellArgs(serial, 'uiautomator dump /sdcard/samba-ui.xml'))
  if (dumped.code !== 0) return { serial, width: 0, height: 0, app, elements: [] }
  const xml = await adb.run(shellArgs(serial, 'cat /sdcard/samba-ui.xml'), 20_000)
  return parseUiXml(xml.stdout, serial, app)
}

/** 현재 최상위 패키지명. 결제 앱 판정(guard 확인 카드)에도 쓴다 */
export async function currentApp(adb: AdbRunner, serial: string): Promise<string> {
  const res = await adb.run(
    shellArgs(serial, ['dumpsys', 'window', 'displays', '|', 'grep', '-E', 'mCurrentFocus'])
  )
  return /\s([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/.exec(res.stdout)?.[1] ?? ''
}
```
- [ ] Step 3: `src/shared/phone-snapshot.ts` — 웹 `serializeSnapshot` 과 **같은 줄 모양**으로 직렬화한다.
```ts
// AI 가 보는 폰 화면. 웹 PageSnapshot 과 같은 번호 체계·같은 줄 모양을 쓴다
// (src/shared/snapshot.ts 의 formatElement 규칙을 그대로 따른다)

export const MAX_PHONE_ELEMENTS = 120

function formatElement(e: PhoneElement): string {
  const parts = [`[${e.id}] ${e.className.split('.').pop() ?? 'node'}`]
  if (e.text) parts.push(`"${e.text.slice(0, 80)}"`)
  if (e.contentDesc) parts.push(`desc=${e.contentDesc.slice(0, 60)}`)
  if (e.resourceId) parts.push(`id=${e.resourceId.split('/').pop()}`)
  if (e.clickable) parts.push('(clickable)')
  if (e.isSecret) parts.push('(SECRET)')
  return parts.join(' ')
}

export function serializePhoneScreen(s: PhoneScreen): string {
  return [
    `PHONE: ${s.serial}`,
    `APP: ${s.app}`,
    `SIZE: ${s.width}x${s.height}`,
    '',
    'ELEMENTS:',
    ...s.elements.slice(0, MAX_PHONE_ELEMENTS).map(formatElement)
  ].join('\n')
}

export function findElement(s: PhoneScreen, id: number): PhoneElement | null {
  return s.elements.find((e) => e.id === id) ?? null
}
```
  `tests/phone-snapshot.test.ts` — ① 직렬화 결과에 **비밀 노드의 text 가 없다** ② 요소 줄이 `[번호] 클래스 "텍스트"` 형식 ③ 상한(120) 초과분이 잘린다 ④ `findElement` 가 없는 번호에 null.
- [ ] Step 4: 실패 테스트 `tests/phone-input.test.ts` — ① `toDeviceCoord` 가 뷰(예: 320×711)에서 누른 지점을 폰 해상도(720×1600)로 비례 환산하고 경계 밖 값을 잘라 낸다 ② `tap` 이 `['-s',serial,'shell','input','tap','360','800']` 을 부른다 ③ `swipe` 가 지속 시간 인자를 마지막에 붙인다 ④ `typeText` 가 공백을 `%s` 로 바꾸고 작은따옴표를 이스케이프한다 ⑤ **한글·이모지가 섞이면 `input text` 를 쓰지 않고 `'unsupported-text'` 를 돌려준다**(ASCII 만 허용, 그 외는 호출부가 요소 탭으로 우회) ⑥ `pressKey('back')` → `input keyevent KEYCODE_BACK`, 알 수 없는 키는 던진다.
- [ ] Step 5: `src/main/phone/input.ts` 구현.
```ts
// 폰 입력 전달. 1순위는 `adb shell input` 이다(단순·안정).
// input text 는 ASCII 만 안전하므로 그 외 문자는 거부하고 호출부가 요소 탭으로 우회한다

export const PHONE_KEYS = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  power: 'KEYCODE_POWER',
  recent: 'KEYCODE_APP_SWITCH',
  delete: 'KEYCODE_DEL'
} as const
export type PhoneKey = keyof typeof PHONE_KEYS

const ASCII_ONLY_RE = /^[\x20-\x7e]*$/

/** 화면에 그린 폰 뷰 좌표 → 실제 폰 픽셀 좌표 */
export function toDeviceCoord(
  point: { x: number; y: number },
  view: { width: number; height: number },
  device: { width: number; height: number }
): { x: number; y: number } {
  if (view.width <= 0 || view.height <= 0) return { x: 0, y: 0 }
  const x = Math.round((point.x / view.width) * device.width)
  const y = Math.round((point.y / view.height) * device.height)
  return {
    x: Math.max(0, Math.min(device.width - 1, x)),
    y: Math.max(0, Math.min(device.height - 1, y))
  }
}

export async function tap(adb: AdbRunner, serial: string, x: number, y: number): Promise<void> {
  await adb.run(shellArgs(serial, ['input', 'tap', String(Math.round(x)), String(Math.round(y))]))
}

export async function swipe(
  adb: AdbRunner,
  serial: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  ms = 300
): Promise<void> {
  await adb.run(
    shellArgs(serial, [
      'input',
      'swipe',
      String(Math.round(from.x)),
      String(Math.round(from.y)),
      String(Math.round(to.x)),
      String(Math.round(to.y)),
      String(ms)
    ])
  )
}

/** ASCII 만 보낸다. 한글 등은 'unsupported-text' 를 돌려주고 호출부가 다른 길을 택한다 */
export async function typeText(
  adb: AdbRunner,
  serial: string,
  text: string
): Promise<'ok' | 'unsupported-text'> {
  if (!ASCII_ONLY_RE.test(text)) return 'unsupported-text'
  const escaped = text.replace(/ /g, '%s').replace(/'/g, "\\'")
  await adb.run(shellArgs(serial, ['input', 'text', escaped]))
  return 'ok'
}

export async function pressKey(adb: AdbRunner, serial: string, key: PhoneKey): Promise<void> {
  const code = PHONE_KEYS[key]
  if (!code) throw new Error(`unknown key: ${key}`)
  await adb.run(shellArgs(serial, ['input', 'keyevent', code]))
}
```
- [ ] Step 6: `pnpm test -- phone-uitree phone-snapshot phone-input` 통과 → 커밋: `폰 화면 읽기·입력 추가: uiautomator 트리 파싱과 좌표 환산·input 전달`

---

### Task 5: 폰 화면 스트림 — 동영상(h264) + 간이 화면 폴백 + scrcpy 별도 창

**Files:** Create `src/main/phone/{h264,screen}.ts`; Modify `src/main/phone/service.ts`, `handlers.ts`, `preload/renderer.ts`, `samba.d.ts`; Test `tests/phone-h264.test.ts`, `tests/phone-screen.test.ts`

**Interfaces:**
```ts
// src/main/phone/h264.ts (순수)
export function splitAnnexB(buffer: Buffer): Buffer[]          // NAL 단위로 자른다
export function nalType(nal: Buffer): number
export function hasKeyframe(nals: Buffer[]): boolean           // SPS(7)/IDR(5) 포함 여부
export class AnnexBAssembler {                                  // 청크 경계를 넘겨 NAL 을 이어 붙인다
  push(chunk: Buffer): Buffer[]
}

// src/main/phone/screen.ts
export interface ScreenChunk { serial: string; mode: ScreenMode; data: Buffer; keyframe: boolean }
export interface ScreenStreamDeps {
  adb: AdbRunner
  size: () => ScreenSize
  fps: () => ScreenFps
  onChunk: (c: ScreenChunk) => void
  onModeChange: (serial: string, mode: ScreenMode) => void
  now: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
}
export class ScreenStream {
  start(serial: string): void
  stop(serial: string): void
  stopAll(): void
}
/** 첫 키프레임을 이 시간 안에 못 받으면 간이 화면으로 내려간다 */
export const KEYFRAME_TIMEOUT_MS = 5000
/** screenrecord 한 세션 길이(안드로이드 상한 180초보다 짧게) */
export const RECORD_SEGMENT_MS = 170_000
/** 간이 화면 캡처 주기 */
export const STILL_INTERVAL_MS = 1000
```

- [ ] Step 1: 실패 테스트 `tests/phone-h264.test.ts` — ① `splitAnnexB` 가 3바이트(`00 00 01`)·4바이트(`00 00 00 01`) 시작 코드를 모두 인식 ② `nalType` 이 첫 바이트 하위 5비트를 돌려준다 ③ SPS(7)+PPS(8)+IDR(5) 가 들어간 배열에 `hasKeyframe` 이 true, 비-IDR(1)만이면 false ④ `AnnexBAssembler` 가 **NAL 이 청크 경계에서 잘려도** 두 청크를 합쳐 온전한 NAL 을 돌려준다 ⑤ 남은 꼬리는 다음 push 까지 보관된다.
- [ ] Step 2: `src/main/phone/h264.ts` 구현.
```ts
// H.264 Annex-B 파싱(순수). 렌더러 WebCodecs 가 디코드할 수 있게
// 청크 경계에서 잘린 NAL 을 이어 붙이고 키프레임 도착을 알린다

const START_CODE_3 = Buffer.from([0, 0, 1])

export function nalType(nal: Buffer): number {
  return nal.length > 0 ? nal[0] & 0x1f : 0
}

/** 시작 코드로 잘라 NAL 페이로드 배열을 돌려준다(시작 코드는 제거) */
export function splitAnnexB(buffer: Buffer): Buffer[] {
  const out: Buffer[] = []
  let i = buffer.indexOf(START_CODE_3)
  if (i < 0) return out
  let start = i + 3
  while (start < buffer.length) {
    const next = buffer.indexOf(START_CODE_3, start)
    if (next < 0) {
      out.push(buffer.subarray(start))
      break
    }
    // 4바이트 시작 코드면 앞의 0 하나를 빼고 자른다
    const end = next > start && buffer[next - 1] === 0 ? next - 1 : next
    out.push(buffer.subarray(start, end))
    start = next + 3
  }
  return out.filter((n) => n.length > 0)
}

export function hasKeyframe(nals: Buffer[]): boolean {
  return nals.some((n) => nalType(n) === 5 || nalType(n) === 7)
}

/** 스트림 청크를 모아 온전한 NAL 만 내보낸다(마지막 미완성 NAL 은 보관) */
export class AnnexBAssembler {
  private tail = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    const buf = Buffer.concat([this.tail, chunk])
    const last = buf.lastIndexOf(START_CODE_3)
    if (last < 0) {
      this.tail = buf
      return []
    }
    const head = buf.subarray(0, last)
    this.tail = buf.subarray(last)
    return splitAnnexB(head)
  }
}
```
- [ ] Step 3: 실패 테스트 `tests/phone-screen.test.ts`(가짜 adb·가짜 타이머) — ① `start(serial)` 이 `exec-out screenrecord --output-format=h264 --size 720x1600 --bit-rate 2000000 --time-limit 170 -` 으로 스트림을 연다 ② 키프레임이 든 청크가 오면 `onChunk({mode:'video', keyframe:true})` ③ **5초 안에 키프레임이 없으면** `onModeChange(serial,'still')` 후 1초 주기 `exec-out screencap -p` 로 바뀐다 ④ 스트림 프로세스가 죽으면(세션 상한) 자동으로 다시 연다 ⑤ `stop` 후에는 어떤 청크도 나가지 않고 타이머가 남지 않는다 ⑥ 간이 화면 모드에서 `screencap` 이 빈 버퍼를 돌려주면 그 프레임만 건너뛴다(스트림 중단 없음).
- [ ] Step 4: `src/main/phone/screen.ts` 구현 — 위 인터페이스대로. 화면 크기는 `--size ${size}x${Math.round(size * 16 / 9)}` 가 아니라 **폰 실제 비율**(`wm size` 조회 결과의 긴 변을 `size` 로 맞춘 값)을 쓰고, 조회 실패 시 `--size` 를 생략해 기기 기본값으로 둔다. 청크는 `send(IPC.phoneScreenChunk, { serial, mode, keyframe, data })` 로 렌더러에 보낸다(Buffer 는 구조화 복제로 그대로 간다).
- [ ] Step 5: scrcpy 별도 창 — `service.ts` 에 `openWindow(serial)` 을 추가한다. `spawn(settings.get().scrcpyPath, ['-s', serial, '--video-codec=h264', `--max-size=${size}`, `--max-fps=${fps}`, '--no-audio', '--stay-awake', '--video-bit-rate=2M'])`, 경로가 비었으면 `'scrcpy path is not set'` 을 던진다. 프로세스는 폰별 1개만 유지한다.
- [ ] Step 6: IPC 배선(`phoneScreenStart`/`phoneScreenStop`/`phoneOpenWindow`) + preload `phone.screenStart/screenStop/openWindow/onScreenChunk` 추가.
- [ ] Step 7: `pnpm test -- phone-h264 phone-screen` 통과 → `pnpm typecheck` → 커밋: `폰 화면 스트림 추가: h264 파이프와 간이 화면 폴백, scrcpy 별도 창`

---

### Task 6: 문자 인증번호 추출과 폴링

**Files:** Create `src/main/phone/sms.ts`; Test `tests/phone-sms.test.ts`, `tests/fixtures/sms-inbox.txt`

**Interfaces:**
```ts
export interface SmsRow { address: string; body: string; dateMs: number }
export interface SmsCandidate { code: string; senderTail: string; score: number; dateMs: number }

export function parseSmsQuery(stdout: string): SmsRow[]
export function extractCodes(body: string): string[]
export function scoreRow(row: SmsRow, ctx: { now: number; siteHost: string }): SmsCandidate | null
export function pickAuthCode(rows: SmsRow[], ctx: { now: number; siteHost: string }): SmsCandidate | null

export interface SmsWatchDeps {
  adb: AdbRunner
  serials: () => string[]
  siteHost: string
  now: () => number
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
}
/** 3대를 1초 주기로 동시에 보고 먼저 온 인증번호를 돌려준다. 3분이면 null */
export async function watchSms(deps: SmsWatchDeps): Promise<(SmsCandidate & { serial: string }) | null>
```

- [ ] Step 1: 실패 테스트 `tests/phone-sms.test.ts` — 고정 출력 픽스처로 ① `parseSmsQuery` 가 `Row: 0 _id=12, address=15881234, body=[Web발신] 인증번호 [493028] 입력, date=1758200000000` 을 파싱 ② 본문에 쉼표가 있어도 `date=` 앞까지를 body 로 본다(마지막 필드 경계 기준 분리) ③ `Permission Denial` 출력이면 빈 배열 ④ `extractCodes` 가 4~8자리 숫자만 뽑고 전화번호(10자리 이상)·금액(원/₩ 인접)은 제외 ⑤ `scoreRow` 가 **3분 지난 문자를 버린다** ⑥ 본문에 사이트 브랜드 토큰(host 의 첫 라벨, 예: `toss`)이 들어 있으면 점수가 높다 ⑦ "인증번호"·"verification"·"code" 문구가 있으면 가점 ⑧ 같은 점수면 **더 최근** 문자를 고른다 ⑨ `pickAuthCode` 결과에 **본문이 없다**(`code`·`senderTail`·`score`·`dateMs` 만) ⑩ `watchSms` 가 1초 주기로 3대를 돌고 먼저 후보를 낸 폰의 serial 을 함께 돌려준다 ⑪ 3분(`AUTH_TIMEOUT_MS`)이 지나면 null ⑫ `cancelled()` 가 true 가 되면 즉시 null.
- [ ] Step 2: `src/main/phone/sms.ts` 구현.
```ts
// 문자 인증번호 추출. 본문은 절대 호출부 밖으로 내보내지 않는다 —
// 이 파일이 돌려주는 것은 숫자 코드와 발신번호 뒷 4자리뿐이다(스펙 "안전" 절)

import { AUTH_TIMEOUT_MS, SMS_POLL_INTERVAL_MS, SMS_RECENT_MS } from '../../shared/phone'
import { shellArgs } from './adb'
import type { AdbRunner } from './process'

// content query 한 줄: `Row: 0 _id=12, address=15881234, body=..., date=1758200000000`
const ROW_RE = /^Row:\s*\d+\s+(.*)$/
const DENIED_RE = /Permission Denial|SecurityException/i
// 4~8자리 숫자. 앞뒤가 숫자면(전화번호 등) 후보에서 뺀다
const CODE_RE = /(?<!\d)(\d{4,8})(?!\d)/g
// 인증 문맥 단어
const CONTEXT_RE = /인증(번호)?|확인번호|verification|one[- ]?time|OTP|code/i
// 금액으로 보이는 숫자(원·₩·,000 인접)는 제외
const MONEY_RE = /[₩]|원\b/

export const SMS_QUERY_ARGS = [
  'content',
  'query',
  '--uri',
  'content://sms/inbox',
  '--projection',
  '_id:address:body:date',
  '--sort',
  'date DESC'
]

export function parseSmsQuery(stdout: string): SmsRow[] {
  if (DENIED_RE.test(stdout)) return []
  const rows: SmsRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = ROW_RE.exec(line.trim())
    if (!m) continue
    const fields = m[1]
    const address = /(?:^|,\s)address=(.*?)(?=,\s\w+=|$)/.exec(fields)?.[1]?.trim() ?? ''
    // body 는 쉼표를 품을 수 있어 "다음 필드 이름 앞" 까지를 잡는다
    const body = /(?:^|,\s)body=([\s\S]*?)(?=,\s(?:date|_id|address)=|$)/.exec(fields)?.[1] ?? ''
    const date = Number(/(?:^|,\s)date=(\d+)/.exec(fields)?.[1] ?? '0')
    if (!body) continue
    rows.push({ address, body, dateMs: date })
  }
  return rows
}

export function extractCodes(body: string): string[] {
  const out: string[] = []
  CODE_RE.lastIndex = 0
  let m = CODE_RE.exec(body)
  while (m) {
    const around = body.slice(Math.max(0, m.index - 2), m.index + m[1].length + 2)
    if (!MONEY_RE.test(around)) out.push(m[1])
    m = CODE_RE.exec(body)
  }
  return out
}

/** 사이트 브랜드 토큰 — host 의 등록 도메인 첫 라벨(예: toss.im → toss) */
export function brandToken(siteHost: string): string {
  const labels = siteHost.split('.').filter((l) => l && l !== 'www' && l !== 'm')
  return labels[0] ?? ''
}

export function scoreRow(
  row: SmsRow,
  ctx: { now: number; siteHost: string }
): SmsCandidate | null {
  if (ctx.now - row.dateMs > SMS_RECENT_MS) return null
  const codes = extractCodes(row.body)
  if (codes.length === 0) return null
  let score = 1
  if (CONTEXT_RE.test(row.body)) score += 2
  const brand = brandToken(ctx.siteHost)
  if (brand && row.body.toLowerCase().includes(brand.toLowerCase())) score += 3
  // 6자리는 인증번호로 가장 흔하다
  const code = codes.find((c) => c.length === 6) ?? codes[0]
  if (code.length === 6) score += 1
  return { code, senderTail: row.address.slice(-4), score, dateMs: row.dateMs }
}

export function pickAuthCode(
  rows: SmsRow[],
  ctx: { now: number; siteHost: string }
): SmsCandidate | null {
  const candidates = rows
    .map((r) => scoreRow(r, ctx))
    .filter((c): c is SmsCandidate => c !== null)
    .sort((a, b) => b.score - a.score || b.dateMs - a.dateMs)
  return candidates[0] ?? null
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

export async function watchSms(
  deps: SmsWatchDeps
): Promise<(SmsCandidate & { serial: string }) | null> {
  const sleep = deps.sleep ?? defaultSleep
  const start = deps.now()
  // 감시 시작 시점보다 이전 문자는 무시한다(이전 인증번호 재사용 방지)
  while (deps.now() - start < AUTH_TIMEOUT_MS) {
    if (deps.cancelled?.()) return null
    for (const serial of deps.serials()) {
      const res = await deps.adb.run(shellArgs(serial, SMS_QUERY_ARGS), 8000)
      const rows = parseSmsQuery(res.stdout).filter((r) => r.dateMs >= start - SMS_RECENT_MS)
      const picked = pickAuthCode(rows, { now: deps.now(), siteHost: deps.siteHost })
      if (picked) return { ...picked, serial }
    }
    await sleep(SMS_POLL_INTERVAL_MS)
  }
  return null
}
```
- [ ] Step 3: `pnpm test -- phone-sms` 통과 → 커밋: `문자 인증번호 추출 추가: 문자함 조회 파싱·점수 선택·3대 동시 1초 폴링`

---

### Task 7: Visual 모델 호출 — 화면 속 인증번호 읽기와 키패드 배치

**Files:** Create `src/main/ai/visual.ts`; Test `tests/ai-visual.test.ts`

**Interfaces:**
```ts
export interface VisualDeps {
  fetch?: FetchLike
  apiKey: () => string | null
  model: () => string
}
export interface KeypadLayout {
  // 숫자 → 화면 좌표(폰 픽셀). 보안 키패드는 매번 배치가 달라 화면마다 새로 구한다
  digits: Record<string, { x: number; y: number }>
}
export async function readCodeFromImage(deps: VisualDeps, png: Buffer): Promise<string | null>
export async function readKeypadLayout(deps: VisualDeps, png: Buffer, size: { width: number; height: number }): Promise<KeypadLayout | null>
export function parseKeypadResponse(text: string, size: { width: number; height: number }): KeypadLayout | null
export const KEYPAD_PROMPT: string
export const CODE_PROMPT: string
```

- [ ] Step 1: 실패 테스트 `tests/ai-visual.test.ts`(네트워크 없이 가짜 fetch) — ① `CODE_PROMPT` 는 "화면에 보이는 인증번호 숫자만" 을 요구하고 **어떤 값을 입력하라는 지시가 없다** ② `KEYPAD_PROMPT` 에 **"어떤 숫자를 눌러야 하는지 묻는 문장이 없다"**(문자열 단언: `/눌러|press|input|enter/i` 불일치) ③ `readCodeFromImage` 가 모델 응답 `인증번호는 493028 입니다` 에서 `493028` 만 뽑고, 숫자가 없으면 null ④ `parseKeypadResponse` 가 JSON 배열 `[{"d":"0","x":0.2,"y":0.8}, …]` 의 **0~1 비율 좌표**를 픽셀로 환산 ⑤ 0~9 가 모두 없으면 null(부분 배치로는 비밀번호를 누르지 않는다) ⑥ 좌표가 화면 밖이면 null ⑦ API 키가 없으면 호출 없이 null ⑧ 응답이 200 이 아니면 null 이고 **응답 본문을 로그에 남기지 않는다**.
- [ ] Step 2: 구현. 호출은 Anthropic Messages API(`POST /v1/messages`)에 `image/png` base64 를 실어 보내며, 모델은 `resolveModel(settings.taskModels, 'visual', settings.aiProvider)` 를 쓴다. 프롬프트 상수:
```ts
// 화면에서 인증번호만 읽어 온다. "무엇을 입력하라" 는 지시는 절대 넣지 않는다
export const CODE_PROMPT =
  '이 스크린샷에 보이는 본인확인 인증번호(4~8자리 숫자)만 한 줄로 답하세요. 없으면 NONE 이라고만 답하세요.'

// 보안 키패드 배치만 묻는다. 어떤 숫자를 누를지는 묻지 않는다(값은 모델에 가지 않는다)
export const KEYPAD_PROMPT =
  '이 스크린샷은 숫자 키패드입니다. 0부터 9까지 각 숫자가 화면의 어느 위치에 있는지만 알려주세요. ' +
  '출력은 JSON 배열 하나로만, 각 원소는 {"d":"숫자","x":가로비율,"y":세로비율} 이고 비율은 0~1 사이 소수입니다. ' +
  '설명 문장은 쓰지 마세요.'
```
  `readKeypadLayout` 은 0~9 가 전부 있고 좌표가 화면 안일 때만 `KeypadLayout` 을 돌려준다.
- [ ] Step 3: 로컬 GGUF(Qwen2.5-VL) 경로는 **이번 단계에서 구현하지 않는다**. `visual.ts` 는 `apiKey()` 가 null 이면 즉시 null 을 돌려주고, 호출부는 "Visual 모델이 연결되지 않았습니다 → 설정 → AI 연결" 안내 카드를 띄운다(스펙의 로컬 모델 폴백은 4단계 이후로 미룸 — 자체 점검의 '스펙 대비 조정' 참고).
- [ ] Step 4: `pnpm test -- ai-visual` 통과 → 커밋: `Visual 모델 호출 추가: 화면 인증번호 읽기와 키패드 배치 전용 프롬프트`

---

### Task 8: 폰 AI 도구 6종 + 권한 모드 · Pro 게이트

**Files:** Create `src/main/agent/tools-phone.ts`; Modify `src/main/agent/tools.ts`, `src/main/agent/runner.ts`; Test `tests/phone-tools.test.ts`

**Interfaces:**
```ts
export interface PhoneToolContext {
  // 주의: vault 필드가 없다 — 폰 도구는 금고 값에 접근할 수 없다(테스트로 단언)
  phones: PhoneOps
  mode: PermissionMode
  isPro: () => boolean
  // 배정된 폰 serial. 없으면 연결된 첫 폰
  assigned: () => string | null
  confirm: (action: string, kind?: 'danger' | 'finish') => Promise<boolean>
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
}

export interface PhoneOps {
  list: () => PhoneDto[]
  screen: (serial: string) => Promise<PhoneScreen>
  tap: (serial: string, x: number, y: number) => Promise<void>
  swipe: (serial: string, from: Point, to: Point, ms?: number) => Promise<void>
  typeText: (serial: string, text: string) => Promise<'ok' | 'unsupported-text'>
  key: (serial: string, key: PhoneKey) => Promise<void>
  screenshot: (serial: string) => Promise<{ png: Buffer; secret: boolean }>
}

export function createPhoneTools(ctx: PhoneToolContext): SdkMcpToolDefinition<never>[]
export const PHONE_TOOL_NAMES: string[]
/** guard 모드에서 조작 전 확인 카드를 받아야 하는 앱 패키지 */
export const PAYMENT_PACKAGES: string[]
```

- [ ] Step 1: 실패 테스트 `tests/phone-tools.test.ts` — ① 6개 도구 이름이 `phone_get_screen`·`phone_tap`·`phone_type`·`phone_key`·`phone_swipe`·`phone_screenshot` ② `read_only` 모드에서 `phone_tap/type/key/swipe` 가 `refused: read-only mode`, `phone_get_screen`·`phone_screenshot` 은 동작 ③ `isPro()` false 면 6개 전부 `refused: phone requires Pro plan` ④ `phone_tap({elementId})` 가 요소 `center` 좌표로 탭하고, 없는 번호면 `'not found'` ⑤ `phone_tap({x,y})` 직접 좌표도 동작 ⑥ 연결된 폰이 없으면 `'no phone connected'` ⑦ `guard` 모드에서 현재 앱이 `PAYMENT_PACKAGES` 에 있으면 `confirm` 이 호출되고 거부 시 `'refused: user declined'` ⑧ `phone_type` 이 한글이면 `'unsupported-text: use phone_tap on the keyboard'` ⑨ `phone_screenshot` 이 비밀번호 화면(`secret: true`)이면 **이미지를 돌려주지 않고** `'refused: secret screen'` ⑩ 모든 도구가 `ctx.tick()` 상한을 공유한다(웹 도구와 같은 40회 카운터) ⑪ **`PhoneToolContext` 객체에 `vault` 키가 없다**(`Object.keys` 단언).
- [ ] Step 2: `src/main/agent/tools-phone.ts` 구현. 도구 설명은 영어(모델용), 주석은 한국어.
```ts
// 폰 AI 도구 6종. 금고에 접근하지 않는다 — 비밀값은 pay-secret.ts 만 다룬다.
// 호출 상한(tick)·진행 로그(onStep)는 웹 도구와 같은 것을 공유한다

const READ_ONLY_REFUSAL = 'refused: read-only mode'
const NOT_PRO = 'refused: phone requires Pro plan'
const NO_PHONE = 'no phone connected'
const NOT_FOUND = 'not found'
const SECRET_SCREEN = 'refused: secret screen'
const USER_DECLINED = 'refused: user declined'

// guard 모드에서 조작 전 확인을 받는 앱(간편결제·은행)
export const PAYMENT_PACKAGES = [
  'viva.republica.toss',
  'com.nhnent.payapp', // 페이코
  'com.kakao.talk',
  'com.nhn.android.search' // 네이버앱(네이버페이)
]
```
  각 도구는 `phone_get_screen` → `serializePhoneScreen`, `phone_tap` → 요소 번호 또는 좌표, `phone_type` → `typeText` 결과 전달, `phone_key` → `PHONE_KEYS` 키만, `phone_swipe` → 좌표 2점 + ms, `phone_screenshot` → `secret` 이면 거부하고 아니면 이미지 블록(`{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }`)을 돌려준다.
- [ ] Step 3: `tools.ts` 에 등록한다 — `createSambaTools` 의 `ToolContext` 에 `phone?: PhoneToolContext` 를 선택 필드로 추가하고, `tools:` 배열 뒤에 `...(ctx.phone ? createPhoneTools(ctx.phone) : [])` 를 붙인다. `SAMBA_TOOL_NAMES` 에 `PHONE_TOOL_NAMES` 를 이어 붙인다(주입되지 않은 실행에서도 이름은 허용 목록에 있어야 모델이 호출 시 거부 문구를 받는다).
- [ ] Step 4: `runner.ts` 의 `createSambaTools({...})` 에 `phone` 컨텍스트를 넘긴다(`AgentRunner` 생성자에 `phones?: PhoneService` 추가, `handlers.ts` 에서 주입). `mode`·`tick`·`onStep`·`confirm` 은 기존 것을 그대로 공유한다.
- [ ] Step 5: `src/main/agent/prompt.ts` 의 시스템 프롬프트에 폰 도구 안내 한 문단을 추가한다: 폰 화면은 `phone_get_screen` 의 요소 번호로 다루고, **결제 비밀번호·PIN 은 절대 `phone_type` 으로 입력하지 말 것**(앱이 대신 입력한다), 인증번호는 사용자가 아니라 앱이 자동으로 채운다는 점.
- [ ] Step 6: `pnpm test -- phone-tools agent-tools` 통과 → `pnpm typecheck` → 커밋: `폰 AI 도구 6종 추가: 권한 모드·Pro 게이트와 도구 호출 상한 공유`

---

### Task 9: 문자 인증 자동 입력 오케스트레이션 + ARS 수신 감지

**Files:** Create `src/main/phone/auth-flow.ts`; Modify `src/main/browser/page-bridge.ts`(코드 입력칸 탐지 추가), `src/main/agent/tools.ts`(도구 1종 추가), `src/main/phone/service.ts`; Test `tests/phone-auth-flow.test.ts`

**Interfaces:**
```ts
/** 웹 스냅샷에서 인증번호 입력칸 후보를 고른다(순수) */
export function findCodeField(snapshot: PageSnapshot): PageElement | null

export interface AuthFlowDeps {
  adb: AdbRunner
  serials: () => string[]
  siteHost: string
  jobId?: string
  snapshot: () => Promise<PageSnapshot>
  fillValue: (elementId: number, value: string) => Promise<string>
  submit: (elementId: number) => Promise<string>
  autoSubmit: boolean
  screenshot: (serial: string) => Promise<Buffer>
  readCodeFromImage: (png: Buffer) => Promise<string | null>
  record: (e: Omit<AuthEventDto, 'id'>) => void
  notify: (dto: PhoneAuthWaitingDto) => void
  now: () => number
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
}
export type AuthFlowResult =
  | { ok: true; method: AuthEventMethod; elapsedMs: number }
  | { ok: false; reason: 'no-field' | 'timeout' | 'fill-failed' | 'no-phone' }

export async function runSmsAuth(deps: AuthFlowDeps): Promise<AuthFlowResult>

/** 통화 상태 조회 — 0 대기 · 1 수신중 · 2 통화중 */
export async function callState(adb: AdbRunner, serial: string): Promise<0 | 1 | 2>
export async function detectIncomingCall(adb: AdbRunner, serials: string[]): Promise<string | null>
```

- [ ] Step 1: 실패 테스트 `tests/phone-auth-flow.test.ts` — ① `findCodeField` 가 `inputType: 'tel'`·`'number'` 또는 name/text 에 `인증번호|확인번호|verification|code|otp` 가 든 요소를 고르고, 비밀 입력칸(`isSecret`)은 고르지 않는다 ② 후보가 없으면 `{ok:false, reason:'no-field'}` 이고 **폴링을 시작하지 않는다** ③ 정상 흐름: `notify({waiting:true})` → 문자 감지 → `fillValue` → `autoSubmit` 이 true 면 `submit` 호출 → `notify({waiting:false})` → `record({kind:'sms', ok:true, method:'sms_query'})` ④ `autoSubmit` 이 false 면 `submit` 을 부르지 않고도 성공 처리 ⑤ 3분 안에 문자가 없으면 **스크린샷 → Visual** 폴백으로 넘어가고 성공 시 `method:'visual'` 로 기록 ⑥ Visual 도 실패하면 `{ok:false, reason:'timeout'}` + `record({ok:false})` ⑦ 기록된 이벤트에 **문자 본문이 없고** `code`·`senderTail` 만 있다 ⑧ 연결된 폰이 0대면 `{ok:false, reason:'no-phone'}` ⑨ `detectIncomingCall` 이 `mCallState=1` 인 폰의 serial 을 돌려준다.
- [ ] Step 2: `page-bridge.ts` 에 `findCodeField(tab)` 을 추가한다 — 기존 `findLoginFields` 와 같은 방식으로 스냅샷을 받아 위 순수 함수를 적용한다(격리 월드 스크립트 재사용, 새 페이지 채널 없음).
- [ ] Step 3: `auth-flow.ts` 구현. 순서는 스펙 그대로: 후보 선정 → `notify(waiting)` → `watchSms`(3대 동시 1초) → `fillValue` → 자동 제출 → 실패 시 Visual 폴백 → `record` → `notify(done)`. **문자 본문은 `watchSms` 밖으로 나오지 않는다**(`SmsCandidate` 에 body 필드가 없다).
- [ ] Step 4: AI 도구 `wait_for_sms_code` 를 `tools-phone.ts` 에 1종 더 추가한다(입력 `{ host? }`, 출력 `'filled: ####'` 의 **마스킹된** 결과 또는 `'timeout'`). 모델에게 인증번호 값을 돌려주지 않는다 — 이미 페이지에 채워졌기 때문이다.
- [ ] Step 5: ARS — `PhoneService` 가 인증 대기 중 3초마다 `detectIncomingCall` 을 돌려 수신이 감지되면 `notify({kind:'ars'})` + 채팅에 진행 로그 `전화 인증 수신 감지: 폰 화면을 확인하세요` 를 남긴다. **자동 응답·키패드 입력은 하지 않는다**(5단계).
- [ ] Step 6: `pnpm test -- phone-auth-flow` 통과 → 커밋: `문자 인증 자동 입력 추가: 입력칸 탐지·3분 타임아웃·Visual 폴백과 ARS 수신 감지`

---

### Task 10: 간편결제 앱 승인 흐름 + 결제 비밀번호 안전 입력

**Files:** Create `src/main/phone/{pay,pay-secret}.ts`; Modify `src/main/browser/tab-manager.ts`(팝업 WebContents 등록), `src/main/agent/tools-phone.ts`; Test `tests/phone-pay.test.ts`, `tests/phone-pay-secret.test.ts`

**Interfaces:**
```ts
// src/main/phone/pay.ts
export type PayState = 'idle' | 'await_app' | 'app_steps' | 'password' | 'verify' | 'done' | 'failed'
export type PayProvider = 'toss' | 'payco' | 'kakaopay' | 'naverpay'

export interface PayProviderSpec {
  id: PayProvider
  packageName: string
  deepLink: string
  // 진행 버튼 텍스트 후보(정규식). 사이트·앱별 차이는 데이터로 둔다
  confirmText: RegExp
  // 비밀번호 화면임을 알리는 표식
  passwordHint: RegExp
  successHint: RegExp
}
export const PAY_PROVIDERS: Record<PayProvider, PayProviderSpec>

/** 화면을 보고 다음 상태를 정하는 순수 전이 함수 */
export function nextPayState(
  state: PayState,
  screen: PhoneScreen,
  spec: PayProviderSpec
): { state: PayState; tapElementId?: number }

export type PayGate = 'ok' | 'over-limit' | 'first-run-too-large' | 'vault-locked'
export function checkPaymentGate(input: {
  amountKrw: number
  limitKrw: number
  isFirstRunForCombo: boolean
  vaultUnlocked: boolean
}): PayGate

export interface PayRunDeps { /* phone ops · confirm · vault · visual · record · now */ }
export async function runPayApproval(deps: PayRunDeps, req: PayRequest): Promise<PayResult>

// src/main/phone/pay-secret.ts
export interface KeypadSource {
  fromUiTree: (screen: PhoneScreen) => KeypadLayout | null
  fromVisual: (serial: string) => Promise<KeypadLayout | null>
}
/**
 * 결제 비밀번호를 폰 키패드에 입력한다. 값은 이 함수 밖으로 나가지 않는다 —
 * 인자로도 받지 않고 금고에서 직접 읽으며, 돌려주는 것은 결과 문자열뿐이다
 */
export async function tapPaymentPassword(deps: {
  vault: VaultService
  accountId: number
  jobId?: string
  serial: string
  layout: KeypadLayout
  tap: (serial: string, x: number, y: number) => Promise<void>
  onStep: (label: string, ok: boolean) => void
}): Promise<'ok' | 'locked' | 'not-found' | 'layout-incomplete'>
```

- [ ] Step 1: 실패 테스트 `tests/phone-pay-secret.test.ts`(가장 중요한 안전 테스트) — 가짜 금고가 `'149072'` 를 돌려주도록 두고 ① `tapPaymentPassword` 가 **정확히 6번** `tap` 을 부르고 좌표가 각 숫자의 키패드 좌표와 일치 ② 반환값이 `'ok'` 뿐이고 **숫자를 포함하지 않는다** ③ `onStep` 에 넘어간 라벨이 `결제 비밀번호 입력(6자리)` 이며 **숫자 값이 없다**(정규식으로 `149072` 불일치 단언) ④ 금고가 잠겨 있으면 `'locked'` 이고 `tap` 을 **한 번도** 부르지 않는다 ⑤ 저장된 항목이 없으면 `'not-found'` ⑥ 키패드 배치에 0~9 중 하나라도 빠졌으면 `'layout-incomplete'` 이고 탭하지 않는다 ⑦ 함수 인자에 비밀번호 문자열을 받는 매개변수가 **없다**(타입 단언).
- [ ] Step 2: `pay-secret.ts` 구현.
```ts
// 결제 비밀번호 입력. 값이 존재하는 유일한 지점이다 —
// 인자로 받지 않고(호출부가 값을 모르게) 금고에서 직접 읽어 좌표만 탭한다.
// 로그·IPC·모델 어디에도 값이 가지 않는다(라벨은 자리수만 남긴다)

import { DEFAULT_FIELD_KEY } from '../vault/fields'

export async function tapPaymentPassword(deps: {
  vault: VaultService
  accountId: number
  jobId?: string
  serial: string
  layout: KeypadLayout
  tap: (serial: string, x: number, y: number) => Promise<void>
  onStep: (label: string, ok: boolean) => void
}): Promise<'ok' | 'locked' | 'not-found' | 'layout-incomplete'> {
  if (deps.vault.state() !== 'unlocked') return 'locked'
  // 금고 항목 종류 'password' = 결제 비밀번호(2단계 LEGACY_TYPE_MAP: payment_password → password)
  const secret = deps.vault.getSecretForFill(
    deps.accountId,
    'password',
    DEFAULT_FIELD_KEY,
    deps.jobId
  )
  if (secret === null) return 'not-found'
  const digits = secret.split('')
  // 배치가 불완전하면 누르지 않는다 — 잘못 누르면 계정이 잠긴다
  if (digits.some((d) => deps.layout.digits[d] === undefined)) return 'layout-incomplete'
  for (const d of digits) {
    const point = deps.layout.digits[d]
    await deps.tap(deps.serial, point.x, point.y)
  }
  // 라벨에는 자리수만 남긴다
  deps.onStep(`결제 비밀번호 입력(${digits.length}자리)`, true)
  return 'ok'
}
```
- [ ] Step 3: 실패 테스트 `tests/phone-pay.test.ts` — ① `checkPaymentGate` 가 상한 초과에 `'over-limit'`, 새 조합에 1만원 초과면 `'first-run-too-large'`, 금고 잠김이면 `'vault-locked'` ② `nextPayState` 가 `await_app` 에서 앱 패키지가 뜨면 `app_steps` 로, 확인 버튼 텍스트를 찾으면 그 요소 번호를 함께 돌려준다 ③ 비밀번호 화면 표식이 보이면 `password` ④ 성공 표식이 보이면 `verify` ⑤ 앱에 아무 표식이 없으면 상태를 유지한다(무한 탭 금지 — 같은 요소를 두 번 연속 탭하지 않는다) ⑥ `runPayApproval` 이 **권한 모드와 무관하게** `confirm` 을 정확히 1회 부르고, 거부하면 아무 탭 없이 `{ok:false, reason:'declined'}` ⑦ 비밀번호 입력이 `'ok'` 인데 성공 표식이 안 뜨면 `{ok:false, reason:'verify-failed'}` 이고 **재시도하지 않는다**(`tapPaymentPassword` 호출 1회) ⑧ 웹 팝업 성공 리다이렉트와 앱 완료 화면이 **둘 다** 확인돼야 `{ok:true}` ⑨ 성공·실패 모두 `record({kind:'app_approve'})` 1건 ⑩ 실패 시 스크린샷을 사용자에게 통지하되 **비밀번호 화면이면 이미지를 붙이지 않는다**.
- [ ] Step 4: `pay.ts` 구현. 제공자 데이터:
```ts
export const PAY_PROVIDERS: Record<PayProvider, PayProviderSpec> = {
  toss: {
    id: 'toss',
    packageName: 'viva.republica.toss',
    deepLink: 'supertoss://',
    confirmText: /결제하기|확인|다음|동의하고 결제/,
    passwordHint: /비밀번호|간편비밀번호|PIN/,
    successHint: /결제(가)?\s?완료|송금 완료|완료되었습니다/
  },
  payco: {
    id: 'payco',
    packageName: 'com.nhnent.payapp',
    deepLink: 'payco://',
    confirmText: /결제하기|확인|다음/,
    passwordHint: /결제 ?비밀번호|PAYCO 비밀번호/,
    successHint: /결제 ?완료/
  },
  kakaopay: { /* … */ },
  naverpay: { /* … */ }
}
```
  실행기는 ① `checkPaymentGate` → ② `confirm(금액·가맹점·결제수단·폰 별칭)` 1회 → ③ 딥링크 또는 알림 탭으로 앱 진입(`am start -a android.intent.action.VIEW -d <deepLink>`) → ④ `nextPayState` 루프(최대 20스텝, 같은 요소 연속 탭 금지) → ⑤ 비밀번호 화면이면 키패드 배치를 **UI 트리 우선, 실패 시 Visual** 로 구하고 `tapPaymentPassword` **1회** → ⑥ 앱 성공 화면 + 웹 팝업 URL 성공 리다이렉트를 둘 다 확인 → ⑦ `record`.
- [ ] Step 5: `tab-manager.ts` — 결제창이 별도 WebContents(팝업)로 열리는 사이트를 위해 `setWindowOpenHandler` 에서 열리는 새 창을 **탭 목록에 등록**해 스냅샷·조작 대상에 포함한다(기존 탭 생성 경로 재사용, 팝업은 `profile` 을 부모 탭과 동일하게 둔다).
- [ ] Step 6: `pnpm test -- phone-pay phone-pay-secret` 통과 → `pnpm lint` → 커밋: `간편결제 앱 승인 추가: 상태기계·확인 카드·상한 검사와 값 비노출 비밀번호 입력`

---

### Task 11: 폰 화면 UI — 사이드바 "폰" · 폰 카드 · 설정 섹션 · 계정 매핑

**Files:** Create `src/renderer/src/pages/PhonesPage.tsx`, `src/renderer/src/components/phone/{PhoneCard,PhoneScreenView,PhoneManualPad,PhoneAssignDialog}.tsx`, `src/renderer/src/components/phone/useH264Player.ts`, `src/renderer/src/components/settings/PhoneSection.tsx`, `src/renderer/src/stores/phoneStore.ts`; Modify `components/layout/Sidebar.tsx`, `components/layout/RightPanel.tsx`, `components/settings/sections.ts`, `pages/SettingsPage.tsx`, `stores/uiStore.ts`, `i18n/{ko,en}.json`; Test `tests/settings-sections.test.ts`(확장), `tests/phone-store.test.ts`

- [ ] Step 1: `uiStore.ts` 의 `MainView` 에 `'phones'` 를 추가하고, `Sidebar.tsx` 의 `ITEMS` 에서 `{ key: 'phones', icon: Smartphone, view: 'phones' }` 로 바꾼다(현재 `view: null`). `App.tsx` 라우팅에 `PhonesPage` 를 연결한다.
- [ ] Step 2: `stores/phoneStore.ts` — 폰 목록·인증 대기 상태·화면 모드·선택된 폰을 담는다. `window.samba.phone.onUpdated`/`onAuthWaiting` 구독, `onScreenChunk` 는 화면 컴포넌트가 직접 구독한다.
- [ ] Step 3: `useH264Player.ts` — WebCodecs `VideoDecoder`(`codec: 'avc1.42E01E'`, `optimizeForLatency: true`)로 Annex-B 청크를 디코드해 `<canvas>` 에 그린다. **첫 키프레임 전 청크는 버린다.** 디코더 생성 실패(`VideoDecoder` 미지원)나 `error` 콜백이면 `phone.screenStop` → 간이 화면 모드로 전환을 메인에 요청한다. 간이 화면 모드에서는 PNG 청크를 `createImageBitmap` 으로 그린다.
- [ ] Step 4: `PhoneCard.tsx` — 별칭·국가 배지(KR/CN/JP)·모델·연결 상태 점·전송 방식(USB/WiFi)·**간이 화면 배지**. 끊김이면 회색 처리 + "재연결" 버튼(`phone.recover`). 클릭하면 확대(`PhoneScreenView`). **인증 대기 진입 시 해당 카드 자동 펼침 + 테두리 강조**(`ring-2 ring-black/70`), 완료 시 접힘.
- [ ] Step 5: `PhoneScreenView.tsx` — 캔버스 위 클릭·드래그를 `toDeviceCoord` 규칙과 같은 비율 환산으로 바꿔 `phone.tap`/`phone.swipe` 를 부른다(환산은 메인이 실제 폰 해상도를 알고 있으므로 **뷰 크기와 클릭 좌표만** 보낸다). 아래에 `PhoneManualPad`(뒤로·홈·최근·전원)와 "큰 창으로 열기"(`phone.openWindow`) 버튼.
- [ ] Step 6: `PhonesPage.tsx` — 폰 카드 3장 그리드 + 상단 도구줄(지금 찾기 · 와이파이 주소로 연결 · 설정 열기). **Pro 가 아니면** 카드 대신 "폰 연동은 Pro 요금제부터 사용할 수 있습니다" 안내 카드와 요금제 섹션 링크만 보여 준다(결제 연동은 범위 밖이라 링크까지만).
- [ ] Step 7: `PhoneSection.tsx`(설정 → 폰) — adb 경로 · scrcpy 경로 · **경로 자동 찾기** 버튼(`phone.detectPaths`) · 폰 목록(별칭 편집 · 국가 선택 · 와이파이 주소 · 문자 조회 가능 배지) · 화면 품질(720/1080, 10/15/30fps) · 자동 재연결 토글 · 결제 상한(원) · **Pro 3대 제한 안내**. `sections.ts` 의 `SECTIONS` 에 `{ group: 'agent', key: 'phone', labelKey: 'settingsPage.sections.phone' }` 를 **'keymaster' 다음**에 넣고, `tests/settings-sections.test.ts` 의 순서 단언을 갱신한다.
- [ ] Step 8: `PhoneAssignDialog.tsx` — 계정 화면(개인정보)에서 계정별 "담당 폰" 을 고르는 대화상자(`phone.assign`). **작업 시 선택하고 기억한다**: 선택 없이 작업이 시작되면 3대 동시 감시로 동작하고, 인증이 성공한 폰을 그 계정의 담당 폰으로 제안하는 배너를 띄운다.
- [ ] Step 9: i18n `ko.json`/`en.json` 에 `phone.*`·`settingsPage.sections.phone`·`sidebar.phones` 키를 추가한다(두 파일의 키 집합 동일 단언은 기존 `tests/settings.test.ts` 가 검사한다).
- [ ] Step 10: `pnpm test && pnpm lint && pnpm typecheck` 통과 → 커밋: `폰 화면 추가: 폰 카드·확대 뷰·수동 조작과 설정 폰 섹션, 계정 담당 폰 매핑`

---

### Task 12: 3단계 통합 검증 + 문서

**Files:** Create `docs/검수/2026-09-XX-3단계-폰인증.md`; Modify `docs/실행방법.md`, `README.md`

- [ ] Step 1: 컨트롤러(사람)가 스펙 "테스트 · 완료 기준" 10개를 순서대로 수행하고 결과를 표로 기록한다. **값(결제 비밀번호·인증번호·문자 본문)은 기록하지 않고** 성공/실패와 원인만 적는다.
  1. 폰 3대 연결 → 목록에 별칭·국가 표시, USB 뽑았다 꽂으면 5초 내 상태 갱신
  2. WiFi 폰 1대 끊김 → 자동 복구 1회 시도 후 회색 처리
  3. 폰 화면이 패널에서 동영상으로 재생, 30분 연속 유지. 강제로 간이 화면 전환도 확인
  4. `phone_get_screen` 요소 번호로 `phone_tap` 이 실제 버튼을 누름(앱 3종)
  5. **본인인증 문자 수신 → 웹 입력칸 자동 입력 성공**(사이트 10회 중 8회 이상, 무인)
  6. 문자 DB 차단 폰(삼성)에서 Visual 폴백으로 인증번호 인식 성공
  7. **토스 결제 1건을 앱 승인까지 완료** — 결제 비밀번호 값이 로그·모델 입출력·스크린샷 어디에도 없음을 수동 확인(`%APPDATA%/samba-browser` 로그 grep 포함)
  8. 결제 확인 카드가 **모든 권한 모드**(read_only/guard/full)에서 뜸, 상한 초과 시 차단, 새 조합 1만원 초과 차단
  9. `auth_events` 로 무인 처리율 계산 가능(설정 → 폰 하단 요약)
  10. Free 계정으로 로그인하면 폰 화면이 Pro 안내로 바뀌고 폰 도구가 거부됨
  수동 검수 15회 이상(PRD §12 각 단계 규칙)을 같은 문서에 누적 기록한다.
- [ ] Step 2: `docs/실행방법.md` 에 "폰 연결하기" 절 추가 — 개발자 옵션 → USB 디버깅 → PC RSA 키 승인(사람이 폰에서 직접), `adb devices` 로 확인, 와이파이 연결(`adb tcpip 5555` 후 주소 연결), 화면 항상 켜짐(`svc power stayon usb`), 경로 자동 찾기 버튼.
- [ ] Step 3: `README.md` 상태 갱신(3단계 완료 범위)과 알려진 한계 명시: 아이폰 미지원 / 삼성 폰 문자 DB 차단 시 Visual 모델 필요(API 키 필요) / 보안 키패드는 배치 인식 실패 시 사람 확인으로 넘어감 / ARS 는 수신 감지까지(자동 응답은 5단계) / 화면 스트림은 기기에 따라 간이 화면으로 내려갈 수 있음.
- [ ] Step 4: `pnpm test && pnpm lint && pnpm typecheck && pnpm build` 전부 통과 → 커밋: `3단계 검증 결과와 문서 갱신`

---

## 자체 점검

**스펙 커버리지**

| 스펙 항목 | Task |
|---|---|
| adb 경로 설정·자동 탐지(PATH 미등록, 전체 경로) | T1, T11 Step 7 |
| `adb devices -l` 5초 폴링 · serial↔별칭·국가 매핑 | T1, T3 |
| USB + WiFi(`adb connect ip:5555`) 병행 | T3 |
| 끊김 시 `kill-server && start-server` **1회만** → 회색 처리 | T3, T11 Step 4 |
| scrcpy 화면(앱 안 임베드 + 별도 창) · 화면 캡처 | T5 |
| 스트림 (b) 실패 시 (c) 주기 스크린샷 폴백 + "간이 화면" 배지 | T5, T11 Step 3·4 |
| 터치·키 전달(`input tap/swipe/text/keyevent`) | T4 |
| `uiautomator dump` → 요소 목록, 웹과 같은 번호 체계 | T4 |
| 비밀 노드(`password=true`·PIN resourceId) 값 비우기 | T4 Step 2 |
| AI 도구 6종 + `phone` 생략 시 배정 폰 + 40회 상한 공유 | T8 |
| SMS 1초 폴링(인증 대기 중에만) · 3분 내 4~8자리 · 사이트/발신번호 가중치 | T6 |
| 3대 동시 감시 → 먼저 온 폰 / 계정 담당 폰 우선 | T6, T3 Step 4, T11 Step 8 |
| 웹 인증번호 입력칸 감지 → `fillValue` → 자동 제출 설정 반영 | T9 |
| 3분 타임아웃 → 스크린샷 → Visual 모델 폴백 → 사용자 확인 카드 | T7, T9 |
| 문자 본문 미기록, 코드·발신번호 뒷 4자리만 기록 | T6, T2 Step 3, T9 Step 1 |
| 결제창 팝업 WebContents 를 탭 매니저에 등록 | T10 Step 5 |
| 딥링크/알림으로 앱 진입 → UI 트리로 버튼 탭 | T10 |
| 보안 키패드: UI 트리 → 실패 시 Visual 로 **배치만** 질의 | T7, T10 |
| 결제 비밀번호 값이 IPC·로그·모델에 없음 | T10 Step 1·2 |
| 앱 완료 화면 + 웹 성공 리다이렉트 **둘 다** 확인 | T10 Step 3 |
| 실패 시 중단, 오입력 의심 시 **재시도 없음** | T10 Step 3 |
| 권한 모드 적용(read_only 조회만, guard 결제 앱 확인) | T8 |
| 결제는 모든 모드에서 확인 카드 1회 + 상한 50만원 + 첫 거래 1만원 | T10 |
| 비밀번호 화면 스크린샷 미저장 | T8 Step 1(⑨), T10 Step 3(⑩) |
| 금고 잠김 시 결제 비밀번호 터치 거부 | T10 Step 2 |
| `phone_type` 으로 비밀값 입력 경로 차단(코드상) | T8 Step 1(⑪) |
| 폰 패널: 카드 3장·인증 시 자동 펼침·수동 클릭/드래그·재연결 | T11 |
| 설정 → 폰(경로·목록·품질·자동 재연결·Pro 3대 제한) | T11 Step 7 |
| `phones`·`auth_events` 표 + 동기화 제외 | T2 |
| 무인 처리율 집계 | T2 Step 3, T12 Step 1(9) |
| Pro 게이트(폰 연동은 Pro 부터, 결제 연동은 범위 밖) | T3, T8, T11 Step 6 |
| ARS 수신 감지·안내(자동 응답은 5단계) | T9 Step 5 |
| 완료 기준 10개 + 수동 검수 15회 | T12 |

**placeholder 없음**: 이 계획서에 `TBD`·`TODO`·"적절히 처리" 문구는 없다. 구현을 미루는 두 곳(로컬 GGUF Visual 모델, ARS 자동 응답)은 **미루는 것 자체가 결정**이며 대체 동작(클라우드 Visual 모델 / 수신 감지·안내)이 각각 T7 Step 3, T9 Step 5 에 확정돼 있다. 요금제 결제 연동은 2b 의 `profiles.plan` 을 읽기만 하는 것으로 범위가 확정돼 있다.

**타입 일관성**
- 폰 타입(`PhoneDto`·`PhoneState`·`AuthEventDto`·상수)은 `src/shared/phone.ts` **한 곳**에서만 정의하고, 메인·preload(`import type`)·렌더러가 같은 타입을 쓴다
- 화면 요소 타입(`PhoneElement`·`PhoneScreen`)은 `src/shared/phone-snapshot.ts` 한 곳이며, 직렬화 줄 모양은 웹 `src/shared/snapshot.ts` 의 `formatElement` 규칙(번호·따옴표·괄호 표기)을 그대로 따른다
- IPC 채널명은 `src/shared/ipc.ts` 의 `IPC` 상수 한 곳. **페이지 프리로드가 쓰는 채널은 늘지 않으므로** `src/preload/page-constants.ts` 는 수정하지 않는다(`tests/preload-bundle.test.ts` 그대로 통과)
- 좌표는 두 층으로 분리한다: **뷰 좌표**(렌더러가 그린 캔버스 픽셀)와 **기기 좌표**(폰 픽셀). 환산은 `input.ts` 의 `toDeviceCoord` 한 함수에서만 하고, IPC 로는 뷰 좌표 + 뷰 크기만 보낸다
- 시간은 로컬 전부 **epoch 밀리초 정수**(`lastSeenAt`·`dateMs`·`at`) — 원격과 주고받지 않으므로 ISO 변환이 없다
- 결제 비밀번호는 금고 항목 종류 `'password'` + 필드 키 `DEFAULT_FIELD_KEY` 로 고정한다(2단계 `LEGACY_TYPE_MAP` 의 `payment_password → password` 와 동일). 이 조합은 `pay-secret.ts` 에만 등장한다
- 외부 프로세스는 `AdbRunner`(`process.ts`)와 `openWindow`(scrcpy) 두 군데서만 뜬다 — 다른 파일에서 `child_process` 를 import 하면 리뷰에서 반려

**비밀값 경로**(3단계에서 새로 생기는 것만)
- 결제 비밀번호: `VaultService.getSecretForFill` → `tapPaymentPassword` 지역 변수 → `adb input tap` **좌표**. IPC·모델·로그·스크린샷 어디에도 없음. 진행 로그는 자리수만
- 문자 인증번호: `watchSms`(메인) → `fillValue`(격리 월드 인자) → 페이지 입력칸. 모델에는 `'filled: ####'` 마스킹만, `auth_events` 에는 코드와 발신번호 뒷 4자리만
- 문자 본문: `sms.ts` 안에서만 존재하고 `SmsCandidate` 에 body 필드가 없어 밖으로 나가지 않는다
- 폰 스크린샷: `phone_screenshot`·Visual 폴백 경로. `isSecretScreen()` 이면 이미지 자체를 만들지 않는다
- API 키: 2b 의 `ApiKeyStore` 를 그대로 쓴다(`visual.ts` 는 `apiKey()` 콜백만 받고 값을 보관하지 않는다)

**마이그레이션 안전성**: 0009 는 `CREATE TABLE` 3개와 인덱스 2개뿐이고 기존 표를 전혀 건드리지 않는다. 실패해도 기존 기능은 그대로 동작한다(폰 기능만 꺼진다). 동기화 스키마(Supabase)는 변경이 없다 — 3단계 표는 전부 로컬 전용이다.

**테스트가 실기기에 의존하지 않음**: 14개 테스트 파일 중 adb·scrcpy·네트워크를 쓰는 것은 **하나도 없다**. 기기 의존 검증은 T12 의 수동 검수로 분리했다.
