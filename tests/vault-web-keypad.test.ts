// 웹 결제 비밀번호 키패드 입력의 안전 테스트(폰 pay-secret 과 같은 방어선) —
// 값이 함수 밖(반환값·라벨·클릭 인자 순서 외)으로 한 글자도 새지 않는지 단언한다

import { describe, it, expect, vi } from 'vitest'
import {
  enterWebPaymentPassword,
  isCompleteLayout,
  type WebKeypadVault
} from '../src/main/vault/web-keypad'
import type { KeypadLayout } from '../src/main/browser/page-bridge'
import type { PaymentProvider, VaultState } from '../src/shared/vault'

// 테스트용 가짜 비밀번호. 이 문자열이 반환값·라벨 어디에도 나타나면 안 된다
const SECRET = '149072'
const SECRET_RE = /149072/

/** 숫자 d 의 버튼 id 는 100+d — 클릭 순서 단언을 쉽게 하기 위해서다 */
function layoutOf(
  digits: string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  filled: number | null = 0
): KeypadLayout {
  const map: Record<string, number> = {}
  for (const d of digits) map[d] = 100 + Number(d)
  return { digits: map, filled, frameIndex: 1 }
}

interface VaultCalls {
  providers: (PaymentProvider | undefined)[]
}

function fakeVault(
  opts: { state?: VaultState; secret?: string | null; ambiguous?: boolean } = {},
  calls: VaultCalls = { providers: [] }
): WebKeypadVault {
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

function build(
  opts: {
    state?: VaultState
    secret?: string | null
    ambiguous?: boolean
    layout?: KeypadLayout
    provider?: PaymentProvider
    /** 클릭마다 자리수가 어떻게 변하는가(기본: 하나씩 늘어난다). null 이면 셀 수 없음 */
    filledAfter?: (clicks: number) => number | null
  } = {}
): {
  deps: Parameters<typeof enterWebPaymentPassword>[0]
  click: ReturnType<typeof vi.fn>
  steps: Array<{ label: string; ok: boolean }>
  calls: VaultCalls
} {
  let clicks = 0
  const click = vi.fn(async () => {
    clicks += 1
    return 'ok'
  })
  const steps: Array<{ label: string; ok: boolean }> = []
  const calls: VaultCalls = { providers: [] }
  const filledAfter = opts.filledAfter ?? ((n: number) => n)
  const deps: Parameters<typeof enterWebPaymentPassword>[0] = {
    vault: fakeVault(opts, calls),
    accountId: 7,
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    jobId: 'job-1',
    layout: opts.layout ?? layoutOf(),
    click,
    filled: async () => filledAfter(clicks),
    sleep: async () => {},
    onStep: (label, ok) => {
      steps.push({ label, ok })
    }
  }
  return { deps, click, steps, calls }
}

describe('enterWebPaymentPassword', () => {
  it('자리수만큼 숫자 버튼 id 를 순서대로 누른다', async () => {
    const { deps, click } = build()
    const r = await enterWebPaymentPassword(deps)
    expect(r).toBe('ok')
    expect(click.mock.calls.map((c) => c[0])).toEqual(SECRET.split('').map((d) => 100 + Number(d)))
  })

  it('반환값·라벨에 비밀번호가 섞이지 않는다(라벨은 자리수만)', async () => {
    const { deps, steps } = build()
    const r = await enterWebPaymentPassword(deps)
    expect(SECRET_RE.test(r)).toBe(false)
    expect(steps).toEqual([{ label: '결제 비밀번호 입력(6자리)', ok: true }])
    expect(SECRET_RE.test(steps[0].label)).toBe(false)
  })

  it('금고가 잠겨 있으면 한 번도 누르지 않는다', async () => {
    const { deps, click, steps } = build({ state: 'locked' })
    expect(await enterWebPaymentPassword(deps)).toBe('locked')
    expect(click).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })

  it('항목이 없으면 not-found, 여럿이면 ambiguous — 누르지 않는다', async () => {
    const none = build({ secret: null })
    expect(await enterWebPaymentPassword(none.deps)).toBe('not-found')
    expect(none.click).not.toHaveBeenCalled()
    const many = build({ ambiguous: true })
    expect(await enterWebPaymentPassword(many.deps)).toBe('ambiguous')
    expect(many.click).not.toHaveBeenCalled()
  })

  it('배치에 숫자가 빠지면 금고를 읽기 전에 layout-incomplete 로 멈춘다', async () => {
    const { deps, click, calls } = build({
      layout: layoutOf(['1', '2', '3', '4', '5', '6', '7', '8'])
    })
    expect(await enterWebPaymentPassword(deps)).toBe('layout-incomplete')
    expect(click).not.toHaveBeenCalled()
    expect(calls.providers).toEqual([])
  })

  it('숫자가 아닌 글자가 든 값은 누르지 않는다', async () => {
    const { deps, click } = build({ secret: '12a4' })
    expect(await enterWebPaymentPassword(deps)).toBe('layout-incomplete')
    expect(click).not.toHaveBeenCalled()
  })

  it('눌러도 자리수가 늘지 않으면 첫 자리에서 멈추고 verify-failed', async () => {
    const { deps, click, steps } = build({ filledAfter: () => 0 })
    expect(await enterWebPaymentPassword(deps)).toBe('verify-failed')
    expect(click).toHaveBeenCalledTimes(1)
    expect(steps).toEqual([{ label: '결제 비밀번호 입력 확인 실패(1자리째)', ok: false }])
  })

  it('자리수를 셀 수 없으면(filled null) 검증 없이 끝까지 누른다', async () => {
    const { deps, click } = build({ layout: layoutOf(undefined, null), filledAfter: () => null })
    expect(await enterWebPaymentPassword(deps)).toBe('ok')
    expect(click).toHaveBeenCalledTimes(6)
  })

  it('이미 몇 자리 찍혀 있어도 그 위에서 늘어나는지로 검증한다', async () => {
    const { deps, click } = build({ layout: layoutOf(undefined, 2), filledAfter: (n) => 2 + n })
    expect(await enterWebPaymentPassword(deps)).toBe('ok')
    expect(click).toHaveBeenCalledTimes(6)
  })

  it('고른 결제 수단(provider)을 그대로 금고 조회에 넘긴다', async () => {
    const { deps, calls } = build({ provider: 'site' })
    await enterWebPaymentPassword(deps)
    expect(calls.providers).toEqual(['site'])
  })
})

describe('isCompleteLayout', () => {
  it('0~9 가 모두 있어야 true', () => {
    expect(isCompleteLayout(layoutOf())).toBe(true)
    expect(isCompleteLayout(layoutOf(['0', '1']))).toBe(false)
    expect(isCompleteLayout(null)).toBe(false)
  })
})
