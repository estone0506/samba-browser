import { describe, it, expect } from 'vitest'
import {
  PHONE_KEYS,
  isPhoneKey,
  pressKey,
  swipe,
  tap,
  toDeviceCoord,
  typeText,
  type PhoneKey
} from '../src/main/phone/input'
import { FakeAdb } from './stubs/fake-adb'

const VIEW = { width: 320, height: 711 }
const DEVICE = { width: 720, height: 1600 }
const SERIAL = 'R3CRA05HY3R'

describe('toDeviceCoord', () => {
  it('뷰 좌표를 폰 해상도로 비례 환산한다', () => {
    expect(toDeviceCoord({ x: 160, y: 355 }, VIEW, DEVICE)).toEqual({ x: 360, y: 799 })
    expect(toDeviceCoord({ x: 0, y: 0 }, VIEW, DEVICE)).toEqual({ x: 0, y: 0 })
  })

  it('화면 밖 값은 경계로 잘라 낸다', () => {
    expect(toDeviceCoord({ x: 999, y: 999 }, VIEW, DEVICE)).toEqual({ x: 719, y: 1599 })
    expect(toDeviceCoord({ x: -50, y: -50 }, VIEW, DEVICE)).toEqual({ x: 0, y: 0 })
  })

  it('뷰 크기를 아직 모르면 원점을 돌려준다(0 나누기 방지)', () => {
    expect(toDeviceCoord({ x: 10, y: 10 }, { width: 0, height: 0 }, DEVICE)).toEqual({ x: 0, y: 0 })
  })
})

describe('입력 전달', () => {
  it('tap 은 input tap 을 부른다', async () => {
    const adb = new FakeAdb()
    await tap(adb, SERIAL, 360, 800)
    expect(adb.calls[0]).toEqual(['-s', SERIAL, 'shell', 'input', 'tap', '360', '800'])
  })

  it('swipe 는 지속 시간을 마지막 인자로 붙인다', async () => {
    const adb = new FakeAdb()
    await swipe(adb, SERIAL, { x: 100, y: 1200 }, { x: 100, y: 300 }, 450)
    expect(adb.calls[0]).toEqual([
      '-s',
      SERIAL,
      'shell',
      'input',
      'swipe',
      '100',
      '1200',
      '100',
      '300',
      '450'
    ])
  })

  it('typeText 는 공백을 %s 로 바꾸고 작은따옴표를 이스케이프한다', async () => {
    const adb = new FakeAdb()
    expect(await typeText(adb, SERIAL, "it's a b")).toBe('ok')
    expect(adb.calls[0]).toEqual(['-s', SERIAL, 'shell', 'input', 'text', "it\\'s%sa%sb"])
  })

  it('한글·이모지가 섞이면 보내지 않고 unsupported-text 를 돌려준다', async () => {
    const adb = new FakeAdb()
    expect(await typeText(adb, SERIAL, '안녕하세요')).toBe('unsupported-text')
    expect(await typeText(adb, SERIAL, 'ok 🙂')).toBe('unsupported-text')
    expect(adb.calls).toHaveLength(0)
  })

  it('pressKey 는 키 이름을 KEYCODE 로 바꾼다', async () => {
    const adb = new FakeAdb()
    await pressKey(adb, SERIAL, 'back')
    expect(adb.calls[0]).toEqual(['-s', SERIAL, 'shell', 'input', 'keyevent', 'KEYCODE_BACK'])
    expect(PHONE_KEYS.recent).toBe('KEYCODE_APP_SWITCH')
  })

  it('알 수 없는 키는 던진다', async () => {
    const adb = new FakeAdb()
    await expect(pressKey(adb, SERIAL, 'selfDestruct' as PhoneKey)).rejects.toThrow('unknown key')
    expect(isPhoneKey('toString')).toBe(false)
    expect(isPhoneKey('home')).toBe(true)
  })
})
