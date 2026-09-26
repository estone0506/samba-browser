// fill_secret format — 저장된 전화번호를 입력칸 모양에 맞춘다

import { describe, it, expect } from 'vitest'
import { formatFillValue } from '../src/main/agent/tools'

describe('formatFillValue 전화번호', () => {
  it('앞·가운데·끝으로 나눈다', () => {
    expect(formatFillValue('010-1234-5678', 'phone-first')).toBe('010')
    expect(formatFillValue('010-1234-5678', 'phone-mid')).toBe('1234')
    expect(formatFillValue('010-1234-5678', 'phone-last')).toBe('5678')
  })

  it('phone-rest 는 앞자리를 뺀 나머지 전부(010 을 고르는 칸 + 8자리 한 칸 폼)', () => {
    expect(formatFillValue('010-1234-5678', 'phone-rest')).toBe('12345678')
    expect(formatFillValue('02-123-4567', 'phone-rest')).toBe('1234567')
  })

  it('번호가 아니면 null', () => {
    expect(formatFillValue('1234', 'phone-rest')).toBeNull()
  })
})
