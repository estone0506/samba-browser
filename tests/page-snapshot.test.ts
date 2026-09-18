// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { buildSnapshot, performClick, performType, textOf } from '../src/preload/page-core'

beforeEach(() => {
  document.body.innerHTML = `
    <h1>제목</h1>
    <a href="/login" id="l">로그인</a>
    <input name="q" placeholder="검색">
    <input type="password" name="pw">
    <button>검색하기</button>
    <div style="display:none"><button>숨김</button></div>
  `
})

describe('buildSnapshot', () => {
  it('보이는 상호작용 요소만 번호 매김', () => {
    const s = buildSnapshot()
    const texts = s.elements.map((e) => e.text || e.name)
    expect(texts).toEqual(['로그인', 'q', 'pw', '검색하기'])
    expect(s.elements[0].id).toBe(1)
  })
  it('password는 isSecret', () => {
    const s = buildSnapshot()
    expect(s.elements.find((e) => e.name === 'pw')?.isSecret).toBe(true)
  })
})

describe('performClick / performType', () => {
  it('id로 클릭', () => {
    buildSnapshot()
    let clicked = false
    document.getElementById('l')!.addEventListener('click', (ev) => {
      ev.preventDefault()
      clicked = true
    })
    expect(performClick(1)).toBe('ok')
    expect(clicked).toBe(true)
  })
  it('비밀 입력칸 입력 거부', () => {
    buildSnapshot()
    expect(performType(3, 'x', false)).toMatch(/SECRET/)
  })
  it('일반 입력칸 입력', () => {
    buildSnapshot()
    expect(performType(2, '삼바웨이브', false)).toBe('ok')
    expect((document.querySelector('[name=q]') as HTMLInputElement).value).toBe('삼바웨이브')
  })
  it('없는 id는 오류', () => {
    buildSnapshot()
    expect(performClick(99)).toMatch(/not found/)
  })
})

describe('textOf', () => {
  it('등록된 요소의 실제 페이지 텍스트 반환', () => {
    buildSnapshot()
    expect(textOf(1)).toBe('로그인')
  })
  it('입력칸은 name·placeholder 를 함께 반환', () => {
    buildSnapshot()
    expect(textOf(2)).toBe('q 검색')
  })
  it('없는 id 는 빈 문자열', () => {
    buildSnapshot()
    expect(textOf(99)).toBe('')
  })
})
