import type { WebContents, WebFrameMain } from 'electron'
import { z } from 'zod'
import type { KeypadSignals, PageElement, PageOverlay, PageSnapshot } from '../../shared/snapshot'
import { findCodeField as pickCodeField } from '../phone/auth-flow'
import type { AgentOp } from '../../shared/agent-op'
import { callFrameOp } from './frame-channel'
import {
  decodeFrameId,
  encodeFrameId,
  mergeFrameSnapshots,
  MAX_AGENT_FRAMES,
  type FrameSnapshot
} from './frame-id'
import type { Tab } from './tab-manager'

// preload 가 실행되는 격리 월드 id. Electron 의 WorldId.ISOLATED_WORLD = 999
export const ISOLATED_WORLD_ID = 999

// 페이지에서 돌아온 값은 전부 신뢰하지 않는다. AI 에 넘기기 전에 스키마로 검증한다
const elementSchema = z.object({
  id: z.number().int(),
  tag: z.string(),
  role: z.string(),
  text: z.string(),
  name: z.string().optional(),
  href: z.string().optional(),
  inputType: z.string().optional(),
  isSecret: z.boolean()
})

const snapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  elements: z.array(elementSchema),
  total: z.number().int().optional(),
  selectorError: z.string().optional()
})

// 결제 비밀번호 키패드 판정용 신호. 값은 담기지 않는다(개수·존재 여부만)
const keypadSignalsSchema = z.object({
  url: z.string(),
  text: z.string(),
  digitButtons: z.number().int(),
  pinField: z.boolean()
})

// 화면을 덮는 레이어 목록. label 은 페이지에서 온 문자열이라 길이를 잘라 쓴다
const overlaySchema = z.object({
  id: z.number().int(),
  label: z.string(),
  closeIds: z.array(z.number().int()),
  sensitive: z.boolean()
})
const overlayListSchema = z.array(overlaySchema)

/** 한 번에 모델에게 알릴 레이어 개수(프레임까지 합친 뒤) */
export const MAX_OVERLAYS = 5
/** 레이어 이름 길이 상한(페이지가 준 문자열이다) */
const OVERLAY_LABEL_MAX = 60

// 행동 도구(click/type/select/scroll/textOf)는 결과가 항상 문자열이어야 한다
const resultSchema = z.string()

// isSecretField 결과는 boolean
const boolSchema = z.boolean()

// findLoginFields 결과 — 못 찾은 필드는 없음(undefined).
// stage 는 2단계 로그인(아이디 화면 → 비밀번호 화면) 흐름을 호출부가 구분하기 위한 값
const loginFieldsSchema = z.object({
  username: z.number().int().optional(),
  password: z.number().int().optional(),
  submit: z.number().int().optional(),
  stage: z.enum(['single', 'username-only', 'password-only', 'none']),
  confidence: z.number(),
  iframe: z.boolean()
})

export type LoginFieldsResult = z.infer<typeof loginFieldsSchema>

// 로그인 상태 힌트 — matched 는 페이지에서 온 문자열이라 길이를 잘라 쓴다
const signedInHintSchema = z.object({ signedIn: z.boolean(), matched: z.string() })

// 캡차·2FA 징후. 푸는 것은 사용자 몫이고, 여기서는 "사람이 필요하다"만 판정한다
const captchaHintSchema = z.object({ needsUser: z.boolean(), matched: z.string() })

export type SignedInHintResult = z.infer<typeof signedInHintSchema>
export type CaptchaHintResult = z.infer<typeof captchaHintSchema>

// --- 프레임 ---------------------------------------------------------------
//
// 주소 검색(카카오 우편번호)·결제 보안 키패드는 iframe 안에 있다. preload 는 모든
// 프레임에서 돌며 프레임마다 자기 __samba 를 만든다.
//
// 메인 프레임은 webContents.executeJavaScriptInIsolatedWorld 로 바로 부르고,
// 하위 프레임은 그런 API 가 없어 frame-channel 의 IPC 통로로 동작 이름만 보내 시킨다.
//
// 프레임 번호는 framesInSubtree 순서(문서 트리 순서)를 그대로 쓴다. 한 작업 동안
// 프레임 구성이 바뀌지 않는 한 안정적이고, 바뀌면 다음 get_page 가 새 번호를 준다

/** AI 가 들여다볼 프레임인가. about:blank·빈 프레임·확장 프로그램 프레임은 뺀다 */
export function isAgentFrameUrl(url: string): boolean {
  if (!url || url === 'about:blank') return false
  return /^https?:\/\//i.test(url)
}

