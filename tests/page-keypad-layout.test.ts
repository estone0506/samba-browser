// @vitest-environment jsdom
// preload 의 결제 키패드 배치 읽기 — 0~9 가 정확히 한 번씩 보일 때만 배치를 돌려준다

import { describe, it, expect, beforeEach } from 'vitest'
import { keypadLayout, performClick, resetElementIds } from '../src/preload/page-core'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function keypadHtml(
  digits: string[] = DIGITS,
  wrap: (d: string) => string = (d) => `<button>${d}</button>`
): string {
  return `<div class="kpd">${digits.map(wrap).join('')}</div>`
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetElementIds()
})

describe('keypadLayout', () => {
  it('button 열 자리 숫자를 배치로 돌려주고, 그 id 로 바로 누를 수 있다', () => {
    document.body.innerHTML = keypadHtml()
    const layout = keypadLayout()
    expect(layout).not.toBeNull()
    expect(layout!.digits.map((d) => d.digit)).toEqual(DIGITS)
    // 스냅샷을 찍지 않았어도 id 가 매겨져 registry 에 들어간다
    const five = layout!.digits.find((d) => d.digit === '5')!
    let clicked = ''
    document.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        clicked = b.textContent ?? ''
      })
    })
    performClick(five.id)
    expect(clicked).toBe('5')
  })

  it('div·span·td 로 그린 키패드도 읽는다(NICE·페이코 보안 키패드)', () => {
    document.body.innerHTML = `<table><tr>${DIGITS.map((d) => `<td>${d}</td>`).join('')}</tr></table>`
    expect(keypadLayout()?.digits.length).toBe(10)
    document.body.innerHTML = keypadHtml(DIGITS, (d) => `<div class="key">${d}</div>`)
    expect(keypadLayout()?.digits.length).toBe(10)
  })

  it('<a><span>5</span></a> 처럼 겹친 표기는 안쪽 하나만 세어 중복으로 보지 않는다', () => {
    document.body.innerHTML = keypadHtml(DIGITS, (d) => `<a href="#"><span>${d}</span></a>`)
    const layout = keypadLayout()
    expect(layout?.digits.length).toBe(10)
  })

  it('글자 없이 aria-label 에만 숫자가 있는 키패드도 읽는다(NICE nFilter 실기 구조)', () => {
    // 숫자는 배경 스프라이트, 접근성 이름만 "1".."0". 명령 키와 빈 칸(이름 없음)이 섞여 있다
    const keys = ['1', '2', '3', '', '4', '5', '6', '7', '8', '9', '', '0']
      .map((d) =>
        d === ''
          ? '<button class="nfilter_keypad_button kpd"></button>'
          : `<button class="nfilter_keypad_button kpd" aria-label="${d}"></button>`
      )
      .join('')
    document.body.innerHTML =
      `<div id="ownKeypad">${keys}` +
      '<button id="nfilter_renew" aria-label="재배열"></button>' +
      '<button id="nfilter_enter" aria-label="입력완료"></button></div>' +
      // 숨겨진 다른 자판(display:none)에 같은 숫자가 있어도 세지 않는다
      '<div class="kpdGrp lower" style="display:none"><button aria-label="1"></button></div>' +
      '<input type="tel" maxlength="6" value="">'
    const layout = keypadLayout()
    expect(layout?.digits.map((d) => d.digit)).toEqual(DIGITS)
    // 비밀 입력칸이 없어도 PIN 길이의 숫자칸으로 자리수를 센다
    expect(layout?.filled).toBe(0)
  })

  it('alt·title 에 숫자가 있는 이미지 키도 읽는다', () => {
    document.body.innerHTML = DIGITS.map((d, i) =>
      i % 2 === 0 ? `<a href="#"><img alt="${d}"></a>` : `<button title="${d}"></button>`
    ).join('')
    expect(keypadLayout()?.digits.length).toBe(10)
  })

  it('숫자가 하나라도 빠지면 null', () => {
    document.body.innerHTML = keypadHtml(DIGITS.filter((d) => d !== '7'))
    expect(keypadLayout()).toBeNull()
  })

  it('같은 숫자가 두 곳에 보이면 null(어느 쪽인지 확정할 수 없다)', () => {
    document.body.innerHTML = keypadHtml() + '<button>3</button>'
    expect(keypadLayout()).toBeNull()
  })

  it('숨겨진 버튼은 세지 않는다', () => {
    document.body.innerHTML = keypadHtml() + '<button style="display:none">3</button>'
    expect(keypadLayout()?.digits.length).toBe(10)
    document.body.innerHTML = `<div style="display:none">${keypadHtml()}</div>`
    expect(keypadLayout()).toBeNull()
  })

  it('filled 는 결제 비밀번호 칸의 길이만 준다(값은 읽지 않는다)', () => {
    document.body.innerHTML =
      keypadHtml() + '<input type="password" maxlength="6" inputmode="numeric" value="14">'
    const layout = keypadLayout()
    expect(layout?.filled).toBe(2)
    expect(JSON.stringify(layout)).not.toContain('14')
  })

  it('비밀 입력칸이 없으면 filled 는 null', () => {
    document.body.innerHTML = keypadHtml()
    expect(keypadLayout()?.filled).toBeNull()
  })

  it('키패드가 아닌 화면(장바구니 수량 등)에서는 null', () => {
    document.body.innerHTML = '<button>1</button><button>2</button><span>3</span>'
    expect(keypadLayout()).toBeNull()
  })
})

describe('pressOnce — 키패드 단발 누름', () => {
  it('화면 변화가 없어도 정확히 한 번만 누른다(일반 click 의 재시도 폴백 없음)', async () => {
    const { pressOnce } = await import('../src/preload/page-core')
    document.body.innerHTML = keypadHtml()
    const layout = keypadLayout()!
    const five = layout.digits.find((d) => d.digit === '5')!
    let presses = 0
    document.querySelectorAll('button').forEach((b) => {
      if ((b.textContent ?? '') === '5') b.addEventListener('click', () => (presses += 1))
    })
    expect(pressOnce(five.id)).toBe('ok')
    expect(presses).toBe(1)
  })

  it('없는 id 는 누르지 않고 알린다', async () => {
    const { pressOnce } = await import('../src/preload/page-core')
    expect(pressOnce(9999)).toMatch(/not found|gone/)
  })
})
