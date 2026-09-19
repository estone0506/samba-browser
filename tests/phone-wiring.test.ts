// 3단계 배선 조각들 — Pro 게이트·비밀 화면 표식·진행 로그 중계·앱 실행·성공 판정·인증번호 읽기

import { describe, it, expect, vi } from 'vitest'
import {
  AgentProgressRelay,
  amStartArgs,
  createCodeReader,
  createKeypadReader,
  createLaunchApp,
  isPaySuccessUrl,
  monkeyArgs,
  phoneProEnabled,
  SECRET_SCREEN_TTL_MS,
  SecretScreenGate
} from '../src/main/phone/wiring'
import { PAY_PROVIDERS } from '../src/main/phone/pay'
import { FakeAdb } from './stubs/fake-adb'
import type { PhoneScreen } from '../src/shared/phone-snapshot'

const SERIAL = 'R3CRA05HY3R'

describe('phoneProEnabled — Pro 게이트와 개발 우회', () => {
  it('Pro 계정은 언제나 허용된다', () => {
    expect(phoneProEnabled({ plan: 'pro', devOverride: false, packaged: true })).toBe(true)
  })

  it('free 계정은 기본적으로 막힌다', () => {
    expect(phoneProEnabled({ plan: 'free', devOverride: false, packaged: false })).toBe(false)
  })

  it('개발 중에는 설정이나 환경변수로 열 수 있다', () => {
    expect(phoneProEnabled({ plan: 'free', devOverride: true, packaged: false })).toBe(true)
    expect(phoneProEnabled({ plan: 'free', devOverride: false, env: '1', packaged: false })).toBe(
      true
    )
    // 1 이 아닌 값은 켜지 않는다
    expect(phoneProEnabled({ plan: 'free', devOverride: false, env: '0', packaged: false })).toBe(
      false
    )
  })

  it('배포판에서는 우회를 통째로 무시한다', () => {
    expect(phoneProEnabled({ plan: 'free', devOverride: true, env: '1', packaged: true })).toBe(
      false
    )
  })
})

describe('SecretScreenGate — 비밀번호 화면 프레임 차단', () => {
  it('표식이 없으면 막지 않는다', () => {
    expect(new SecretScreenGate(() => 0).isSecret(SERIAL)).toBe(false)
  })

  it('표식을 찍으면 그 폰만 막고, 지우면 곧바로 풀린다', () => {
    const now = 1000
    const gate = new SecretScreenGate(() => now)
    gate.mark(SERIAL)
    expect(gate.isSecret(SERIAL)).toBe(true)
    expect(gate.isSecret('OTHER')).toBe(false)
    gate.clear(SERIAL)
    expect(gate.isSecret(SERIAL)).toBe(false)
  })

  it('표식은 시간이 지나면 저절로 풀린다(결제가 끊겨도 화면이 영영 멈추지 않는다)', () => {
    let now = 1000
    const gate = new SecretScreenGate(() => now)
    gate.mark(SERIAL)
    now += SECRET_SCREEN_TTL_MS - 1
    expect(gate.isSecret(SERIAL)).toBe(true)
    now += 2
    expect(gate.isSecret(SERIAL)).toBe(false)
  })
})

describe('AgentProgressRelay — ARS 안내를 채팅 진행 로그로', () => {
  it('붙이기 전과 뗀 뒤에는 아무 데도 가지 않는다', () => {
    const relay = new AgentProgressRelay()
    relay.emit('무시된다')
    const steps: string[] = []
    const unbind = relay.bind((label) => steps.push(label))
    relay.emit('전화 인증 수신 감지')
    unbind()
    relay.emit('작업이 끝난 뒤')
    expect(steps).toEqual(['전화 인증 수신 감지'])
  })

  it('나중에 붙은 sink 만 받는다(이전 작업의 로그가 섞이지 않는다)', () => {
    const relay = new AgentProgressRelay()
    const first: string[] = []
    const second: string[] = []
    relay.bind((l) => first.push(l))
    relay.bind((l) => second.push(l))
    relay.emit('두 번째 작업')
    expect(first).toEqual([])
    expect(second).toEqual(['두 번째 작업'])
  })
})

describe('결제 앱 띄우기', () => {
  it('딥링크는 am start -a VIEW -d 로 부른다', () => {
    expect(amStartArgs(SERIAL, 'supertoss://')).toEqual([
      '-s',
      SERIAL,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'supertoss://'
    ])
  })

  it('런처 폴백은 monkey -p <패키지> 1 이다', () => {
    expect(monkeyArgs(SERIAL, 'viva.republica.toss')).toContain('monkey')
    expect(monkeyArgs(SERIAL, 'viva.republica.toss')).toContain('viva.republica.toss')
  })

  it('딥링크가 되면 런처 폴백을 쓰지 않는다', async () => {
    const adb = new FakeAdb()
    await createLaunchApp(adb)(SERIAL, PAY_PROVIDERS.toss.deepLink)
    expect(adb.calls.filter((c) => c.includes('monkey'))).toHaveLength(0)
    expect(adb.calls.filter((c) => c.includes('am'))).toHaveLength(1)
  })

  it('딥링크가 막히면 같은 제공자의 패키지를 런처로 띄운다', async () => {
    const adb = new FakeAdb()
    adb.reply('am start', 'Error: Activity not started, unable to resolve Intent', 1)
    await createLaunchApp(adb)(SERIAL, PAY_PROVIDERS.payco.deepLink)
    const monkey = adb.calls.find((c) => c.includes('monkey'))
    expect(monkey).toBeDefined()
    expect(monkey).toContain(PAY_PROVIDERS.payco.packageName)
  })

  it('종료 코드가 0 이어도 출력이 오류면 폴백한다', async () => {
    const adb = new FakeAdb()
    adb.reply('am start', 'Error type 3\nError: Activity class does not exist', 0)
    await createLaunchApp(adb)(SERIAL, PAY_PROVIDERS.toss.deepLink)
    expect(adb.calls.some((c) => c.includes('monkey'))).toBe(true)
  })
})

