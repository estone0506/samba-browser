// 3단계 폰 기능 배선. T9(문자 인증)·T10(결제 승인)·T5(화면 스트림)·T7(Visual)·T8(도구)가
// 각자 열어 둔 접점을 실제 구현에 묶는 유일한 곳이다. 여기 밖에서는 서로를 모른다.
//
// 안전 규칙(3단계 Global Constraints):
//  - 결제 비밀번호는 이 파일을 지나가지 않는다. 금고 핸들만 pay-secret 으로 넘긴다
//  - 결제는 권한 모드와 무관하게 확인 카드 1회 · 상한 검사 · 재시도 0(runPayApproval 안)
//  - 비밀번호 화면인 동안에는 화면 프레임을 전송·저장하지 않는다(SecretScreenGate)
//  - 인증번호·문자 본문은 진행 로그에도 남기지 않는다(자리수만 남긴다)

import {
  DEFAULT_PAYMENT_LIMIT_KRW,
  type PhoneAuthWaitingDto,
  type PhoneDto
} from '../../shared/phone'
import type { AuthEventDto } from '../../shared/phone'
import type { PageSnapshot } from '../../shared/snapshot'
import type { PhoneScreen } from '../../shared/phone-snapshot'
import type { Settings } from '../../shared/settings'
import type { AccountDto, VaultItemType, VaultState } from '../../shared/vault'
import { normalizeHost } from '../../shared/host'
import type { KeypadLayout } from '../ai/visual'
import { extractCode } from '../ai/visual'
import type { HandoffResult } from '../agent/handoff'
import type { PayToolRequest, PhoneOps, SmsCodeOutcome } from '../agent/tools-phone'
import { execOutArgs, shellArgs, type AdbRunner } from './adb'
import { runSmsAuth } from './auth-flow'
import { keypadFromUiTree } from './pay-secret'
import type { PaySecretVault } from './pay-secret'
import {
  isSecretScreen,
  PAY_PROVIDERS,
  runPayApproval,
  type PayResult,
  type PayRunDeps
} from './pay'

// --- Pro 게이트 --------------------------------------------------------------

/** 개발·검증용 우회를 켜는 환경변수 */
export const PRO_OVERRIDE_ENV = 'SAMBA_PHONE_PRO_OVERRIDE'

/**
 * 폰 기능을 써도 되는가. Pro 계정이면 언제나 참이다.
 * 개발 중에는 설정(phoneDevOverridePro)이나 환경변수로 우회할 수 있지만,
 * 배포판(app.isPackaged)에서는 우회를 통째로 무시한다
 */
export function phoneProEnabled(input: {
  plan: string
  devOverride: boolean
  env?: string
  packaged: boolean
}): boolean {
  if (input.plan === 'pro') return true
  if (input.packaged) return false
  return input.devOverride || input.env === '1'
}

// --- 비밀 화면 차단(T5 ScreenStream 훅) ---------------------------------------

/** 비밀번호 화면으로 본 뒤 이 시간 동안은 프레임을 내보내지 않는다 */
export const SECRET_SCREEN_TTL_MS = 5000

/**
 * "지금 이 폰은 비밀번호 화면인가" 를 동기로 답하는 표식.
 * 결제 실행기가 화면을 볼 때마다 갱신하고, ScreenStream 이 프레임마다 물어본다.
 * 화면 자체는 담지 않는다 — 폰 serial 과 만료 시각뿐이다
 */
export class SecretScreenGate {
  private until = new Map<string, number>()

  constructor(
    private now: () => number = () => Date.now(),
    private ttlMs: number = SECRET_SCREEN_TTL_MS
  ) {}

  mark(serial: string): void {
    this.until.set(serial, this.now() + this.ttlMs)
  }

  clear(serial: string): void {
    this.until.delete(serial)
  }

  /** ScreenStreamDeps.isSecretScreen 에 그대로 꽂는다 */
  isSecret(serial: string): boolean {
    const t = this.until.get(serial)
    return t !== undefined && this.now() < t
  }
}

