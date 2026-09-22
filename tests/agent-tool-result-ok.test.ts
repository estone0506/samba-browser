// 진행 로그의 ✓/✗ 판정 — 본문을 돌려주는 도구는 결과 앞머리만 본다

import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge: {} }))

const { isToolResultOk } = await import('../src/main/agent/tools')

describe('isToolResultOk', () => {
  it('행동 도구는 예전처럼 결과 어디든 실패 단어가 있으면 실패다', () => {
    expect(isToolResultOk('ok')).toBe(true)
    expect(isToolResultOk('element #12 not found')).toBe(false)
    expect(isToolResultOk('refused: read-only mode')).toBe(false)
  })

  it('본문 도구는 본문 속 단어로 실패 처리하지 않는다(실기: 플레이북 절차의 error·locked·fail)', () => {
    const playbook = JSON.stringify({
      id: 'p1',
      name: '포이즌 소싱 주문 처리',
      instructions: '금고가 locked 면 멈춘다. 결제 error·fail 은 보고한다. 계정 not found 면 보류'
    })
    expect(isToolResultOk(playbook, true)).toBe(true)
    expect(
      isToolResultOk('URL: https://shop.example\nPAGE TEXT\n로그인 실패 error 403', true)
    ).toBe(true)
  })

  it('본문 도구도 결과가 실패 표식으로 시작하면 실패다', () => {
    expect(isToolResultOk('refused: no playbook with that id', true)).toBe(false)
    expect(isToolResultOk('no active tab', true)).toBe(false)
    expect(isToolResultOk('no element matches "구매하기"', true)).toBe(false)
    expect(isToolResultOk('error: the page did not respond within 90s', true)).toBe(false)
  })

  it('run_js 는 log 출력 뒤 줄 머리의 Error: 도 실패로 본다', () => {
    expect(isToolResultOk('found 3 rows\nError: 행을 못 찾음\n    at <anonymous>', true)).toBe(
      false
    )
    expect(isToolResultOk('{"status":"error shown on page","rows":3}', true)).toBe(true)
  })
})

describe('payProviderOfUrl — 결제창 호스트로 결제 수단을 짐작한다', () => {
  it('토스·페이코·카카오·네이버 결제창을 알아본다', async () => {
    const { payProviderOfUrl } = await import('../src/main/agent/tools')
    expect(payProviderOfUrl('https://pay.toss.im/payfront/auth')).toBe('toss')
    expect(payProviderOfUrl('https://id.payco.com/login')).toBe('payco')
    expect(payProviderOfUrl('https://online-pay.kakaopay.com/pay')).toBe('kakao')
    expect(payProviderOfUrl('https://pay.naver.com/checkout')).toBe('naver')
  })

  it('결제창이 아니거나 주소가 깨졌으면 null', async () => {
    const { payProviderOfUrl } = await import('../src/main/agent/tools')
    expect(payProviderOfUrl('https://www.musinsa.com/order/order-form')).toBeNull()
    expect(payProviderOfUrl('https://nottoss.im.example.com/')).toBeNull()
    expect(payProviderOfUrl('not a url')).toBeNull()
  })
})