describe('isPaySuccessUrl — 웹 결제창 성공 판정', () => {
  it('성공 낱말이 있으면 참이다', () => {
    expect(isPaySuccessUrl('https://shop.example.com/pay/success?oid=1')).toBe(true)
    expect(isPaySuccessUrl('https://shop.example.com/order/completed')).toBe(true)
  })

  it('실패 낱말이 섞여 있으면 성공으로 보지 않는다', () => {
    expect(isPaySuccessUrl('https://shop.example.com/pay/success?state=cancel')).toBe(false)
    expect(isPaySuccessUrl('https://shop.example.com/pay/fail')).toBe(false)
  })

  it('아무 표식도 없는 주소는 성공이 아니다', () => {
    expect(isPaySuccessUrl('https://shop.example.com/checkout')).toBe(false)
  })
})

describe('createCodeReader — 로컬 OCR 1차, Visual 2차', () => {
  const png = Buffer.from([1, 2, 3])

  it('로컬에서 읽히면 Visual 을 부르지 않는다', async () => {
    const visual = vi.fn(async () => '000000')
    const read = createCodeReader({
      ocrEnabled: () => true,
      ocr: { hasModels: () => true, recognize: async () => ({ text: '인증번호 483920 입니다' }) },
      visual
    })
    expect(await read(png)).toBe('483920')
    expect(visual).not.toHaveBeenCalled()
  })

  it('로컬이 꺼져 있거나 모델이 없으면 곧바로 Visual 로 간다', async () => {
    const visual = vi.fn(async () => '112233')
    const recognize = vi.fn(async () => ({ text: '483920' }))
    const off = createCodeReader({
      ocrEnabled: () => false,
      ocr: { hasModels: () => true, recognize },
      visual
    })
    expect(await off(png)).toBe('112233')
    expect(recognize).not.toHaveBeenCalled()

    const noModel = createCodeReader({
      ocrEnabled: () => true,
      ocr: { hasModels: () => false, recognize },
      visual
    })
    expect(await noModel(png)).toBe('112233')
    expect(recognize).not.toHaveBeenCalled()
  })

  it('로컬이 글자를 못 찾거나 던지면 Visual 로 넘긴다', async () => {
    const visual = vi.fn(async () => '445566')
    const empty = createCodeReader({
      ocrEnabled: () => true,
      ocr: { hasModels: () => true, recognize: async () => ({ text: '광고입니다' }) },
      visual
    })
    expect(await empty(png)).toBe('445566')

    const thrown = createCodeReader({
      ocrEnabled: () => true,
      ocr: {
        hasModels: () => true,
        recognize: () => Promise.reject(new Error('세션 적재 실패'))
      },
      visual
    })
    expect(await thrown(png)).toBe('445566')
  })

  it('빈 캡처는 어느 경로도 부르지 않는다', async () => {
    const visual = vi.fn(async () => '000000')
    const read = createCodeReader({ ocrEnabled: () => true, ocr: null, visual })
    expect(await read(Buffer.alloc(0))).toBeNull()
    expect(visual).not.toHaveBeenCalled()
  })
})

describe('createKeypadReader — 비밀번호 화면 캡처는 배치만 얻고 버린다', () => {
  const screen = (): PhoneScreen => ({
    serial: SERIAL,
    width: 720,
    height: 1600,
    app: 'viva.republica.toss',
    elements: []
  })

  it('화면 크기를 그대로 넘기고 배치를 돌려준다', async () => {
    const adb = new FakeAdb()
    adb.replyBinary('screencap', Buffer.from([9, 9, 9]))
    const sizes: Array<{ width: number; height: number }> = []
    const read = createKeypadReader({
      adb,
      screen: async () => screen(),
      readLayout: async (_png, size) => {
        sizes.push(size)
        return { digits: { '0': { x: 1, y: 2 } } }
      }
    })
    expect(await read(SERIAL)).toEqual({ digits: { '0': { x: 1, y: 2 } } })
    expect(sizes).toEqual([{ width: 720, height: 1600 }])
  })

  it('캡처가 비었으면 모델을 부르지 않는다', async () => {
    const adb = new FakeAdb()
    const readLayout = vi.fn(async () => null)
    const read = createKeypadReader({ adb, screen: async () => screen(), readLayout })
    expect(await read(SERIAL)).toBeNull()
    expect(readLayout).not.toHaveBeenCalled()
  })

  it('덤프가 던져도 배치 없음으로만 끝난다(호출부가 사람에게 넘긴다)', async () => {
    const adb = new FakeAdb()
    const read = createKeypadReader({
      adb,
      screen: () => Promise.reject(new Error('덤프 실패')),
      readLayout: async () => ({ digits: {} })
    })
    expect(await read(SERIAL)).toBeNull()
  })
})
