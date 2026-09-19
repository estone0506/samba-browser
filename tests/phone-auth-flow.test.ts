// 문자 인증 자동 입력 오케스트레이션 테스트.
// adb 는 가짜 구현(FakeAdb)만 쓰고 실제 프로세스를 절대 띄우지 않는다.
// 기록된 이벤트에 문자 본문이 들어가지 않는다는 점을 여기서 못 박는다

import { describe, it, expect, vi } from 'vitest'
import {
  findCodeField,
  runSmsAuth,
  callState,
  detectIncomingCall,
  CALL_STATE_ARGS,
  type AuthFlowDeps
} from '../src/main/phone/auth-flow'
import { AUTH_TIMEOUT_MS } from '../src/shared/phone'
import type { AuthEventDto, PhoneAuthWaitingDto } from '../src/shared/phone'
import type { PageElement, PageSnapshot } from '../src/shared/snapshot'
import { FakeAdb } from './stubs/fake-adb'

const SERIAL = 'R3CRA05HY3R'
const HOST = 'toss.im'
const START = 1_758_200_000_000

function el(p: Partial<PageElement>): PageElement {
  return { id: 1, tag: 'input', role: 'textbox', text: '', isSecret: false, ...p }
}

function snap(elements: PageElement[]): PageSnapshot {
  return { url: `https://${HOST}/auth`, title: '본인확인', text: '', elements }
}

/** 인증번호 문자 한 줄(content query 출력 흉내) */
function inboxRow(dateMs: number, body = '[Web발신] 인증번호 [493028] 입력'): string {
  return `Row: 0 _id=12, address=01012345678, body=${body}, date=${dateMs}`
}

const DENIED = 'java.lang.SecurityException: Permission Denial: reading SmsProvider'

interface Built {
  deps: AuthFlowDeps
  adb: FakeAdb
  events: Array<Omit<AuthEventDto, 'id'>>
  notices: PhoneAuthWaitingDto[]
  fillValue: ReturnType<typeof vi.fn>
  submit: ReturnType<typeof vi.fn>
  screenshot: ReturnType<typeof vi.fn>
  readCodeFromImage: ReturnType<typeof vi.fn>
  snapshot: ReturnType<typeof vi.fn>
}

function build(
  opts: {
    elements?: PageElement[]
    serials?: string[]
    inbox?: string
    blocked?: boolean
    autoSubmit?: boolean
    visualCode?: string | null
    fillResult?: string
  } = {}
): Built {
  // 가상 시계 — sleep 이 시간을 앞으로 돌려 3분 타임아웃을 즉시 재현한다
  let clock = START
  const adb = new FakeAdb()
  if (opts.blocked) {
    adb.reply('content query', DENIED, 1)
    adb.reply('dumpsys notification', DENIED, 1)
  } else {
    adb.reply('content query', opts.inbox ?? '')
  }
  adb.replyBinary('screencap', Buffer.from('fake-png'))

  const events: Array<Omit<AuthEventDto, 'id'>> = []
  const notices: PhoneAuthWaitingDto[] = []
  const fillValue = vi.fn(async () => opts.fillResult ?? 'filled')
  const submit = vi.fn(async () => 'submitted')
  const screenshot = vi.fn(async () => Buffer.from('fake-png'))
  const readCodeFromImage = vi.fn(async () => opts.visualCode ?? null)
  const snapshot = vi.fn(async () =>
    snap(opts.elements ?? [el({ id: 7, name: 'authNumber', text: '인증번호' })])
  )

  const deps: AuthFlowDeps = {
    adb,
    serials: () => opts.serials ?? [SERIAL],
    siteHost: HOST,
    jobId: 'job-1',
    snapshot,
    fillValue,
    submit,
    autoSubmit: opts.autoSubmit ?? true,
    screenshot,
    readCodeFromImage,
    record: (e) => events.push(e),
    notify: (d) => notices.push(d),
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    }
  }
  return { deps, adb, events, notices, fillValue, submit, screenshot, readCodeFromImage, snapshot }
}

