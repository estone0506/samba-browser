import { describe, it, expect } from 'vitest'
import { serializeSnapshot, type PageSnapshot } from '@shared/snapshot'

const snap: PageSnapshot = {
  url: 'https://example.com',
  title: '예시',
  text: '본문 텍스트',
  elements: [
    {
      id: 1,
      tag: 'a',
      role: 'link',
      text: '로그인',
      href: '/login',
      isSecret: false
    },
    {
      id: 2,
      tag: 'input',
      role: 'textbox',
      text: '',
      name: 'q',
      inputType: 'text',
      isSecret: false
    },
    {
      id: 3,
      tag: 'input',
      role: 'textbox',
      text: '',
      name: 'pw',
      inputType: 'password',
      isSecret: true
    }
  ]
}

describe('serializeSnapshot', () => {
  it('URL·제목·요소를 번호와 함께 직렬화', () => {
    const out = serializeSnapshot(snap)
    expect(out).toContain('URL: https://example.com')
    expect(out).toContain('[1] link "로그인" href=/login')
    expect(out).toContain('[2] textbox name=q')
  })
  it('비밀 입력칸은 SECRET 표시', () => {
    expect(serializeSnapshot(snap)).toContain('[3] textbox name=pw (SECRET)')
  })
  it('본문은 16000자에서 자름', () => {
    const long = { ...snap, text: 'a'.repeat(17000) }
    expect(serializeSnapshot(long).length).toBeLessThan(17000)
    expect(serializeSnapshot(long)).toContain('a'.repeat(16000))
  })
})
