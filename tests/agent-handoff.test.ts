import { describe, it, expect } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { SettingsStore } from '../src/main/settings/store'
import type { AgentEvent } from '../src/shared/ipc'
import { watchHandoff, handoffToolResult } from '../src/main/agent/handoff'
import { AgentRunner } from '../src/main/agent/runner'

// 폴링을 즉시 끝내는 가짜 시계(실제 3초를 기다리지 않는다)
const fastSleep = (): Promise<void> => Promise.resolve()

describe('watchHandoff — 사용자 처리 감지', () => {
  it('URL 이 바뀌면 재개로 본다', async () => {
    let url = 'https://shop.example/login'
    const r = await watchHandoff({
      currentUrl: () => url,
      stillBlocked: async () => {
        url = 'https://shop.example/home'
        return true
      },
      sleep: fastSleep,
      pollMs: 1,
      timeoutMs: 100
    })
    expect(r.outcome).toBe('resumed')
    expect(r.url).toBe('https://shop.example/home')
  })

  it('캡차 징후가 사라지면 재개로 본다', async () => {
    let blocked = true
    let calls = 0
    const r = await watchHandoff({
      currentUrl: () => 'https://shop.example/login',
      stillBlocked: async () => {
        calls += 1
        if (calls >= 3) blocked = false
        return blocked
      },
      sleep: fastSleep,
      pollMs: 1,
      timeoutMs: 100
    })
    expect(r.outcome).toBe('resumed')
    expect(calls).toBe(3)
  })

  it('상한 시간까지 변화가 없으면 timeout', async () => {
    const r = await watchHandoff({
      currentUrl: () => 'https://shop.example/login',
      stillBlocked: async () => true,
      sleep: fastSleep,
      pollMs: 10,
      timeoutMs: 30
    })
    expect(r.outcome).toBe('timeout')
  })

  it('페이지를 못 읽으면(오류) 계속 막힌 것으로 본다', async () => {
    const r = await watchHandoff({
      currentUrl: () => 'https://shop.example/login',
      stillBlocked: async () => {
        throw new Error('page is gone')
      },
      sleep: fastSleep,
      pollMs: 10,
      timeoutMs: 30
    })
    expect(r.outcome).toBe('timeout')
  })

  it('취소 신호가 오면 감시를 그만둔다', async () => {
    const r = await watchHandoff({
      currentUrl: () => 'https://shop.example/login',
      stillBlocked: async () => true,
      cancelled: () => true,
      sleep: fastSleep,
      pollMs: 1,
      timeoutMs: 100
    })
    expect(r.outcome).toBe('cancelled')
  })
})

describe('handoffToolResult — 모델이 읽는 문자열', () => {
  it('자동 재개는 바뀐 주소를 알려 준다', () => {
    expect(handoffToolResult({ outcome: 'resumed', url: 'https://a.example/home' })).toBe(
      'user completed the check; page changed to https://a.example/home'
    )
  })
  it('건너뛰기·중단·시간 초과', () => {
    expect(handoffToolResult({ outcome: 'skipped', url: 'u' })).toMatch(/skipped/)
    expect(handoffToolResult({ outcome: 'aborted', url: 'u' })).toBe('stopped by user')
    expect(handoffToolResult({ outcome: 'timeout', url: 'u' })).toMatch(/needs_user: captcha/)
  })
})

// 러너는 탭·설정을 쓰지 않는 경로(requestHandoff)만 검증하므로 최소 스텁으로 만든다
function makeRunner(): { runner: AgentRunner; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const tabs = { active: () => null } as unknown as TabManager
  const settings = { get: () => ({}) } as unknown as SettingsStore
  return { runner: new AgentRunner(tabs, settings, (e) => events.push(e)), events }
}

describe('AgentRunner.requestHandoff — 일시정지와 재개', () => {
  it('넘김 카드를 띄우고 사용자가 처리할 때까지 도구를 붙잡는다(자동 재개)', async () => {
    const { runner, events } = makeRunner()
    let url = 'https://shop.example/login'
    const pending = runner.requestHandoff({
      matched: '캡차',
      currentUrl: () => url,
      stillBlocked: async () => {
        url = 'https://shop.example/mypage'
        return true
      },
      watch: { sleep: fastSleep, pollMs: 1, timeoutMs: 100 }
    })
    // 카드 이벤트가 즉시 나가고, 결과는 아직 정해지지 않았다
    const card = events.find((e) => e.type === 'handoff')
    expect(card).toMatchObject({
      kind: 'captcha',
      matched: '캡차',
      url: 'https://shop.example/login'
    })
    const r = await pending
    expect(r).toEqual({ outcome: 'resumed', url: 'https://shop.example/mypage' })
    expect(events.at(-1)).toMatchObject({ type: 'handoffDone', outcome: 'resumed' })
  })

  it('kind 를 주면 카드 이벤트에 그대로 실린다(결제 키패드)', async () => {
    const { runner, events } = makeRunner()
    const pending = runner.requestHandoff({
      matched: '결제 비밀번호 키패드',
      kind: 'keypad',
      currentUrl: () => 'https://pay.example/keypad',
      stillBlocked: async () => false,
      watch: { sleep: fastSleep, pollMs: 1, timeoutMs: 100 }
    })
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ kind: 'keypad' })
    await pending
  })

  it("'건너뛰고 계속'(승인)은 skipped 로 끝난다", async () => {
    const { runner, events } = makeRunner()
    const pending = runner.requestHandoff({
      matched: 'captcha',
      currentUrl: () => 'https://shop.example/login',
      stillBlocked: async () => true,
      watch: { sleep: fastSleep, pollMs: 10, timeoutMs: 10_000 }
    })
    const card = events.find((e) => e.type === 'handoff')
    if (card?.type !== 'handoff') throw new Error('넘김 카드가 없다')
    runner.resolveConfirm(card.requestId, true)
    const r = await pending
    expect(r.outcome).toBe('skipped')
    expect(events.at(-1)).toMatchObject({ type: 'handoffDone', outcome: 'skipped' })
  })

  it("'작업 중단'(거부)은 aborted 로 끝난다", async () => {
    const { runner, events } = makeRunner()
    const pending = runner.requestHandoff({
      matched: 'captcha',
      currentUrl: () => 'https://shop.example/login',
      stillBlocked: async () => true,
      watch: { sleep: fastSleep, pollMs: 10, timeoutMs: 10_000 }
    })
    const card = events.find((e) => e.type === 'handoff')
    if (card?.type !== 'handoff') throw new Error('넘김 카드가 없다')
    runner.resolveConfirm(card.requestId, false)
    expect((await pending).outcome).toBe('aborted')
  })

  it('대기 시간이 끝나면 timeout 으로 풀려난다(무한 정지 방지)', async () => {
    const { runner } = makeRunner()
    const r = await runner.requestHandoff({
      matched: 'captcha',
      currentUrl: () => 'https://shop.example/login',
      stillBlocked: async () => true,
      watch: { sleep: fastSleep, pollMs: 10, timeoutMs: 30 }
    })
    expect(r.outcome).toBe('timeout')
  })
})
