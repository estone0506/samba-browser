// 애드픽 적립 링크 — 프로필 세션으로 받고, 추적 링크가 없으면 ok:false

import { describe, it, expect, vi } from 'vitest'
import type { Session } from 'electron'
import { adpickTrackingLink, parseAdpickResponse } from '../src/main/agent/affiliate'

const OK = {
  status: 1,
  trackinglink: 'https://deg.kr/2c1b0fd/1790405314568?podgateopenweb',
  slink: 'https://bitl.bz/Gx7cyB',
  percent: '1.6%',
  product_code: '1000873691109'
}

describe('parseAdpickResponse', () => {
  it('status 1 + https 추적 링크면 ok', () => {
    expect(parseAdpickResponse(OK)).toMatchObject({ ok: true, trackinglink: OK.trackinglink, percent: '1.6%' })
  })

  it('추적 링크가 없거나 status 가 1 이 아니면 ok:false(로그인 안 됨·제휴몰 아님)', () => {
    expect(parseAdpickResponse({ status: 0, malllist: [] }).ok).toBe(false)
    expect(parseAdpickResponse({ ...OK, trackinglink: 'javascript:x' }).ok).toBe(false)
    expect(parseAdpickResponse(null).ok).toBe(false)
  })
})

describe('adpickTrackingLink', () => {
  it('그 프로필 세션으로 상품 주소를 실어 부른다', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => OK }))
    const ses = { fetch } as unknown as Session
    const out = await adpickTrackingLink(ses, 'https://www.ssg.com/item/itemView.ssg?itemId=1')
    expect(out.ok).toBe(true)
    const url = String((fetch.mock.calls[0] as unknown[])[0])
    expect(url).toContain('shopping_addlink.php')
    expect(url).toContain(encodeURIComponent('https://www.ssg.com/item/itemView.ssg?itemId=1'))
  })

  it('https 가 아닌 주소는 부르지 않는다', async () => {
    const fetch = vi.fn()
    const out = await adpickTrackingLink({ fetch } as unknown as Session, 'file:///x')
    expect(out.ok).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('요청 실패는 던지지 않고 사유를 돌려준다', async () => {
    const ses = { fetch: vi.fn(async () => { throw new Error('net') }) } as unknown as Session
    const out = await adpickTrackingLink(ses, 'https://www.ssg.com/x')
    expect(out.ok).toBe(false)
    expect(out.note).toContain('net')
  })
})
