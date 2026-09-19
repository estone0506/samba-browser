// 3단계 배선 통합 — 가짜 adb · 가짜 Visual · 메모리 DB 로 두 시나리오를 끝까지 돌린다.
//   ① 웹 폼 → wait_for_sms_code → 문자 도착 → 자동 입력·제출
//   ② 결제 도구 → 확인 카드 → 앱 승인 → 키패드 탭(값 미노출) → 성공
// adb·scrcpy·electron 은 한 번도 실행하지 않는다

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// SDK 의 tool() 을 얇게 대체해 도구 핸들러를 직접 부른다(다른 agent 테스트와 같은 방식)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

import { openDatabase, type Db } from '../src/main/db/client'
import { PhoneRepo } from '../src/main/phone/repo'
import { createPhoneOps, createPhoneTools, createPayTool } from '../src/main/agent/tools-phone'
import {
  AgentProgressRelay,
  createPhoneAgentBridge,
  SecretScreenGate,
  type PagePort,
  type PhoneRunContext,
  type PhoneWiringDeps,
  type WiringVault
} from '../src/main/phone/wiring'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import type { AdbResult, AdbRunner } from '../src/main/phone/process'
import type { AccountDto } from '../src/shared/vault'
import type { PageSnapshot } from '../src/shared/snapshot'
import type { PhoneAuthWaitingDto, PhoneDto } from '../src/shared/phone'

const SERIAL = 'R3CRA05HY3R'
const HOST = 'shop.example.com'
const CODE = '483920'
const SECRET = '135790'

// --- 가짜 adb ---------------------------------------------------------------

interface FakeScreen {
  app: string
  xml: string
}

/** 화면을 순서대로 돌려주는 가짜 adb. 실제 프로세스는 절대 띄우지 않는다 */
class ScriptedAdb implements AdbRunner {
  readonly calls: string[][] = []
  /** 문자함 조회 응답(빈 문자열이면 문자가 없는 상태) */
  smsStdout = ''
  private screens: FakeScreen[] = []
  private index = 0

  pushScreen(app: string, xml: string): void {
    this.screens.push({ app, xml })
  }

  private current(): FakeScreen {
    return this.screens[Math.min(this.index, this.screens.length - 1)] ?? { app: '', xml: '' }
  }

  run(args: string[]): Promise<AdbResult> {
    this.calls.push(args)
    const key = args.join(' ')
    const ok = (stdout: string): Promise<AdbResult> =>
      Promise.resolve({ code: 0, stdout, stderr: '' })
    if (key.includes('mCurrentFocus')) {
      return ok(`  mCurrentFocus=Window{a b ${this.current().app}/.MainActivity}`)
    }
    if (key.includes('uiautomator dump')) return ok('dumped')
    if (key.includes('cat /sdcard/samba-ui.xml')) {
      const xml = this.current().xml
      // 다음 조회는 다음 화면을 본다(마지막 화면은 계속 유지된다)
      if (this.index < this.screens.length - 1) this.index += 1
      return ok(xml)
    }
    if (key.includes('content://sms/inbox')) return ok(this.smsStdout)
    return ok('')
  }

  runBinary(args: string[]): Promise<Buffer> {
    this.calls.push(args)
    return Promise.resolve(Buffer.alloc(0))
  }

  stream(): () => void {
    throw new Error('통합 테스트는 스트림을 쓰지 않는다')
  }
}

// --- 화면 XML 조각 -----------------------------------------------------------

function node(attrs: Record<string, string>): string {
  const pairs = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')
  return `<node ${pairs} />`
}

function hierarchy(nodes: string[]): string {
  return `<?xml version='1.0'?><hierarchy rotation="0">${nodes.join('')}</hierarchy>`
}

function button(text: string, top: number): string {
  return node({
    text,
    class: 'android.widget.Button',
    clickable: 'true',
    bounds: `[0,${top}][720,${top + 100}]`
  })
}

