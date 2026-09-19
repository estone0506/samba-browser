import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_PHONE_ELEMENTS,
  findElement,
  serializePhoneScreen,
  type PhoneElement,
  type PhoneScreen
} from '../src/shared/phone-snapshot'
import { parseUiXml } from '../src/main/phone/uitree'

const XML = readFileSync(join(__dirname, 'fixtures/uiautomator-toss.xml'), 'utf8')
const SCREEN = parseUiXml(XML, 'R3CRA05HY3R', 'viva.republica.toss')

function element(id: number, over: Partial<PhoneElement> = {}): PhoneElement {
  return {
    id,
    text: `항목${id}`,
    className: 'android.widget.TextView',
    clickable: false,
    bounds: { l: 0, t: id, r: 100, b: id + 1 },
    center: { x: 50, y: id },
    isSecret: false,
    ...over
  }
}

describe('serializePhoneScreen', () => {
  it('머리말에 폰·앱·화면 크기를 담는다', () => {
    const lines = serializePhoneScreen(SCREEN).split('\n')
    expect(lines[0]).toBe('PHONE: R3CRA05HY3R')
    expect(lines[1]).toBe('APP: viva.republica.toss')
    expect(lines[2]).toBe('SIZE: 720x1600')
    expect(lines[4]).toBe('ELEMENTS:')
  })

  it('요소 줄은 [번호] 클래스 "텍스트" 형식이다', () => {
    const lines = serializePhoneScreen(SCREEN).split('\n')
    expect(lines[5]).toBe('[1] TextView "송금하기" id=title (clickable)')
  })

  it('비밀 노드의 값은 어디에도 남지 않는다', () => {
    const text = serializePhoneScreen(SCREEN)
    // 픽스처의 password 칸 값(1234)이 직렬화 결과에 없어야 한다
    expect(text).not.toContain('1234')
    expect(text).toContain('(SECRET)')
  })

  it('상한을 넘는 요소는 잘라 낸다', () => {
    const many: PhoneScreen = {
      serial: 'S',
      width: 720,
      height: 1600,
      app: 'app',
      elements: Array.from({ length: MAX_PHONE_ELEMENTS + 5 }, (_, i) => element(i + 1))
    }
    const lines = serializePhoneScreen(many).split('\n')
    // 머리말 5줄 + 요소 120줄
    expect(lines).toHaveLength(5 + MAX_PHONE_ELEMENTS)
  })
})

describe('findElement', () => {
  it('번호로 요소를 찾고 없으면 null 이다', () => {
    expect(findElement(SCREEN, 1)?.text).toBe('송금하기')
    expect(findElement(SCREEN, 999)).toBeNull()
  })
})