// --- 진행 로그 중계(PhoneService.onProgress → 채팅 StepLog) --------------------

/**
 * PhoneService 는 IPC 등록 시점에 만들어지고 StepLog 는 작업 1건마다 생긴다.
 * 그 사이를 잇는 한 칸짜리 중계다 — 작업이 도는 동안에만 sink 가 붙어 있다
 */
export class AgentProgressRelay {
  private sink: ((label: string, ok: boolean) => void) | null = null

  /** 작업이 시작될 때 붙이고, 돌려받은 함수로 뗀다 */
  bind(sink: (label: string, ok: boolean) => void): () => void {
    this.sink = sink
    return () => {
      if (this.sink === sink) this.sink = null
    }
  }

  emit(text: string): void {
    this.sink?.(text, true)
  }
}

// --- 결제 앱 띄우기 -----------------------------------------------------------

/** 딥링크로 앱을 앞으로 부르는 인자 */
export function amStartArgs(serial: string, deepLink: string): string[] {
  return shellArgs(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', deepLink])
}

/** 딥링크가 막힌 폰에서 쓰는 폴백 — 런처로 앱만 띄운다 */
export function monkeyArgs(serial: string, packageName: string): string[] {
  return shellArgs(serial, [
    'monkey',
    '-p',
    packageName,
    '-c',
    'android.intent.category.LAUNCHER',
    '1'
  ])
}

// am 은 실패해도 종료 코드 0 을 주는 경우가 있어 출력으로도 판정한다
const LAUNCH_FAILED_RE = /Error(?::| type)|Exception|does not exist|no activities/i

/** 딥링크 → 실패하면 런처. 어느 쪽도 예외를 던지지 않는다(실행기가 화면으로 판정한다) */
export function createLaunchApp(
  adb: AdbRunner
): (serial: string, deepLink: string) => Promise<void> {
  return async (serial, deepLink) => {
    const res = await adb.run(amStartArgs(serial, deepLink), 10000)
    if (res.code === 0 && !LAUNCH_FAILED_RE.test(`${res.stdout}\n${res.stderr}`)) return
    const spec = Object.values(PAY_PROVIDERS).find((p) => p.deepLink === deepLink)
    if (!spec) return
    await adb.run(monkeyArgs(serial, spec.packageName), 10000)
  }
}

// --- 웹 결제창 성공 판정 ------------------------------------------------------

export const PAY_SUCCESS_URL_RE = /success|complete[ds]?|approved?|\/done|result=?ok|returnok/i
export const PAY_FAIL_URL_RE = /fail|cancel|error|denied?|reject/i
export const PAY_SUCCESS_TEXT_RE =
  /결제\s?(가\s?)?완료|결제\s?성공|주문(이)?\s?완료|승인\s?완료|payment (was )?(successful|completed?)/i

/** 결제창 주소가 성공으로 보이는가. 실패 낱말이 하나라도 있으면 성공으로 보지 않는다 */
export function isPaySuccessUrl(url: string): boolean {
  if (PAY_FAIL_URL_RE.test(url)) return false
  return PAY_SUCCESS_URL_RE.test(url)
}

/** 웹 팝업 성공 확인을 몇 번까지 다시 볼지(앱 완료보다 리다이렉트가 늦을 수 있다) */
export const WEB_SUCCESS_TRIES = 8
export const WEB_SUCCESS_INTERVAL_MS = 1000

// --- 화면 인증번호 읽기(로컬 OCR 1차 → Visual 2차) ---------------------------

export interface LocalOcrLike {
  hasModels: () => boolean
  recognize: (png: Buffer) => Promise<{ text: string }>
}

export interface CodeReaderDeps {
  /** 설정의 ocrEnabled. 꺼져 있으면 로컬 경로를 건너뛴다 */
  ocrEnabled: () => boolean
  /** 로컬 PP-OCRv5. 모델이 없으면 건너뛴다 */
  ocr: LocalOcrLike | null
  /** 2차 경로(ai/visual.ts). 키가 없으면 null 을 돌려준다 */
  visual: (png: Buffer) => Promise<string | null>
}

/**
 * 화면에서 인증번호를 읽는다. 로컬 OCR 로 먼저 시도하고 실패할 때만 Visual 을 부른다 —
 * 화면을 바깥으로 내보내는 횟수를 줄이기 위함이다
 */
export function createCodeReader(deps: CodeReaderDeps): (png: Buffer) => Promise<string | null> {
  return async (png) => {
    if (png.length === 0) return null
    if (deps.ocrEnabled() && deps.ocr?.hasModels()) {
      try {
        const code = extractCode((await deps.ocr.recognize(png)).text)
        if (code) return code
      } catch {
        // 로컬 인식 실패는 조용히 Visual 로 넘긴다 — 오류 객체에 화면이 실릴 수 있다
      }
    }
    return deps.visual(png)
  }
}

// --- 키패드 배치 읽기(Visual 폴백) --------------------------------------------

/**
 * 비밀번호 화면을 직접 캡처해 Visual 에게 "숫자 위치" 만 묻는다.
 * 이 캡처는 렌더러로도 모델 대화로도 가지 않는다 — 좌표를 얻는 즉시 버린다
 */
export function createKeypadReader(deps: {
  adb: AdbRunner
  screen: (serial: string) => Promise<PhoneScreen>
  readLayout: (png: Buffer, size: { width: number; height: number }) => Promise<KeypadLayout | null>
}): (serial: string) => Promise<KeypadLayout | null> {
  return async (serial) => {
    try {
      const screen = await deps.screen(serial)
      const png = await deps.adb.runBinary(execOutArgs(serial, ['screencap', '-p']))
      if (png.length === 0) return null
      return await deps.readLayout(png, { width: screen.width, height: screen.height })
    } catch {
      // 캡처·인식 실패는 배치 없음과 같다(호출부가 사람에게 넘긴다)
      return null
    }
  }
}

// --- 배선 본체 ---------------------------------------------------------------

/** 작업 1건이 주는 문맥. 확인 카드·진행 로그·넘김 카드는 웹 도구와 같은 것을 쓴다 */
export interface PhoneRunContext {
  jobId: string
  confirm: (action: string, kind?: 'danger' | 'finish') => Promise<boolean>
  onStep: (label: string, ok: boolean) => void
  handoff: (req: {
    matched: string
    currentUrl: () => string
    stillBlocked: () => Promise<boolean>
  }) => Promise<HandoffResult>
  cancelled: () => boolean
}

/** PhoneService 에서 쓰는 것만 적는다(구조적 타입 — 순환 import 를 피한다) */
export interface WiringPhones {
  list: () => PhoneDto[]
  assignForJob: (accountId: number) => PhoneDto | null
  notifyAuthWaiting: (dto: PhoneAuthWaitingDto) => void
  watchArs: (siteHost: string) => () => void
}

/** PhoneRepo 에서 쓰는 것만 적는다 */
export interface WiringRepo {
  recordAuthEvent: (e: Omit<AuthEventDto, 'id'>) => void
  hasPayApproval: (siteHost: string, payMethod: string) => boolean
}

/** VaultService 에서 쓰는 것만 적는다. 값 복호화는 pay-secret 안에서만 일어난다 */
export interface WiringVault extends PaySecretVault {
  state: () => VaultState
  listAccounts: (host?: string) => AccountDto[]
  getSecretForFill: (
    accountId: number,
    type: VaultItemType,
    fieldKey?: string,
    jobId?: string
  ) => string | null
}

/** 활성 탭·결제 팝업에 닿는 통로(page-bridge 어댑터는 tab-port.ts 가 만든다) */
export interface PagePort {
  /** 활성 탭 호스트(정규화). 없으면 빈 문자열 */
  host: () => string
  /** 활성 탭 id — 결제 팝업(openerId)을 되찾는 데 쓴다 */
  activeTabId: () => string | null
  snapshot: () => Promise<PageSnapshot>
  fillValue: (elementId: number, value: string) => Promise<string>
  submit: (elementId: number) => Promise<string>
  /** 이 탭이 연 결제 팝업(없으면 탭 자신)이 성공 화면에 닿았는가 */
  paymentSucceeded: (openerId: string | null) => Promise<boolean>
}

export interface PhoneWiringDeps {
  adb: AdbRunner
  phones: WiringPhones
  ops: PhoneOps
  repo: WiringRepo
  vault: WiringVault
  page: PagePort
  settings: () => Settings
  /** 화면에서 인증번호 읽기(createCodeReader) */
  readCode: (png: Buffer) => Promise<string | null>
  /** 비밀번호 키패드 배치 Visual 폴백(createKeypadReader) */
  readKeypad: (serial: string) => Promise<KeypadLayout | null>
  secretGate: SecretScreenGate
  progress: AgentProgressRelay
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** 폰 도구가 받는 두 함수. 나머지(phones/isPro/assigned)는 handlers 가 직접 넘긴다 */
export interface PhoneAgentBridge {
  waitForSmsCode: (ctx: PhoneRunContext, host?: string) => Promise<SmsCodeOutcome>
  approvePayment: (ctx: PhoneRunContext, req: PayToolRequest) => Promise<PayResult>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

export function createPhoneAgentBridge(deps: PhoneWiringDeps): PhoneAgentBridge {
  const now = deps.now ?? ((): number => Date.now())
  const sleep = deps.sleep ?? defaultSleep

  const online = (): PhoneDto[] => deps.phones.list().filter((p) => p.state === 'online')

  /** 이 사이트의 계정. 특정하지 못하면 null(결제는 시작하지 않는다) */
  const accountFor = (host: string): AccountDto | null => {
    if (!host) return null
    const accounts = deps.vault.listAccounts(host)
    if (accounts.length === 0) return null
    return accounts.find((a) => a.isDefault) ?? (accounts.length === 1 ? accounts[0] : null)
  }

  /** 계정에 배정된 폰이 지금 붙어 있으면 그 폰만, 아니면 연결된 폰 전부 */
  const serialsFor = (accountId: number | null): string[] => {
    const list = online()
    if (accountId !== null) {
      const assigned = deps.phones.assignForJob(accountId)
      if (assigned && list.some((p) => p.serial === assigned.serial)) return [assigned.serial]
    }
    return list.map((p) => p.serial)
  }

  const phoneIdOf = (serial: string): number | null =>
    deps.phones.list().find((p) => p.serial === serial)?.id ?? null

  // --- 1) wait_for_sms_code → runSmsAuth --------------------------------------
  const waitForSmsCode = async (ctx: PhoneRunContext, host?: string): Promise<SmsCodeOutcome> => {
    const siteHost = normalizeHost(host ?? '') || deps.page.host()
    const account = accountFor(siteHost)
    const serials = serialsFor(account?.id ?? null)
    // 인증 대기 중에만 ARS 감시를 켜고, 그 진행 로그를 이 작업의 StepLog 로 보낸다.
    // 중계를 먼저 붙인다 — 감시가 시작하자마자 알리는 경우가 있다
    const unbind = deps.progress.bind(ctx.onStep)
    const stopArs = deps.phones.watchArs(siteHost)
    // 자리수는 기록 콜백에서만 얻는다 — 인증번호 값은 여기서 보지 않는다
    let digits = 0
    try {
      const result = await runSmsAuth({
        adb: deps.adb,
        serials: () => serials,
        siteHost,
        jobId: ctx.jobId,
        snapshot: deps.page.snapshot,
        fillValue: deps.page.fillValue,
        submit: deps.page.submit,
        autoSubmit: deps.settings().vaultAutoSubmit,
        screenshot: async (serial) => (await deps.ops.screenshot(serial)).png,
        readCodeFromImage: deps.readCode,
        record: (e) => {
          if (e.ok && e.code) digits = e.code.length
          deps.repo.recordAuthEvent(e)
        },
        notify: (dto) => deps.phones.notifyAuthWaiting(dto),
        now,
        sleep,
        cancelled: ctx.cancelled,
        phoneIdOf
      })
      return { filled: result.ok, digits: result.ok ? digits : 0 }
    } finally {
      stopArs()
      unbind()
    }
  }

  // --- 2) phone_approve_payment → runPayApproval -------------------------------
  const approvePayment = async (ctx: PhoneRunContext, req: PayToolRequest): Promise<PayResult> => {
    const siteHost = deps.page.host()
    const account = accountFor(siteHost)
    if (!account) {
      ctx.onStep('결제 거부: 이 사이트의 계정을 특정할 수 없음', false)
      return { ok: false, reason: 'no-account' }
    }
    const serial = serialsFor(account.id)[0]
    if (!serial) {
      ctx.onStep('결제 거부: 연결된 폰 없음', false)
      return { ok: false, reason: 'no-phone' }
    }
    const spec = PAY_PROVIDERS[req.provider]
    const openerId = deps.page.activeTabId()

    // 화면을 볼 때마다 비밀번호 화면 여부를 표식에 반영한다 — 화면 전송이 이 값을 본다
    const screen = async (s: string): Promise<PhoneScreen> => {
      const got = await deps.ops.screen(s)
      if (isSecretScreen(got, spec)) deps.secretGate.mark(s)
      else deps.secretGate.clear(s)
      return got
    }

    // 앱 완료 화면보다 웹 리다이렉트가 늦을 수 있어 몇 초 동안 다시 본다
    const webSuccess = async (): Promise<boolean> => {
      for (let i = 0; i < WEB_SUCCESS_TRIES; i++) {
        if (await deps.page.paymentSucceeded(openerId)) return true
        if (ctx.cancelled()) return false
        await sleep(WEB_SUCCESS_INTERVAL_MS)
      }
      return false
    }

    const runDeps: PayRunDeps = {
      phones: { screen, tap: deps.ops.tap, screenshot: deps.ops.screenshot },
      launchApp: createLaunchApp(deps.adb),
      confirm: (action) => ctx.confirm(action, 'danger'),
      vault: deps.vault,
      vaultUnlocked: () => deps.vault.state() === 'unlocked',
      keypad: { fromUiTree: keypadFromUiTree, fromVisual: deps.readKeypad },
      webSuccess,
      // 결제수단까지 남겨야 "새 (사이트 × 결제수단) 조합" 을 다음에 알아볼 수 있다
      record: (e) => deps.repo.recordAuthEvent({ ...e, payMethod: req.methodLabel }),
      // 실패 통지는 진행 로그 한 줄로만 남긴다(이미지는 채팅으로 내보내지 않는다)
      notify: (message) => ctx.onStep(message, false),
      onStep: ctx.onStep,
      now,
      sleep,
      handoff: ctx.handoff
    }

    try {
      return await runPayApproval(runDeps, {
        provider: req.provider,
        amountKrw: req.amountKrw,
        merchant: req.merchant,
        methodLabel: req.methodLabel,
        phoneLabel: deps.phones.list().find((p) => p.serial === serial)?.label ?? serial,
        accountId: account.id,
        phoneId: phoneIdOf(serial),
        serial,
        siteHost,
        jobId: ctx.jobId,
        isFirstRunForCombo: !deps.repo.hasPayApproval(siteHost, req.methodLabel),
        limitKrw: deps.settings().paymentLimitKrw || DEFAULT_PAYMENT_LIMIT_KRW
      })
    } finally {
      // 결제가 끝나면 화면 전송을 곧바로 되살린다(만료를 기다리지 않는다)
      deps.secretGate.clear(serial)
    }
  }

  return { waitForSmsCode, approvePayment }
}
