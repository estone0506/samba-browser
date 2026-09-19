// 폰 입력 전달. 1순위는 `adb shell input` 이다(단순·안정).
// input text 는 ASCII 만 안전하므로 그 외 문자는 거부하고 호출부가 요소 탭으로 우회한다

import { shellArgs, type AdbRunner } from './adb'

export const PHONE_KEYS = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  power: 'KEYCODE_POWER',
  recent: 'KEYCODE_APP_SWITCH',
  delete: 'KEYCODE_DEL'
} as const
export type PhoneKey = keyof typeof PHONE_KEYS

// 눈에 보이는 ASCII 만 통과시킨다(한글·이모지는 input text 가 깨뜨린다)
const ASCII_ONLY_RE = /^[\x20-\x7e]*$/

export function isPhoneKey(v: unknown): v is PhoneKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PHONE_KEYS, v)
}

/** 화면에 그린 폰 뷰 좌표 → 실제 폰 픽셀 좌표 */
export function toDeviceCoord(
  point: { x: number; y: number },
  view: { width: number; height: number },
  device: { width: number; height: number }
): { x: number; y: number } {
  if (view.width <= 0 || view.height <= 0) return { x: 0, y: 0 }
  const x = Math.round((point.x / view.width) * device.width)
  const y = Math.round((point.y / view.height) * device.height)
  return {
    x: Math.max(0, Math.min(device.width - 1, x)),
    y: Math.max(0, Math.min(device.height - 1, y))
  }
}

export async function tap(adb: AdbRunner, serial: string, x: number, y: number): Promise<void> {
  await adb.run(shellArgs(serial, ['input', 'tap', String(Math.round(x)), String(Math.round(y))]))
}

export async function swipe(
  adb: AdbRunner,
  serial: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  ms = 300
): Promise<void> {
  await adb.run(
    shellArgs(serial, [
      'input',
      'swipe',
      String(Math.round(from.x)),
      String(Math.round(from.y)),
      String(Math.round(to.x)),
      String(Math.round(to.y)),
      String(ms)
    ])
  )
}

/** ASCII 만 보낸다. 한글 등은 'unsupported-text' 를 돌려주고 호출부가 다른 길을 택한다 */
export async function typeText(
  adb: AdbRunner,
  serial: string,
  text: string
): Promise<'ok' | 'unsupported-text'> {
  if (!ASCII_ONLY_RE.test(text)) return 'unsupported-text'
  const escaped = text.replace(/ /g, '%s').replace(/'/g, "\\'")
  await adb.run(shellArgs(serial, ['input', 'text', escaped]))
  return 'ok'
}

export async function pressKey(adb: AdbRunner, serial: string, key: PhoneKey): Promise<void> {
  if (!isPhoneKey(key)) throw new Error(`unknown key: ${String(key)}`)
  await adb.run(shellArgs(serial, ['input', 'keyevent', PHONE_KEYS[key]]))
}