/** 0~9 가 한 번씩 보이는 보안 키패드(비밀 입력칸도 함께 있다) */
function keypadScreen(): string {
  const keys = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d, i) =>
    node({
      text: d,
      class: 'android.widget.Button',
      clickable: 'true',
      bounds: `[${i * 70},1000][${i * 70 + 60},1060]`
    })
  )
  return hierarchy([
    node({
      text: '결제 비밀번호를 입력하세요',
      class: 'android.widget.TextView',
      bounds: '[0,800][720,860]'
    }),
    node({
      'resource-id': 'viva.republica.toss:id/pin_input',
      class: 'android.widget.EditText',
      password: 'true',
      bounds: '[0,880][720,940]'
    }),
    ...keys
  ])
}

// --- 가짜 주변부 -------------------------------------------------------------

const ACCOUNT: AccountDto = {
  id: 7,
  siteId: 1,
  host: HOST,
  label: '기본',
  username: 'me@example.com',
  isDefault: true,
  itemTypes: ['password'],
  urls: [],
  agentAccess: 'allow',
  tags: []
}

function fakeVault(over: Partial<WiringVault> = {}): WiringVault {
  return {
    state: () => 'unlocked',
    listAccounts: () => [ACCOUNT],
    getSecretForFill: () => SECRET,
    ...over
  }
}

function phoneDto(): PhoneDto {
  return {
    id: 1,
    serial: SERIAL,
    label: '내 폰',
    country: 'KR',
    transport: 'usb',
    wifiAddress: null,
    model: 'Galaxy S24',
    state: 'online',
    smsQueryOk: true,
    lastSeenAt: 0,
    screenMode: null
  }
}

interface Harness {
  deps: PhoneWiringDeps
  adb: ScriptedAdb
  repo: PhoneRepo
  gate: SecretScreenGate
  progress: AgentProgressRelay
  waiting: PhoneAuthWaitingDto[]
  arsStarted: number
  arsStopped: number
  filled: Array<{ id: number; value: string }>
  submitted: number[]
  steps: Array<{ label: string; ok: boolean }>
  confirms: string[]
  ctx: PhoneRunContext
  paySuccess: { value: boolean }
}

function harness(
  db: Db,
  opts: { snapshot?: PageSnapshot; vault?: Partial<WiringVault>; confirm?: boolean } = {}
): Harness {
  const adb = new ScriptedAdb()
  const repo = new PhoneRepo(db)
  const gate = new SecretScreenGate()
  const progress = new AgentProgressRelay()
  const waiting: PhoneAuthWaitingDto[] = []
  const filled: Array<{ id: number; value: string }> = []
  const submitted: number[] = []
  const steps: Array<{ label: string; ok: boolean }> = []
  const confirms: string[] = []
  const paySuccess = { value: false }
  const state = { arsStarted: 0, arsStopped: 0 }

  const snapshot: PageSnapshot = opts.snapshot ?? {
    url: `https://${HOST}/verify`,
    title: '인증',
    text: '인증번호를 입력하세요',
    elements: [
      {
        id: 3,
        tag: 'input',
        role: 'textbox',
        text: '인증번호',
        name: 'authCode',
        inputType: 'tel',
        isSecret: false
      }
    ]
  }

  const page: PagePort = {
    host: () => HOST,
    activeTabId: () => 'tab-1',
    snapshot: async () => snapshot,
    fillValue: async (id, value) => {
      filled.push({ id, value })
      return 'ok'
    },
    submit: async (id) => {
      submitted.push(id)
      return 'ok'
    },
    paymentSucceeded: async () => paySuccess.value
  }

  const settings: Settings = { ...DEFAULT_SETTINGS }
  const deps: PhoneWiringDeps = {
    adb,
    phones: {
      list: () => [phoneDto()],
      assignForJob: () => phoneDto(),
      notifyAuthWaiting: (dto) => waiting.push(dto),
      watchArs: () => {
        state.arsStarted += 1
        return () => {
          state.arsStopped += 1
        }
      }
    },
    ops: createPhoneOps(adb, () => [phoneDto()]),
    repo,
    vault: fakeVault(opts.vault),
    page,
    settings: () => settings,
    // 가짜 Visual — 이 시나리오에서는 UI 트리로 다 풀리므로 불리면 안 된다
    readCode: async () => null,
    readKeypad: async () => null,
    secretGate: gate,
    progress,
    sleep: async () => undefined
  }

  const ctx: PhoneRunContext = {
    jobId: 'job-1',
    confirm: async (action) => {
      confirms.push(action)
      return opts.confirm ?? true
    },
    onStep: (label, ok) => steps.push({ label, ok }),
    handoff: async () => ({ outcome: 'aborted', url: '' }),
    cancelled: () => false
  }

  return {
    deps,
    adb,
    repo,
    gate,
    progress,
    waiting,
    get arsStarted() {
      return state.arsStarted
    },
    get arsStopped() {
      return state.arsStopped
    },
    filled,
    submitted,
    steps,
    confirms,
    ctx,
    paySuccess
  }
}

