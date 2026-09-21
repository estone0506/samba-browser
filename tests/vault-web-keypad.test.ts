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

  it('합성 클릭이 먹지 않으면 진짜 마우스 클릭으로 한 번만 다시 누른다(이중 입력 없음)', async () => {
    // 합성 클릭은 자리수를 올리지 못하고, 좌표 클릭만 올린다(nFilter 류)
    let filled = 0
    const click = vi.fn(async () => 'ok')
    const clickNative = vi.fn(async () => {
      filled += 1
      return true
    })
    const { deps, steps } = build()
    const r = await enterWebPaymentPassword({
      ...deps,
      click,
      clickNative,
      filled: async () => filled
    })
    expect(r).toBe('ok')
    expect(click).toHaveBeenCalledTimes(6)
    expect(clickNative).toHaveBeenCalledTimes(6)
    expect(filled).toBe(6)
    expect(steps.at(-1)).toEqual({ label: '결제 비밀번호 입력(6자리)', ok: true })
  })

  it('합성 클릭이 먹으면 좌표 클릭은 부르지 않는다', async () => {
    const clickNative = vi.fn(async () => true)
    const { deps } = build()
    expect(await enterWebPaymentPassword({ ...deps, clickNative })).toBe('ok')
    expect(clickNative).not.toHaveBeenCalled()
  })

  it('좌표 클릭까지 해도 자리수가 안 늘면 verify-failed', async () => {
    const clickNative = vi.fn(async () => true)
    const { deps, click } = build({ filledAfter: () => 0 })
    expect(await enterWebPaymentPassword({ ...deps, clickNative })).toBe('verify-failed')
    expect(click).toHaveBeenCalledTimes(1)
    expect(clickNative).toHaveBeenCalledTimes(1)
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

describe('재배열 키패드 — 매 자리 직전에 배치를 다시 읽는다', () => {
  it('둘째 자리부터 새 배치의 id 로 누른다', async () => {
    // 누를 때마다 id 가 1000 씩 밀리는 키패드
    let round = 0
    const relayout = vi.fn(async () => {
      round += 1
      const map: Record<string, number> = {}
      for (let d = 0; d <= 9; d += 1) map[String(d)] = round * 1000 + d
      return { digits: map, filled: null, frameIndex: 0 }
    })
    const { deps, click } = build({ layout: layoutOf(undefined, null), filledAfter: () => null })
    expect(await enterWebPaymentPassword({ ...deps, relayout })).toBe('ok')
    const ids = click.mock.calls.map((c) => c[0] as number)
    // 첫 자리는 처음 배치(100+d), 나머지는 다시 읽은 배치
    expect(ids[0]).toBe(100 + Number(SECRET[0]))
    expect(ids.slice(1)).toEqual(
      SECRET.slice(1)
        .split('')
        .map((d, i) => (i + 1) * 1000 + Number(d))
    )
    expect(relayout).toHaveBeenCalledTimes(5)
  })

  it('다시 읽은 배치가 불완전하면 그 자리에서 멈춘다', async () => {
    const relayout = vi.fn(async () => null)
    const { deps, click } = build({ layout: layoutOf(undefined, null), filledAfter: () => null })
    expect(await enterWebPaymentPassword({ ...deps, relayout })).toBe('verify-failed')
    expect(click).toHaveBeenCalledTimes(1)
  })
})
