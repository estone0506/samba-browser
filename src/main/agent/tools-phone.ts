// 폰 AI 도구 6종. 금고에 접근하지 않는다 — 비밀값은 pay-secret.ts 만 다룬다.
// 호출 상한(tick)·진행 로그(onStep)는 웹 도구와 같은 것을 공유한다.
//
// 안전 규칙(3단계 Global Constraints):
//  - 결제 비밀번호·PIN 은 phone_type 으로 넣지 않는다. 이 파일은 금고를 아예 볼 수 없다.
//  - 비밀 입력 화면의 캡처는 모델에게 넘기지 않는다(phone_screenshot 이 거부).
//  - 결과 문자열에는 화면 값이 아닌 상태만 담는다.

import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { PermissionMode } from '../../shared/settings'
import type { PhoneDto } from '../../shared/phone'
import { findElement, serializePhoneScreen, type PhoneScreen } from '../../shared/phone-snapshot'
import {
  PHONE_KEYS,
  isPhoneKey,
  pressKey,
  swipe as adbSwipe,
  tap as adbTap,
  typeText as adbTypeText,
  type PhoneKey
} from '../phone/input'
import { execOutArgs, type AdbRunner } from '../phone/adb'
import { dumpScreen } from '../phone/uitree'

const READ_ONLY_REFUSAL = 'refused: read-only mode'
const NOT_PRO = 'refused: phone requires Pro plan'
const NO_PHONE = 'no phone connected'
const NOT_FOUND = 'not found'
const SECRET_SCREEN = 'refused: secret screen'
const USER_DECLINED = 'refused: user declined'
// 좌표도 요소 번호도 없이 부른 경우
const TAP_TARGET_MISSING = 'refused: give elementId from phone_get_screen, or x and y'
// adb input text 가 보낼 수 없는 글자(한글·이모지)일 때
const UNSUPPORTED_TEXT = 'unsupported-text: use phone_tap on the keyboard'

// guard 모드에서 조작 전 확인을 받는 앱(간편결제·은행)
export const PAYMENT_PACKAGES = [
  'viva.republica.toss',
  'com.nhnent.payapp', // 페이코
  'com.kakao.talk',
  'com.nhn.android.search' // 네이버앱(네이버페이)
]

export const PHONE_TOOL_NAMES = [
  'phone_get_screen',
  'phone_tap',
  'phone_type',
  'phone_key',
  'phone_swipe',
  'phone_screenshot'
]

export interface Point {
  x: number
  y: number
}

/** 도구가 쓰는 폰 조작 능력. 구현은 배선부(handlers.ts)가 adb 로 채운다 */
export interface PhoneOps {
  list: () => PhoneDto[]
  screen: (serial: string) => Promise<PhoneScreen>
  tap: (serial: string, x: number, y: number) => Promise<void>
  swipe: (serial: string, from: Point, to: Point, ms?: number) => Promise<void>
  typeText: (serial: string, text: string) => Promise<'ok' | 'unsupported-text'>
  key: (serial: string, key: PhoneKey) => Promise<void>
  screenshot: (serial: string) => Promise<{ png: Buffer; secret: boolean }>
}

export interface PhoneToolContext {
  // 주의: vault 필드가 없다 — 폰 도구는 금고 값에 접근할 수 없다(테스트로 단언)
  phones: PhoneOps
  mode: PermissionMode
  isPro: () => boolean
  // 배정된 폰 serial. 없으면 연결된 첫 폰
  assigned: () => string | null
  confirm: (action: string, kind?: 'danger' | 'finish') => Promise<boolean>
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
}

// 스키마가 서로 다른 도구를 한 배열에 담기 위한 공통 타입(웹 도구 배열과 같은 취지).
// 기본 인자(AnyZodRawShape)라 스키마가 제각각인 도구를 모두 담는다
type PhoneTool = SdkMcpToolDefinition

type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; data: string; mimeType: string }

const text = (t: string): { content: TextBlock[] } => ({
  content: [{ type: 'text' as const, text: t }]
})

// 실패로 볼 결과 문자열(진행 로그의 ✓/✗ 판정). 웹 도구 guard 와 같은 규칙
const FAILED_RE = /not found|no phone|refused|denied|unsupported|error/i