describe('findCodeField', () => {
  it('inputType 이 tel·number 인 입력칸을 고른다', () => {
    for (const inputType of ['tel', 'number']) {
      const picked = findCodeField(snap([el({ id: 3, inputType })]))
      expect(picked?.id).toBe(3)
    }
  })

  it('name·text 에 인증 문구가 있으면 고른다', () => {
    const names = ['authNumber', 'verificationCode', 'otp']
    for (const name of names) {
      expect(findCodeField(snap([el({ id: 5, name })]))?.id).toBe(5)
    }
    for (const text of ['인증번호', '확인번호 6자리', 'verification code']) {
      expect(findCodeField(snap([el({ id: 6, text })]))?.id).toBe(6)
    }
  })

  it('비밀 입력칸은 절대 고르지 않는다', () => {
    const elements = [
      el({ id: 1, name: 'password', inputType: 'password', isSecret: true, text: '인증번호' }),
      el({ id: 2, name: 'nickname' })
    ]
    expect(findCodeField(snap(elements))).toBeNull()
  })

  it('우편번호·쿠폰코드처럼 인증과 무관한 칸은 고르지 않는다', () => {
    const elements = [
      el({ id: 1, name: 'zipcode', inputType: 'number' }),
      el({ id: 2, name: 'couponCode' }),
      el({ id: 3, name: 'postCode', text: '우편번호' })
    ]
    expect(findCodeField(snap(elements))).toBeNull()
  })

  it('문구가 맞는 칸을 숫자 칸보다 먼저 고른다', () => {
    const elements = [el({ id: 1, inputType: 'number' }), el({ id: 2, name: 'smsAuthCode' })]
    expect(findCodeField(snap(elements))?.id).toBe(2)
  })

  it('후보가 없으면 null 이다', () => {
    expect(findCodeField(snap([el({ id: 1, name: 'nickname' })]))).toBeNull()
    expect(findCodeField(snap([]))).toBeNull()
  })
})

describe('runSmsAuth — 실패 선조건', () => {
  it('입력칸 후보가 없으면 폴링을 시작하지 않는다', async () => {
    const b = build({ elements: [el({ id: 1, name: 'nickname' })] })
    const r = await runSmsAuth(b.deps)
    expect(r).toEqual({ ok: false, reason: 'no-field' })
    expect(b.adb.calls.length).toBe(0)
    expect(b.notices).toEqual([])
    expect(b.events).toEqual([])
  })

  it('연결된 폰이 0대면 no-phone 이고 폴링하지 않는다', async () => {
    const b = build({ serials: [] })
    const r = await runSmsAuth(b.deps)
    expect(r).toEqual({ ok: false, reason: 'no-phone' })
    expect(b.adb.calls.length).toBe(0)
  })

  it('입력에 실패하면 fill-failed 이고 제출하지 않는다', async () => {
    const b = build({ inbox: inboxRow(START), fillResult: 'fill failed' })
    const r = await runSmsAuth(b.deps)
    expect(r).toEqual({ ok: false, reason: 'fill-failed' })
    expect(b.submit).not.toHaveBeenCalled()
    expect(b.events[0].ok).toBe(false)
    expect(b.notices.at(-1)?.waiting).toBe(false)
  })
})

describe('runSmsAuth — 정상 흐름', () => {
  it('대기 통지 → 문자 감지 → 입력 → 제출 → 완료 통지 순으로 돈다', async () => {
    const b = build({ inbox: inboxRow(START) })
    const r = await runSmsAuth(b.deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.method).toBe('sms_query')

    expect(b.notices[0]).toEqual({ waiting: true, kind: 'sms', siteHost: HOST, phoneId: null })
    expect(b.notices.at(-1)?.waiting).toBe(false)
    expect(b.fillValue).toHaveBeenCalledWith(7, '493028')
    expect(b.submit).toHaveBeenCalledWith(7)

    expect(b.events).toHaveLength(1)
    expect(b.events[0]).toMatchObject({
      kind: 'sms',
      ok: true,
      method: 'sms_query',
      siteHost: HOST,
      jobId: 'job-1',
      code: '493028',
      senderTail: '5678'
    })
  })

  it('autoSubmit 이 false 면 제출하지 않고도 성공이다', async () => {
    const b = build({ inbox: inboxRow(START), autoSubmit: false })
    const r = await runSmsAuth(b.deps)
    expect(r.ok).toBe(true)
    expect(b.fillValue).toHaveBeenCalled()
    expect(b.submit).not.toHaveBeenCalled()
  })

  it('기록에는 문자 본문이 없고 code·senderTail 만 있다', async () => {
    const body = '[Web발신] 토스 인증번호 [493028] 타인에게 알려주지 마세요'
    const b = build({ inbox: inboxRow(START, body) })
    await runSmsAuth(b.deps)
    const serialized = JSON.stringify(b.events[0])
    expect(serialized).not.toContain('Web발신')
    expect(serialized).not.toContain('타인에게')
    expect(Object.keys(b.events[0]).sort()).toEqual(
      [
        'at',
        'code',
        'elapsedMs',
        'jobId',
        'kind',
        'method',
        'ok',
        'phoneId',
        'senderTail',
        'siteHost'
      ].sort()
    )
  })
})

