import { describe, it, expect } from 'vitest'
import { payPriorityOf, withPayPriority, visibleTags } from '../src/shared/vault'

describe('결제 우선순위(예약 태그)', () => {
  it('태그에서 순위를 읽고, 바꾸고, 지운다', () => {
    expect(payPriorityOf(['쇼핑'])).toBeNull()
    const tags = withPayPriority(['쇼핑'], 2)
    expect(tags).toEqual(['쇼핑', '결제순위:2'])
    expect(payPriorityOf(tags)).toBe(2)
    expect(withPayPriority(tags, 1)).toEqual(['쇼핑', '결제순위:1'])
    expect(withPayPriority(tags, null)).toEqual(['쇼핑'])
  })

  it('화면 태그 목록에서는 예약 태그를 숨긴다', () => {
    expect(visibleTags(['쇼핑', '결제순위:1', '해외'])).toEqual(['쇼핑', '해외'])
  })

  it('잘못된 값은 순위로 보지 않는다', () => {
    expect(payPriorityOf(['결제순위:0', '결제순위:abc'])).toBeNull()
  })
})
