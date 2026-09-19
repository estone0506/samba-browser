// 번역 진행률 DTO — 격리 월드가 보고한 값을 화면용으로 좁히는 순수 규칙

import { describe, it, expect } from 'vitest'
import { toTranslateProgress, translateFailReason } from '../src/shared/translate'

describe('실패 사유 좁히기', () => {
  it('AI 연결 문제는 needsAi 로 모은다', () => {
    expect(translateFailReason('translate:needs-ai')).toBe('needsAi')
    expect(translateFailReason('auth:not_connected')).toBe('needsAi')
  })

  it('시간 초과·중단은 timeout 이다', () => {
    expect(translateFailReason('AbortError: The operation was aborted')).toBe('timeout')
    expect(translateFailReason('request timeout')).toBe('timeout')
  })

  it('글자를 못 찾은 경우는 noText 다', () => {
    expect(translateFailReason('translate:no-text')).toBe('noText')
  })

  it('모르는 문구는 전부 failed 로 떨어진다(페이지 문구가 그대로 새지 않는다)', () => {
    expect(translateFailReason('<script>alert(1)</script> 비밀번호 1234')).toBe('failed')
    expect(translateFailReason('')).toBe('failed')
  })
})

describe('진행률 DTO', () => {
  it('진행 중이면 running, 아니면 done 이다', () => {
    expect(toTranslateProgress('page', { running: true, done: 12, total: 398 })).toEqual({
      kind: 'page',
      phase: 'running',
      done: 12,
      total: 398
    })
    expect(toTranslateProgress('page', { running: false, done: 398, total: 398 }).phase).toBe('done')
  })

  it('오류가 있으면 phase 는 error 이고 사유 코드가 붙는다', () => {
    expect(
      toTranslateProgress('image', { running: false, done: 0, total: 0, error: 'translate:needs-ai' })
    ).toEqual({ kind: 'image', phase: 'error', done: 0, total: 0, reason: 'needsAi' })
  })

  it('망가진 숫자는 0 으로 보고, 총계는 완료 수보다 작아지지 않는다', () => {
    expect(toTranslateProgress('page', { done: -5, total: Number.NaN })).toMatchObject({
      done: 0,
      total: 0
    })
    expect(toTranslateProgress('page', { done: 10, total: 3 })).toMatchObject({
      done: 10,
      total: 10
    })
  })

  it('숫자가 아닌 값이 와도 던지지 않는다(격리 월드에서 온 값은 믿지 않는다)', () => {
    expect(toTranslateProgress('page', { done: '99', total: {}, running: 'yes' })).toEqual({
      kind: 'page',
      phase: 'done',
      done: 0,
      total: 0
    })
  })
})