describe('runSmsAuth — Visual 폴백', () => {
  it('3분 안에 문자가 없으면 스크린샷 → Visual 로 읽어 채운다', async () => {
    const b = build({ visualCode: '778811' })
    const r = await runSmsAuth(b.deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.method).toBe('visual')
    expect(b.screenshot).toHaveBeenCalledWith(SERIAL)
    expect(b.fillValue).toHaveBeenCalledWith(7, '778811')
    expect(b.events[0]).toMatchObject({ ok: true, method: 'visual', senderTail: null })
  })

  it('문자함·알림이 모두 막힌 폰은 폴링 중에 화면 읽기로 우회한다', async () => {
    const b = build({ blocked: true, visualCode: '445566' })
    const r = await runSmsAuth(b.deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.method).toBe('visual')
    // 3분을 다 기다리지 않고 첫 폴링에서 끝난다
    expect(r.ok && r.elapsedMs).toBeLessThan(AUTH_TIMEOUT_MS)
    expect(b.fillValue).toHaveBeenCalledWith(7, '445566')
  })

  it('Visual 도 실패하면 timeout 이고 실패 이벤트를 남긴다', async () => {
    const b = build({ visualCode: null })
    const r = await runSmsAuth(b.deps)
    expect(r).toEqual({ ok: false, reason: 'timeout' })
    expect(b.fillValue).not.toHaveBeenCalled()
    expect(b.events).toHaveLength(1)
    expect(b.events[0]).toMatchObject({ ok: false, code: null, senderTail: null })
    expect(b.notices.at(-1)?.waiting).toBe(false)
  })

  it('스크린샷이 실패해도 예외를 밖으로 던지지 않는다', async () => {
    const b = build()
    b.deps.screenshot = vi.fn(async () => {
      throw new Error('screencap failed')
    })
    const r = await runSmsAuth(b.deps)
    expect(r).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('ARS 수신 감지', () => {
  it('mCallState 값을 0·1·2 로 읽는다', async () => {
    for (const [dump, expected] of [
      ['mCallState=0', 0],
      ['  mCallState=1\n', 1],
      ['mCallState=2', 2],
      ['', 0]
    ] as const) {
      const adb = new FakeAdb()
      adb.reply('telephony.registry', dump)
      expect(await callState(adb, SERIAL)).toBe(expected)
    }
  })

  it('조회 자체가 실패하면 대기(0)로 본다', async () => {
    const adb = new FakeAdb()
    adb.reply('telephony.registry', 'error: device offline', 1)
    expect(await callState(adb, SERIAL)).toBe(0)
  })

  it('dumpsys telephony.registry 를 해당 serial 로 부른다', async () => {
    const adb = new FakeAdb()
    await callState(adb, SERIAL)
    expect(adb.calls[0]).toEqual(['-s', SERIAL, 'shell', ...CALL_STATE_ARGS])
  })

  it('detectIncomingCall 이 수신중인 폰의 serial 을 돌려준다', async () => {
    const adb = new FakeAdb()
    adb.reply(`-s ${SERIAL} shell dumpsys telephony.registry`, 'mCallState=1')
    adb.reply('-s OTHER shell dumpsys telephony.registry', 'mCallState=0')
    expect(await detectIncomingCall(adb, ['OTHER', SERIAL])).toBe(SERIAL)
  })

  it('수신중인 폰이 없으면 null 이다', async () => {
    const adb = new FakeAdb()
    adb.reply('telephony.registry', 'mCallState=0')
    expect(await detectIncomingCall(adb, [SERIAL, 'OTHER'])).toBeNull()
  })
})