function frameUrl(frame: WebFrameMain): string {
  try {
    return frame.url ?? ''
  } catch {
    return ''
  }
}

/** 프레임 주소의 호스트(구분 헤더용). 못 읽으면 빈 문자열 */
export function frameHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * AI 가 다룰 하위 프레임 목록(메인 프레임은 빼고 상한까지).
 * framesInSubtree 를 갖추지 않은 대역(테스트 스텁)에서는 빈 목록이다
 */
export function agentSubFrames(wc: WebContents): WebFrameMain[] {
  try {
    const main: WebFrameMain | undefined = wc.mainFrame
    const all = main?.framesInSubtree
    if (!main || !Array.isArray(all)) return []
    return all.filter((f) => f !== main && isAgentFrameUrl(frameUrl(f))).slice(0, MAX_AGENT_FRAMES)
  } catch {
    return []
  }
}

// 결과 검증. 페이지에서 돌아온 값은 전부 신뢰하지 않는다
function verify<T>(raw: unknown, expr: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`unexpected page result for ${expr}`)
  return parsed.data
}

// 탭 안 preload(격리 월드의 __samba)를 호출하고 결과를 스키마로 검증한다(메인 프레임)
async function call<T>(wc: WebContents, expr: string, schema: z.ZodType<T>): Promise<T> {
  if (wc.isDestroyed()) throw new Error('page is gone')
  // webContents.executeJavaScriptInIsolatedWorld 는 메인 프레임의 지정 월드에서 실행한다
  const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
    { code: expr }
  ])
  return verify(raw, expr, schema)
}

// 특정 프레임에서 동작 하나를 시킨다(IPC 통로). 실패는 그대로 던진다
async function callFrame<T>(frame: WebFrameMain, op: AgentOp, schema: z.ZodType<T>): Promise<T> {
  return verify(await callFrameOp(frame, op), op.op, schema)
}

/**
 * id 가 가리키는 프레임에서 동작을 시킨다. opOf 는 그 프레임 안에서의 지역 id 를 받아
 * 동작을 만든다. 프레임이 사라졌으면 오류를 던진다(도구가 문구로 감싼다)
 */
async function callById<T>(
  tab: Tab,
  id: number,
  opOf: (localId: number) => AgentOp,
  schema: z.ZodType<T>
): Promise<T> {
  const wc = tab.view.webContents
  const { frameIndex, id: localId } = decodeFrameId(id)
  const op = opOf(localId)
  if (frameIndex === 0) return call(wc, opToCode(op), schema)
  if (wc.isDestroyed()) throw new Error('page is gone')
  const frame = agentSubFrames(wc)[frameIndex - 1]
  if (!frame) throw new Error(`frame ${frameIndex} is gone`)
  return callFrame(frame, op, schema)
}

/** 메인 프레임 + 살아 있는 하위 프레임에서 같은 동작을 돌린다. 실패한 프레임은 건너뛴다 */
async function callEveryFrame<T>(
  tab: Tab,
  op: AgentOp,
  schema: z.ZodType<T>
): Promise<{ main: T; frames: { index: number; host: string; value: T }[] }> {
  const wc = tab.view.webContents
  const main = await call(wc, opToCode(op), schema)
  const frames: { index: number; host: string; value: T }[] = []
  const subs = agentSubFrames(wc)
  for (let i = 0; i < subs.length; i += 1) {
    try {
      frames.push({
        index: i + 1,
        host: frameHost(frameUrl(subs[i])),
        value: await callFrame(subs[i], op, schema)
      })
    } catch {
      // preload 가 아직 안 붙었거나 프레임이 사라지면 실패한다 —
      // 그 프레임만 생략하고 나머지는 그대로 쓴다
      continue
    }
  }
  return { main, frames }
}

// 값이 code 문자열 안에 들어간다. JSON.stringify 가 이스케이프하지 않는
// U+2028/U+2029(줄 구분자)는 미리 걷어내 code 가 깨지지 않게 한다
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)]

function encodeQuery(query: string): string {
  const clean = Array.from(query)
    .filter((ch) => !LINE_SEPARATORS.includes(ch))
    .join('')
  return JSON.stringify(clean)
}

// 비밀값이 섞일 수 있는 문자열. U+2028/2029 를 직접 이스케이프해 둔다
function encodeValue(value: string): string {
  return JSON.stringify(value)
    .split(LINE_SEPARATORS[0])
    .join('\\u2028')
    .split(LINE_SEPARATORS[1])
    .join('\\u2029')
}