// 도구 통과 결과 — 폰이 정해졌거나(ok), 거부 문구를 그대로 돌려줘야 하거나(message)
type Gate =
  | { ok: true; serial: string; screen: () => Promise<PhoneScreen> }
  // silent 는 호출 상한처럼 이미 별도 step 을 남긴 경우다(중복 기록 방지)
  | { ok: false; message: string; silent?: boolean }

const keyNames = Object.keys(PHONE_KEYS) as [PhoneKey, ...PhoneKey[]]

export function createPhoneTools(ctx: PhoneToolContext): PhoneTool[] {
  // 상한 도달 알림은 1회만 보낸다(웹 도구와 같은 규칙)
  let limitNotified = false

  /** 배정된 폰 → 없으면 연결(online)된 첫 폰 */
  const resolveSerial = (): string | null => {
    const assigned = ctx.assigned()
    if (assigned) return assigned
    return ctx.phones.list().find((p) => p.state === 'online')?.serial ?? null
  }

  /**
   * 모든 폰 도구가 지나는 관문.
   * 호출 상한 → Pro 요금제 → 권한 모드 → 폰 선택 → (guard) 결제 앱 확인 순으로 본다
   */
  const enter = async (write: boolean): Promise<Gate> => {
    const over = ctx.tick()
    if (over) {
      if (!limitNotified) {
        limitNotified = true
        ctx.onStep('도구 호출 상한 도달', false)
      }
      return { ok: false, message: over, silent: true }
    }
    if (!ctx.isPro()) return { ok: false, message: NOT_PRO }
    if (write && ctx.mode === 'read_only') return { ok: false, message: READ_ONLY_REFUSAL }
    const serial = resolveSerial()
    if (!serial) return { ok: false, message: NO_PHONE }

    // 화면은 한 호출 안에서 한 번만 뜬다(요소 탭 판정과 결제 앱 판정이 같은 화면을 본다)
    let cached: PhoneScreen | null = null
    const screen = async (): Promise<PhoneScreen> => {
      if (!cached) cached = await ctx.phones.screen(serial)
      return cached
    }

    // guard 모드에서 간편결제·은행 앱을 조작하기 전에는 사용자 확인 카드를 받는다.
    // 판정 근거는 모델이 준 값이 아니라 폰이 보고한 최상위 패키지명이다
    if (write && ctx.mode === 'guard') {
      const app = (await screen()).app
      if (PAYMENT_PACKAGES.includes(app)) {
        const ok = await ctx.confirm(`폰 조작: ${app}`, 'danger')
        if (!ok) return { ok: false, message: USER_DECLINED }
      }
    }
    return { ok: true, serial, screen }
  }

  /** 글자 결과를 돌려주는 도구 5종의 공통 실행부 */
  const act = async (
    label: string,
    write: boolean,
    fn: (serial: string, screen: () => Promise<PhoneScreen>) => Promise<string>
  ): Promise<{ content: TextBlock[] }> => {
    const gate = await enter(write)
    if (!gate.ok) {
      if (!gate.silent) ctx.onStep(label, false)
      return text(gate.message)
    }
    try {
      const out = await fn(gate.serial, gate.screen)
      ctx.onStep(label, !FAILED_RE.test(out))
      return text(out)
    } catch (e) {
      ctx.onStep(label, false)
      return text(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const getScreen = tool(
    'phone_get_screen',
    'Read the connected phone screen: current app package, screen size and numbered elements. Use those numbers with phone_tap. Password fields appear as (SECRET) with no value.',
    {},
    () =>
      act('폰 화면 읽기', false, async (_serial, screen) => serializePhoneScreen(await screen()))
  )

  const tap = tool(
    'phone_tap',
    'Tap the phone screen: pass elementId from phone_get_screen, or raw device coordinates x and y.',
    {
      elementId: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      label: z.string().optional().describe('element text, for logging')
    },
    ({ elementId, x, y, label }) =>
      act(
        `폰 탭: ${label ?? (elementId !== undefined ? `#${elementId}` : `${x},${y}`)}`,
        true,
        async (serial, screen) => {
          if (elementId !== undefined) {
            const el = findElement(await screen(), elementId)
            if (!el) return NOT_FOUND
            await ctx.phones.tap(serial, el.center.x, el.center.y)
            return 'ok'
          }
          if (x === undefined || y === undefined) return TAP_TARGET_MISSING
          await ctx.phones.tap(serial, x, y)
          return 'ok'
        }
      )
  )

  const typeTool = tool(
    'phone_type',
    'Type ASCII text into the focused phone field. Never use this for a payment password, PIN or any secret - the app fills those itself.',
    { text: z.string() },
    ({ text: value }) =>
      // 라벨에 입력값을 넣지 않는다 — 진행 로그는 화면에 그대로 보인다
      act('폰 입력', true, async (serial) => {
        const r = await ctx.phones.typeText(serial, value)
        return r === 'ok' ? 'ok' : UNSUPPORTED_TEXT
      })
  )

  const keyTool = tool(
    'phone_key',
    `Press a phone hardware key. One of: ${keyNames.join(', ')}.`,
    { key: z.enum(keyNames) },
    ({ key }) =>
      act(`폰 키: ${String(key)}`, true, async (serial) => {
        if (!isPhoneKey(key)) return `refused: unknown key, use one of ${keyNames.join(', ')}`
        await ctx.phones.key(serial, key)
        return 'ok'
      })
  )

  const swipe = tool(
    'phone_swipe',
    'Swipe on the phone between two device coordinates. Use it to scroll a list or open a drawer.',
    {
      from: z.object({ x: z.number(), y: z.number() }),
      to: z.object({ x: z.number(), y: z.number() }),
      ms: z.number().int().optional()
    },
    ({ from, to, ms }) =>
      act('폰 스와이프', true, async (serial) => {
        await ctx.phones.swipe(serial, from, to, ms)
        return 'ok'
      })
  )

  // 캡처는 이미지 블록을 돌려줘야 해서 act() 대신 같은 관문만 공유한다(웹 screenshot 과 같은 방식)
  const screenshot = tool(
    'phone_screenshot',
    'Screenshot the phone as an image. Use when phone_get_screen text is not enough (image captcha, keypad layout). Secret keypad screens are refused.',
    {},
    async (): Promise<{ content: (TextBlock | ImageBlock)[] }> => {
      const label = '폰 화면 캡처'
      const gate = await enter(false)
      if (!gate.ok) {
        if (!gate.silent) ctx.onStep(label, false)
        return text(gate.message)
      }
      try {
        const { png, secret } = await ctx.phones.screenshot(gate.serial)
        // 비밀번호·PIN 화면은 이미지를 아예 넘기지 않는다
        if (secret) {
          ctx.onStep(label, false)
          return text(SECRET_SCREEN)
        }
        ctx.onStep(label, true)
        return {
          content: [
            { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text' as const, text: `phone screenshot (${gate.serial})` }
          ]
        }
      } catch (e) {
        ctx.onStep(label, false)
        return text(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  // 스키마가 도구마다 달라 한 배열로 모으려면 좁히기가 필요하다(SDK 도 내부적으로 같은 처리를 한다).
  // any 를 쓰지 않으려고 unknown 을 거쳐 좁힌다 — 실행 시 모양은 그대로다
  return [getScreen, tap, typeTool, keyTool, swipe, screenshot] as unknown as PhoneTool[]
}

/**
 * adb 로 PhoneOps 를 채운다(배선부 전용).
 * 화면 프레임은 T4 스냅샷과 같은 `exec-out screencap -p` 경로를 쓴다.
 * 비밀 입력칸이 보이는 화면은 캡처 자체를 뜨지 않는다 — 버퍼로도 만들지 않는다
 */
export function createPhoneOps(adb: AdbRunner, list: () => PhoneDto[]): PhoneOps {
  return {
    list,
    screen: (serial) => dumpScreen(adb, serial),
    tap: (serial, x, y) => adbTap(adb, serial, x, y),
    swipe: (serial, from, to, ms) => adbSwipe(adb, serial, from, to, ms),
    typeText: (serial, value) => adbTypeText(adb, serial, value),
    key: (serial, key) => pressKey(adb, serial, key),
    screenshot: async (serial) => {
      const screen = await dumpScreen(adb, serial)
      const secret = screen.elements.some((e) => e.isSecret)
      if (secret) return { png: Buffer.alloc(0), secret: true }
      return { png: await adb.runBinary(execOutArgs(serial, ['screencap', '-p'])), secret: false }
    }
  }
}
