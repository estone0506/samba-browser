// 결제 비밀번호 입력의 안전 테스트. 이 파일이 3단계에서 가장 중요한 방어선이다 —
// 값이 함수 밖(반환값·로그 라벨·인자)으로 한 글자도 새지 않는지 단언한다

import { describe, it, expect, vi } from 'vitest'
import {
  tapPaymentPassword,
  keypadFromUiTree,
  type PaySecretVault
} from '../src/main/phone/pay-secret'
import type { KeypadLayout } from '../src/main/ai/visual'
import type { PhoneScreen } from '../src/shared/phone-snapshot'
import type { PaymentProvider, VaultState } from '../src/shared/vault'

const SERIAL = 'R3CRA05HY3R'
// 테스트용 가짜 비밀번호. 이 문자열이 반환값·라벨 어디에도 나타나면 안 된다
const SECRET = '149072'
const SECRET_RE = /149072/

/** 숫자 d 의 키패드 좌표는 (d*10, 100+d) 로 둔다 — 좌표 일치 단언을 쉽게 하기 위해서다 */
function layoutOf(
  digits: string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
): KeypadLayout {
  const map: Record<string, { x: number; y: number }> = {}
  for (const d of digits) map[d] = { x: Number(d) * 10, y: 100 + Number(d) }
  return { digits: map }
}

// 조회에 넘어온 제공자를 기록해 둔다 — 결제앱에 맞는 항목을 골랐는지 단언하기 위해서다
interface VaultCalls {
  providers: (PaymentProvider | undefined)[]
}

function fakeVault(
  opts: { state?: VaultState; secret?: string | null; ambiguous?: boolean } = {},
  calls: VaultCalls = { providers: [] }
): PaySecretVault {
  return {
    state: () => opts.state ?? 'unlocked',
    getPaymentSecretForFill: (args) => {
      calls.providers.push(args.provider)
      if (opts.ambiguous) return { value: null, reason: 'ambiguous' }
      const value = opts.secret === undefined ? SECRET : opts.secret
      return value === null ? { value: null, reason: 'not-found' } : { value }
    }
  }
}

interface SecretHarness {
  deps: Parameters<typeof tapPaymentPassword>[0]
  tap: ReturnType<typeof vi.fn>
  steps: Array<{ label: string; ok: boolean }>
  calls: VaultCalls
}

function build(
  opts: {
    state?: VaultState
    secret?: string | null
    ambiguous?: boolean
    layout?: KeypadLayout
    provider?: PaymentProvider
  } = {}
): SecretHarness {
  const tap = vi.fn(async () => {})
  const steps: Array<{ label: string; ok: boolean }> = []
  const calls: VaultCalls = { providers: [] }
  const deps = {
    vault: fakeVault(opts, calls),
    accountId: 7,
    provider: opts.provider ?? ('toss' as PaymentProvider),
    jobId: 'job-1',
    serial: SERIAL,
    layout: opts.layout ?? layoutOf(),
    tap,
    onStep: (label: string, ok: boolean) => {
      steps.push({ label, ok })
    }
  }
  return { deps, tap, steps, calls }
}

describe('tapPaymentPassword', () => {
  it('자리수만큼 키패드 좌표를 정확히 탭한다', async () => {
    const { deps, tap } = build()
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('ok')
    expect(tap).toHaveBeenCalledTimes(6)
    const expected = SECRET.split('').map((d) => [SERIAL, Number(d) * 10, 100 + Number(d)])
    expect(tap.mock.calls).toEqual(expected)
  })

  it('반환값에 비밀번호가 섞이지 않는다', async () => {
    const { deps } = build()
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('ok')
    expect(SECRET_RE.test(r)).toBe(false)
    expect(/[0-9]/.test(r)).toBe(false)
  })

  it('진행 로그 라벨에는 자리수만 남고 값은 남지 않는다', async () => {
    const { deps, steps } = build()
    await tapPaymentPassword(deps)

    expect(steps).toEqual([{ label: '결제 비밀번호 입력(6자리)', ok: true }])
    expect(SECRET_RE.test(steps[0].label)).toBe(false)
  })

  it('금고가 잠겨 있으면 한 번도 탭하지 않고 locked 를 돌려준다', async () => {
    const { deps, tap, steps } = build({ state: 'locked' })
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('locked')
    expect(tap).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })

  it('저장된 항목이 없으면 not-found 를 돌려준다', async () => {
    const { deps, tap } = build({ secret: null })
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('not-found')
    expect(tap).not.toHaveBeenCalled()
  })

  it('키패드 배치에 숫자가 하나라도 빠지면 탭하지 않는다', async () => {
    // 9 가 빠진 배치. 비밀번호에 쓰이는 0 도 빠뜨려 부분 배치를 만든다
    const { deps, tap } = build({ layout: layoutOf(['1', '2', '3', '4', '5', '6', '7', '8']) })
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('layout-incomplete')
    expect(tap).not.toHaveBeenCalled()
  })

  it('고른 결제 수단(provider)을 그대로 금고 조회에 넘긴다', async () => {
    const { deps, calls } = build({ provider: 'payco' })
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('ok')
    expect(calls.providers).toEqual(['payco'])
  })

  it('어느 결제 비밀번호인지 좁히지 못하면 한 번도 탭하지 않는다', async () => {
    const { deps, tap, steps } = build({ ambiguous: true })
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('ambiguous')
    expect(tap).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })

  it('비밀번호 문자열을 받는 매개변수가 없다', async () => {
    type Deps = Parameters<typeof tapPaymentPassword>[0]
    // 값으로 넘기는 통로가 타입에 존재하지 않는다(있으면 컴파일이 깨진다)
    type HasSecretKey =
      Extract<keyof Deps, 'password' | 'secret' | 'pin' | 'value'> extends never ? true : false
    const noSecretParam: HasSecretKey = true
    expect(noSecretParam).toBe(true)
    // 인자는 deps 객체 하나뿐이다
    expect(tapPaymentPassword.length).toBe(1)
  })

  it('숫자가 아닌 값이 저장돼 있으면 배치에 없으므로 탭하지 않는다', async () => {
    const { deps, tap } = build({ secret: 'ab12' })
    const r = await tapPaymentPassword(deps)

    expect(r).toBe('layout-incomplete')
    expect(tap).not.toHaveBeenCalled()
  })
})

describe('keypadFromUiTree', () => {
  function screenWith(texts: string[]): PhoneScreen {
    return {
      serial: SERIAL,
      width: 720,
      height: 1600,
      app: 'viva.republica.toss',
      elements: texts.map((t, i) => ({
        id: i + 1,
        text: t,
        className: 'android.widget.Button',
        clickable: true,
        bounds: { l: i * 10, t: 100, r: i * 10 + 8, b: 140 },
        center: { x: i * 10 + 4, y: 120 },
        isSecret: false
      }))
    }
  }

  it('0~9 가 모두 보이면 배치를 만든다', () => {
    const layout = keypadFromUiTree(screenWith(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']))
    expect(layout).not.toBeNull()
    expect(layout?.digits['0']).toEqual({ x: 94, y: 120 })
    expect(Object.keys(layout?.digits ?? {}).sort()).toHaveLength(10)
  })

  it('숫자가 하나라도 없으면 null(부분 배치로 누르지 않는다)', () => {
    expect(keypadFromUiTree(screenWith(['1', '2', '3']))).toBeNull()
  })

  it('같은 숫자가 두 번 보이면 어느 칸인지 확정할 수 없어 null', () => {
    const layout = keypadFromUiTree(
      screenWith(['1', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'])
    )
    expect(layout).toBeNull()
  })
})