/** 메인 프레임용 — 동작을 격리 월드에서 실행할 __samba 호출식으로 바꾼다 */
function opToCode(op: AgentOp): string {
  switch (op.op) {
    case 'snapshot': {
      // selector 만 주는 경우도 있어 query 자리는 undefined 로 채운다
      const args =
        op.selector === undefined
          ? op.query === undefined
            ? ''
            : encodeQuery(op.query)
          : `${op.query === undefined ? 'undefined' : encodeQuery(op.query)}, ${encodeQuery(op.selector)}`
      return `__samba.snapshot(${args})`
    }
    case 'textOf':
      return `__samba.textOf(${op.id})`
    case 'click':
      return `__samba.click(${op.id})`
    case 'type':
      return `__samba.type(${op.id}, ${encodeValue(op.text)}, ${op.submit})`
    case 'select':
      return `__samba.select(${op.id}, ${encodeValue(op.value)})`
    case 'scroll':
      return `__samba.scroll(${JSON.stringify(op.dir)}${op.id === undefined ? '' : `, ${op.id}`})`
    case 'fillValue':
      return `__samba.fillValue(${op.id}, ${encodeValue(op.value)})`
    case 'submitForm':
      return `__samba.submitForm(${op.id})`
    case 'isSecretField':
      return `__samba.isSecretField(${op.id})`
    case 'keypadSignals':
      return '__samba.keypadSignals()'
    case 'overlays':
      return '__samba.overlays()'
  }
}

