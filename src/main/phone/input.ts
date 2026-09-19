// 폰 입력 전달. 1순위는 `adb shell input` 이다(단순·안정).
// `adb shell` 은 받은 문자열을 폰의 sh 가 해석하므로, 보낼 수 있는 글자를
// 화이트리스트로 못 박는다. 목록 밖 글자(한글·이모지·셸 메타문자)는 거부하고
// 호출부가 요소 탭(가상 키보드)으로 우회한다

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

/**
 * `input text` 로 보낼 수 있는 글자. 셸 메타문자(`; & | $ \` ( ) > < ' " * ? ~ # !`)와
 * 한글·이모지는 목록에 없다 — 인용부호로 막는 대신 애초에 통과시키지 않는다
 */
export const SAFE_TEXT_RE = /^[A-Za-z0-9 _.@%+\-=:,/]*$/

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

/**
 * 화이트리스트에 든 글자만 보낸다.
 * 한글·이모지·셸 메타문자가 하나라도 있으면 'unsupported-text' 를 돌려주고
 * 호출부가 다른 길(요소 탭)을 택한다
 */
export async function typeText(
  adb: AdbRunner,
  serial: string,
  text: string
): Promise<'ok' | 'unsupported-text'> {
  if (!SAFE_TEXT_RE.test(text)) return 'unsupported-text'
  // `input text` 에서 '%' 는 탈출 문자다. 먼저 '%%' 로 이중화해야
  // 사용자가 친 "%s" 가 공백으로 둔갑하지 않는다. 그 다음에 공백을 %s 로 바꾼다
  const escaped = text.replace(/%/g, '%%').replace(/ /g, '%s')
  await adb.run(shellArgs(serial, ['input', 'text', escaped]))
  return 'ok'
}

export async function pressKey(adb: AdbRunner, serial: string, key: PhoneKey): Promise<void> {
  if (!isPhoneKey(key)) throw new Error(`unknown key: ${String(key)}`)
  await adb.run(shellArgs(serial, ['input', 'keyevent', PHONE_KEYS[key]]))
}