// --- 시나리오 ① 문자 인증 ----------------------------------------------------

describe('통합 ① 웹 폼 → wait_for_sms_code → 문자 도착 → 자동 입력·제출', () => {
  let db: Db

  beforeEach(async () => {
    db = await openDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  function smsRow(code: string, at: number): string {
    return `Row: 0 _id=12, address=15881234, body=[Web발신] 인증번호 ${code} 를 입력하세요, date=${at}`
  }

  it('문자가 도착하면 페이지에 채우고 제출하며, 모델에게는 자리수만 준다', async () => {
    const h = harness(db)
    h.adb.smsStdout = smsRow(CODE, Date.now())
    const bridge = createPhoneAgentBridge(h.deps)

    const tools = createPhoneTools({
      phones: h.deps.ops,
      mode: 'guard',
      isPro: () => true,
      assigned: () => SERIAL,
      confirm: h.ctx.confirm,
      tick: () => null,
      onStep: h.ctx.onStep,
      waitForSmsCode: (host) => bridge.waitForSmsCode(h.ctx, host)
    })
    const waitTool = tools.find((t) => t.name === 'wait_for_sms_code')
    expect(waitTool).toBeDefined()
    const out = (await (
      waitTool as unknown as { handler: (a: Record<string, unknown>) => Promise<unknown> }
    ).handler({ host: HOST })) as { content: Array<{ text: string }> }

    // 값이 아니라 자리수만 나간다
    expect(out.content[0].text).toBe('filled: ######')
    expect(out.content[0].text).not.toContain(CODE)

    // 페이지에는 실제 인증번호가 채워지고 자동 제출까지 갔다
    expect(h.filled).toEqual([{ id: 3, value: CODE }])
    expect(h.submitted).toEqual([3])

    // 기록은 남되 문자 본문은 없다
    const events = h.repo.listAuthEvents()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('sms')
    expect(events[0].ok).toBe(true)
    expect(events[0].code).toBe(CODE)
    expect(events[0].senderTail).toBe('1234')
    expect(events[0].phoneId).toBe(1)

    // 진행 로그에도 값이 남지 않는다
    expect(h.steps.some((s) => s.label.includes(CODE))).toBe(false)
  })

  it('인증 대기 동안에만 ARS 감시를 켜고, 대기 통지는 켰다 껐다 한 쌍으로 간다', async () => {
    const h = harness(db)
    h.adb.smsStdout = smsRow(CODE, Date.now())
    const bridge = createPhoneAgentBridge(h.deps)

    expect(h.arsStarted).toBe(0)
    await bridge.waitForSmsCode(h.ctx, HOST)
    expect(h.arsStarted).toBe(1)
    expect(h.arsStopped).toBe(1)
    expect(h.waiting.map((w) => w.waiting)).toEqual([true, false])
    expect(h.waiting[0].kind).toBe('sms')
    expect(h.waiting[0].siteHost).toBe(HOST)
  })

  it('ARS 감시가 알린 안내는 이 작업의 진행 로그로 간다', async () => {
    const h = harness(db)
    h.adb.smsStdout = smsRow(CODE, Date.now())
    const bridge = createPhoneAgentBridge(h.deps)
    // 감시가 켜져 있는 동안 PhoneService 가 부르는 경로를 흉내 낸다
    h.deps.phones.watchArs = () => {
      h.progress.emit('전화 인증 수신 감지: 폰 화면을 확인하세요')
      return () => undefined
    }
    await bridge.waitForSmsCode(h.ctx, HOST)
    expect(h.steps.some((s) => s.label.includes('전화 인증 수신 감지'))).toBe(true)
  })

  it('자동 제출을 끄면 채우기만 하고 제출하지 않는다', async () => {
    const h = harness(db)
    h.adb.smsStdout = smsRow(CODE, Date.now())
    const settings: Settings = { ...DEFAULT_SETTINGS, vaultAutoSubmit: false }
    h.deps.settings = () => settings
    const bridge = createPhoneAgentBridge(h.deps)
    const r = await bridge.waitForSmsCode(h.ctx, HOST)
    expect(r).toEqual({ filled: true, digits: 6 })
    expect(h.submitted).toEqual([])
  })

  it('인증번호 칸이 없으면 폰을 한 번도 건드리지 않는다', async () => {
    const h = harness(db, {
      snapshot: { url: `https://${HOST}/`, title: '', text: '', elements: [] }
    })
    const bridge = createPhoneAgentBridge(h.deps)
    expect(await bridge.waitForSmsCode(h.ctx, HOST)).toEqual({ filled: false, digits: 0 })
    expect(h.adb.calls.some((c) => c.join(' ').includes('sms/inbox'))).toBe(false)
  })
})

// --- 시나리오 ② 결제 승인 ----------------------------------------------------

describe('통합 ② 결제 도구 → 확인 카드 → 앱 승인 → 키패드 탭 → 성공', () => {
  let db: Db

  beforeEach(async () => {
    db = await openDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  /** 런처 → 토스 결제 확인 → 보안 키패드 → 완료 */
  function scriptPayScreens(adb: ScriptedAdb): void {
    adb.pushScreen('com.sec.android.app.launcher', hierarchy([button('홈', 0)]))
    adb.pushScreen('viva.republica.toss', hierarchy([button('결제하기', 200)]))
    adb.pushScreen('viva.republica.toss', keypadScreen())
    adb.pushScreen('viva.republica.toss', hierarchy([button('결제 완료', 300)]))
  }

  it('확인 카드 1회 → 딥링크 → 키패드 6탭 → 웹 성공 확인 순으로 끝난다', async () => {
    const h = harness(db)
    scriptPayScreens(h.adb)
    h.paySuccess.value = true
    const bridge = createPhoneAgentBridge(h.deps)

    const r = await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(r).toEqual({ ok: true })

    // 권한 모드와 무관하게 확인 카드가 정확히 1회, 금액·가맹점·결제수단·폰 별칭이 모두 보인다
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0]).toBe('결제 승인: 9,000원 · 삼바상회 · 토스페이 · 내 폰')

    // 딥링크로 앱을 불렀다
    expect(h.adb.calls.some((c) => c.includes('supertoss://'))).toBe(true)

    // 앱 진행 버튼을 한 번 누른 뒤, 키패드는 비밀번호 자리수만큼만 눌린다
    const allTaps = h.adb.calls.filter((c) => c.includes('tap'))
    expect(allTaps[0][allTaps[0].length - 1]).toBe('250')
    // 키패드 줄(중심 y=1030)의 탭만 센다 — 좌표는 UI 트리에서 읽은 값이다
    const keyTaps = allTaps.filter((c) => c[c.length - 1] === '1030')
    expect(keyTaps).toHaveLength(SECRET.length)
    const digitX = (d: string): string => String(Number(d) * 70 + 30)
    expect(keyTaps.map((c) => c[c.length - 2])).toEqual(SECRET.split('').map(digitX))

    // 값은 어디에도 남지 않는다 — 진행 로그는 자리수만 말한다
    expect(h.steps.some((s) => s.label.includes(SECRET))).toBe(false)
    expect(h.steps.some((s) => s.label === '결제 비밀번호 입력(6자리)')).toBe(true)

    // 기록에는 결제수단이 남고 인증번호·발신번호는 없다
    const events = h.repo.listAuthEvents()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('app_approve')
    expect(events[0].ok).toBe(true)
    expect(events[0].payMethod).toBe('토스페이')
    expect(events[0].code).toBeNull()
    expect(events[0].senderTail).toBeNull()
  })

  it('비밀번호 화면인 동안 화면 프레임을 막고, 끝나면 곧바로 푼다', async () => {
    const h = harness(db)
    scriptPayScreens(h.adb)
    h.paySuccess.value = true
    // 비밀번호를 누르는 순간의 표식 상태를 기록한다
    const seen: boolean[] = []
    h.deps.vault = fakeVault({
      getSecretForFill: () => {
        seen.push(h.gate.isSecret(SERIAL))
        return SECRET
      }
    })
    const bridge = createPhoneAgentBridge(h.deps)
    await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(seen).toEqual([true])
    // 끝나면 화면 전송이 되살아난다
    expect(h.gate.isSecret(SERIAL)).toBe(false)
  })

  it('새 (사이트 × 결제수단) 조합의 첫 결제는 소액만 허용하고, 성공하면 이력이 남는다', async () => {
    const h = harness(db)
    scriptPayScreens(h.adb)
    h.paySuccess.value = true
    const bridge = createPhoneAgentBridge(h.deps)

    const tooLarge = await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 12_000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(tooLarge).toEqual({ ok: false, reason: 'first-run-too-large' })
    // 막힌 결제는 확인 카드도 띄우지 않는다
    expect(h.confirms).toHaveLength(0)
    expect(h.repo.hasPayApproval(HOST, '토스페이')).toBe(false)

    const small = await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(small.ok).toBe(true)
    expect(h.repo.hasPayApproval(HOST, '토스페이')).toBe(true)
    // 다른 결제수단은 여전히 첫 결제다
    expect(h.repo.hasPayApproval(HOST, '페이코')).toBe(false)
  })

  it('사용자가 확인 카드를 거부하면 앱을 열지도 않는다', async () => {
    const h = harness(db, { confirm: false })
    scriptPayScreens(h.adb)
    const bridge = createPhoneAgentBridge(h.deps)
    const r = await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(r).toEqual({ ok: false, reason: 'declined' })
    expect(h.adb.calls.some((c) => c.includes('supertoss://'))).toBe(false)
  })

  it('금고가 잠겨 있으면 확인 카드 전에 멈춘다', async () => {
    const h = harness(db, { vault: { state: () => 'locked' } })
    scriptPayScreens(h.adb)
    const bridge = createPhoneAgentBridge(h.deps)
    const r = await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(r).toEqual({ ok: false, reason: 'vault-locked' })
    expect(h.confirms).toHaveLength(0)
  })

  it('이 사이트의 계정을 특정할 수 없으면 실행기에 닿지 않는다', async () => {
    const h = harness(db, { vault: { listAccounts: () => [] } })
    scriptPayScreens(h.adb)
    const bridge = createPhoneAgentBridge(h.deps)
    const r = await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(r).toEqual({ ok: false, reason: 'no-account' })
    expect(h.confirms).toHaveLength(0)
  })

  it('앱은 끝냈지만 웹 결제창이 성공으로 넘어가지 않으면 성공으로 보지 않는다', async () => {
    const h = harness(db)
    scriptPayScreens(h.adb)
    h.paySuccess.value = false
    const bridge = createPhoneAgentBridge(h.deps)
    const r = await bridge.approvePayment(h.ctx, {
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verify-failed')
    expect(h.repo.listAuthEvents()[0].ok).toBe(false)
  })

  it('결제 도구는 실행기 결과를 상태 이름으로만 돌려준다', async () => {
    const h = harness(db)
    scriptPayScreens(h.adb)
    h.paySuccess.value = true
    const bridge = createPhoneAgentBridge(h.deps)
    const payTool = createPayTool({
      isPro: () => true,
      tick: () => null,
      onStep: h.ctx.onStep,
      run: (req) => bridge.approvePayment(h.ctx, req)
    })
    const out = (await (
      payTool as unknown as { handler: (a: Record<string, unknown>) => Promise<unknown> }
    ).handler({
      provider: 'toss',
      amountKrw: 9000,
      merchant: '삼바상회',
      methodLabel: '토스페이'
    })) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toBe('ok')
    expect(out.content[0].text).not.toContain(SECRET)
  })
})