export const pageBridge = {
  // query 를 주면 라벨·name·href·placeholder 가 일치하는 요소만 나열한다(id 는 그대로)
  snapshot: async (tab: Tab, query?: string, selector?: string): Promise<PageSnapshot> => {
    const op: AgentOp = {
      op: 'snapshot',
      ...(query === undefined ? {} : { query }),
      ...(selector === undefined ? {} : { selector })
    }
    const { main, frames } = await callEveryFrame(tab, op, snapshotSchema)
    // 선택자가 잘못됐으면 프레임 합치기 전에 그대로 알린다
    if (main.selectorError !== undefined) return main
    // 아무것도 없는 프레임(광고·추적용 빈 iframe)은 목록을 흐리기만 한다
    const useful: FrameSnapshot[] = frames
      .filter((f) => f.value.elements.length > 0 || f.value.text.length > 0)
      .map((f) => ({ index: f.index, host: f.host, snapshot: f.value }))
    return mergeFrameSnapshots(main, useful)
  },
  // 요소 [id] 의 실제 페이지 텍스트. 없으면 빈 문자열
  textOf: (tab: Tab, id: number): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'textOf', id: n }), resultSchema),
  click: (tab: Tab, id: number): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'click', id: n }), resultSchema),
  type: (tab: Tab, id: number, text: string, submit: boolean): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'type', id: n, text, submit }), resultSchema),
  select: (tab: Tab, id: number, value: string): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'select', id: n, value }), resultSchema),
  // id 를 주면 그 요소를 품은 스크롤 상자(드롭다운 목록 등)를 그 요소가 있는 프레임에서 스크롤한다
  scroll: (tab: Tab, dir: 'up' | 'down', id?: number): Promise<string> =>
    callById(
      tab,
      id ?? 0,
      (n) => (id === undefined ? { op: 'scroll', dir } : { op: 'scroll', dir, id: n }),
      resultSchema
    ),
  // 값 주입(SECRET 허용) — 값이 code 문자열 안에 들어가므로, 실패해도 code 를 담은 오류를
  // 만들지 않도록 공용 call() 을 쓰지 않고 이 함수 안에서 직접 try/catch 한다
  fillValue: async (tab: Tab, id: number, value: string): Promise<string> => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return 'page is gone'
    try {
      // JSON.stringify 는 스펙상 U+2028/U+2029(line/paragraph separator)를 이스케이프하지 않는다.
      // 현재 엔진(Electron ^39, ES2019+)은 문자열 리터럴 내 미이스케이프 U+2028/2029 도 정상
      // 파싱하지만, 향후 엔진/실행 경로 변경에 대비해 방어적으로 직접 이스케이프해 둔다.
      const encoded = JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
      // 요소가 iframe 안(주소 입력·결제 폼)이면 그 프레임의 preload 에 맡긴다
      const { frameIndex, id: localId } = decodeFrameId(id)
      if (frameIndex !== 0) {
        const frame = agentSubFrames(wc)[frameIndex - 1]
        if (!frame) return 'fill failed'
        const fromFrame = resultSchema.safeParse(
          await callFrameOp(frame, { op: 'fillValue', id: localId, value })
        )
        return fromFrame.success ? fromFrame.data : 'fill failed'
      }
      const code = `__samba.fillValue(${localId}, ${encoded})`
      const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }])
      const parsed = resultSchema.safeParse(raw)
      return parsed.success ? parsed.data : 'fill failed'
    } catch {
      return 'fill failed'
    }
  },
  findLoginFields: (tab: Tab): Promise<LoginFieldsResult> =>
    call(tab.view.webContents, '__samba.findLoginFields()', loginFieldsSchema),
  // 문자 인증번호 입력칸 후보. 새 페이지 채널을 만들지 않고 스냅샷을 다시 받아
  // 순수 판정 함수(auth-flow)를 메인 쪽에서 적용한다
  findCodeField: async (tab: Tab): Promise<PageElement | null> =>
    pickCodeField(await call(tab.view.webContents, '__samba.snapshot()', snapshotSchema)),
  // 이미 로그인된 상태인지 힌트(로그인 폼을 못 찾았을 때만 쓴다)
  signedInHint: (tab: Tab): Promise<SignedInHintResult> =>
    call(tab.view.webContents, '__samba.signedInHint()', signedInHintSchema),
  // 결제 비밀번호 키패드 신호(비밀 화면 판정용). 입력 내용은 읽지 않는다
  keypadSignals: (tab: Tab): Promise<KeypadSignals> =>
    call(tab.view.webContents, '__samba.keypadSignals()', keypadSignalsSchema),
  /**
   * 메인 프레임 + iframe 전부의 키패드 신호. 페이코 보안 키패드처럼 숫자 버튼이
   * iframe 안에만 있는 화면을 놓치지 않으려면 프레임까지 봐야 한다.
   * 합산과 판정은 main/agent/secret-page 의 순수 함수가 한다
   */
  keypadSignalsAll: async (tab: Tab): Promise<KeypadSignals[]> => {
    const { main, frames } = await callEveryFrame(tab, { op: 'keypadSignals' }, keypadSignalsSchema)
    return [main, ...frames.map((f) => f.value)]
  },
  /**
   * 지금 화면을 덮고 있는 레이어들(메인 프레임 + iframe).
   * 팝업 안 공지·쿠폰 레이어도 잡히도록 프레임까지 훑고, 프레임 요소 id 에는
   * 프레임 번호를 얹는다 — 그대로 click 에 넘길 수 있어야 한다
   */
  overlays: async (tab: Tab): Promise<PageOverlay[]> => {
    const { main, frames } = await callEveryFrame(tab, { op: 'overlays' }, overlayListSchema)
    const out: PageOverlay[] = main.map((o) => ({
      ...o,
      label: o.label.slice(0, OVERLAY_LABEL_MAX)
    }))
    for (const frame of frames) {
      for (const o of frame.value) {
        out.push({
          id: encodeFrameId(frame.index, o.id),
          label: o.label.slice(0, OVERLAY_LABEL_MAX),
          closeIds: o.closeIds.map((n) => encodeFrameId(frame.index, n)),
          sensitive: o.sensitive
        })
      }
    }
    return out.slice(0, MAX_OVERLAYS)
  },
  // 캡차·2FA 징후 감지(사용자 넘김 판단용)
  captchaHint: (tab: Tab): Promise<CaptchaHintResult> =>
    call(tab.view.webContents, '__samba.captchaHint()', captchaHintSchema),
  // 제출 직전 "로그인 상태 유지" 체크박스 켜기. 결과는 'checked: …' | 'already: …' | 'none'
  checkKeepSignedIn: (tab: Tab, anchorId?: number): Promise<string> =>
    call(
      tab.view.webContents,
      `__samba.checkKeepSignedIn(${anchorId === undefined ? '' : anchorId})`,
      resultSchema
    ),
  submitForm: (tab: Tab, id: number): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'submitForm', id: n }), resultSchema),
  // 최신 스냅샷 기준 요소가 비밀 입력칸(type=password)인지 확인(fill_secret 대상 검증용)
  isSecretField: (tab: Tab, id: number): Promise<boolean> =>
    callById(tab, id, (n) => ({ op: 'isSecretField', id: n }), boolSchema),
  waitForLoad: (tab: Tab, timeoutMs = 10000): Promise<void> =>
    new Promise<void>((resolve) => {
      const wc = tab.view.webContents
      if (!wc.isLoading()) {
        resolve()
        return
      }
      const t = setTimeout(done, timeoutMs)
      function done(): void {
        clearTimeout(t)
        wc.off('did-stop-loading', done)
        resolve()
      }
      wc.on('did-stop-loading', done)
    })
}
