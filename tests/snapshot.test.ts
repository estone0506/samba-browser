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

describe('입력칸 현재 값', () => {
  it('입력·선택칸의 value 를 나열에 싣고, 비밀 입력칸은 값을 싣지 않는다', () => {
    const s: PageSnapshot = {
      url: 'https://samba-wave.vercel.app/samba/orders',
      title: '주문',
      text: '',
      elements: [
        { id: 1, tag: 'input', role: 'textbox', text: '실구매가', isSecret: false, value: '29000' },
        {
          id: 2,
          tag: 'select',
          role: 'combobox',
          text: '주문계정',
          isSecret: false,
          value: 'mjkim88'
        },
        {
          id: 3,
          tag: 'input',
          role: 'textbox',
          text: '비밀번호',
          inputType: 'password',
          isSecret: true,
          value: 'x'
        }
      ]
    }
    const out = serializeSnapshot(s)
    expect(out).toContain('value="29000"')
    expect(out).toContain('value="mjkim88"')
    expect(out).toContain('(SECRET)')
    expect(out).not.toContain('value="x"')
  })
})
