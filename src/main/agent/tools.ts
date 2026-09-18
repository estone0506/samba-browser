import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TabManager, Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { LoginFieldsResult } from '../browser/page-bridge'
import { serializeSnapshot } from '../../shared/snapshot'
import { isDangerous } from '../../shared/danger'
import type { PermissionMode, VaultAccessPolicy } from '../../shared/settings'
import type { VaultService } from '../vault/service'
import type { AccountDto, AgentAccess, VaultItemType } from '../../shared/vault'
import { normalizeHost, registrableDomain } from '../../shared/host'
import { DEFAULT_FIELD_KEY } from '../vault/fields'
import { formatDialogNote } from '../browser/dialogs'
import { createOcrTool } from './tools-ocr'
import { knownLoginUrl, isLikelyLoginUrl } from '../../shared/site-rules'

// 읽기 전용 모드에서 실행 자체를 거부할 때 돌려주는 문자열(AI 가 읽고 판단)
const READ_ONLY_REFUSAL = 'refused: read-only mode'
// finalConfirm 이 거부됐을 때 모델이 계속 작업하도록 돌려주는 문자열
const CONTINUE_INSTRUCTION = 'user asked to continue; do not finish yet'
// 금고가 잠겨 있을 때 돌려주는 문자열(모델이 사용자에게 해제를 요청하도록 유도)
const VAULT_LOCKED = 'locked: ask the user to unlock 키마스터'
// 금고를 아직 설정하지 않았을 때(state === 'uninitialized') 돌려주는 문자열
const VAULT_NOT_SET_UP = 'not set up: ask the user to set up 키마스터 first'
// 현재 탭의 호스트를 알 수 없을 때(정규화 실패·활성 탭 없음) 돌려주는 문자열.
// 전체 계정으로 폴백하지 않기 위해 명시적으로 거부한다
const HOST_UNKNOWN = 'host unknown: navigate to the site first'
// list_accounts 의 host 인자가 현재 탭 호스트와 다를 때 돌려주는 문자열
const HOST_MISMATCH = 'refused: host must match the current tab'
// 계정을 특정하지 못했을 때 돌려주는 문자열
const ACCOUNT_NOT_FOUND = 'account not found: use list_accounts'
// guard 모드에서 추가 확인을 받아야 하는 민감 항목
const CONFIRM_ITEM_TYPES: VaultItemType[] = ['password', 'card']
// fill_secret 대상 요소가 실제로 비밀 입력칸(type=password)이어야 하는 항목 종류.
// 카드·신원정보는 번호칸이 평문 input 인 경우가 흔해 이 검사에서 제외한다
const SECRET_TARGET_ITEM_TYPES: VaultItemType[] = ['login', 'password']
// 대상 요소가 비밀 입력칸이 아닐 때 돌려주는 문자열
const NOT_A_SECRET_FIELD = 'refused: target is not a secret input'
// 접근 정책이 never 일 때 돌려주는 문자열
const VAULT_ACCESS_NEVER = 'refused: KeyMaster access policy is Never'
// 현재 호스트가 제외 도메인 목록에 있을 때 돌려주는 문자열
const VAULT_HOST_EXCLUDED = 'refused: host is excluded from KeyMaster'
// list_accounts 에서 제외 도메인일 때 돌려주는 문자열(계정 목록 자체를 노출하지 않는다)
const LIST_ACCOUNTS_HOST_EXCLUDED = 'refused: host excluded'
// 평문(http)으로 열린 페이지에 비밀값을 채우려 할 때 돌려주는 문자열
const INSECURE_PAGE = 'refused: insecure page (https required)'
// http 라도 비밀값 입력을 허용하는 로컬 개발 호스트
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1']

/**
 * 비밀값을 채워도 되는 페이지인지 판정한다.
 * https 만 허용하고, 로컬 개발 서버(http://localhost 등)만 예외로 둔다.
 * 파싱이 안 되는 URL(about:blank 등)도 거부한다.
 */
export function isSecurePageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:') return LOCAL_HOSTNAMES.includes(u.hostname)
    return false
  } catch {
    return false
  }
}

// 금고에 저장된 항목 종류(도구 스키마용). shared/vault 의 VaultItemType 과 단일 소스로 유지한다.
// `satisfies` 는 초과/오타 항목을 잡고, 아래 완전성 체크는 누락 항목을 컴파일 타임에 잡는다
const ITEM_TYPES = [
  'login',
  'password',
  'card',
  'note',
  'identity',
  'document'
] as const satisfies readonly VaultItemType[]

// 타입 레벨 완전성 체크 — VaultItemType 에 값이 추가되고 ITEM_TYPES 갱신을 잊으면 컴파일 에러가 난다
type ItemTypesComplete = [VaultItemType] extends [(typeof ITEM_TYPES)[number]] ? true : never
const _itemTypesComplete: ItemTypesComplete = true
void _itemTypesComplete

/** 사용자명 마스킹 — 앞 2글자만 남기고 `***` 를 붙인다 */
export function maskUsername(username: string): string {
  return `${username.slice(0, 2)}***`
}

/**
 * 계정 선택 규칙 — 라벨 지정 > 탭 프로필과 같은 라벨 > 기본 계정 > 유일한 계정.
 * 탭 프로필을 같이 넘기면 계정 순회(계정별 새 탭)에서 라벨 없이도 그 탭의 계정을 고른다.
 * 특정하지 못하면 null 을 돌려준다(도구는 ACCOUNT_NOT_FOUND 를 반환).
 */
export function resolveAccount(
  accounts: AccountDto[],
  label?: string,
  tabProfile?: string
): AccountDto | null {
  if (label) return accounts.find((a) => a.label === label) ?? null
  if (tabProfile) {
    const byProfile = accounts.find((a) => a.label === tabProfile)
    if (byProfile) return byProfile
  }
  const preferred = accounts.find((a) => a.isDefault)
  if (preferred) return preferred
  return accounts.length === 1 ? accounts[0] : null
}

/**
 * 계정별 접근 정책과 전역 정책을 합쳐 실제 적용할 정책을 고른다.
 * 계정이 'inherit' 이면 전역 정책을, 아니면 계정 설정이 전역을 override 한다.
 */
export function effectiveAccess(
  accountAccess: AgentAccess | undefined,
  globalPolicy: VaultAccessPolicy
): VaultAccessPolicy {
  if (!accountAccess || accountAccess === 'inherit') return globalPolicy
  return accountAccess
}

export interface ToolContext {
  tabs: TabManager
  dangerWords: string[]
  // 사용 권한 모드. read_only 는 조작 도구를 실행하지 않고, full 은 위험 단어 확인을 생략한다
  mode: PermissionMode
  // 켜져 있으면 done 호출 전에 확인 카드를 띄운다
  finalConfirm: boolean
  // 위험 행동 확인. 승인이면 true. kind 로 위험/완료 확인 카드를 구분한다
  confirm: (action: string, kind?: 'danger' | 'finish') => Promise<boolean>
  // 호출 카운터. 상한 넘으면 문자열 반환
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
  // 키마스터. 주입되지 않은 실행(구버전 호출부·테스트)에서는 금고 도구가 잠금으로 동작한다
  vault?: VaultService
  // 감사 로그에 남길 작업 식별자(실행 1건 = jobId 1개)
  jobId?: string
  // 키마스터 AI 접근 정책. 미지정 시 while_unlocked 로 동작한다(구버전 호출부·테스트 호환)
  vaultAccessPolicy?: VaultAccessPolicy
  // 자동 채움 후 자동 제출 여부. 미지정 시 true(기존 동작)로 동작한다
  vaultAutoSubmit?: boolean
  // 제외 도메인(정규화된 host 문자열). 미지정 시 빈 목록으로 동작한다
  vaultExcludedHosts?: string[]
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text' as const, text: t }]
})

// 현재 탭이 없으면 null
function activeOr(ctx: ToolContext): ReturnType<TabManager['active']> {
  return ctx.tabs.active()
}

// 로그인 진입점으로 보이는 요소의 텍스트·링크 주소 패턴(E2E 하네스의 clickLoginLink 와 같은 규칙).
// 크림처럼 소셜 로그인 버튼만 보이고 이메일 로그인은 한 번 더 눌러야 나오는 사이트가 있어
// "이메일로 로그인" 류를 가장 먼저 찾는다
const EMAIL_LOGIN_TEXT_RE = /이메일(로| )?\s?로그인|email.*(login|sign in)|아이디로 로그인/i
const LOGIN_TEXT_RE = /^(로그인|로그인하기|login|log in|sign\s?in|signin)$/i
const LOGIN_HREF_RE = /login|signin|sign-in|logon/i

/** 페이지 안에서 로그인 링크·버튼을 텍스트 또는 링크 주소로 찾아 한 번 눌러 본다. 눌렀으면 true */
async function clickLoginLink(tab: Tab): Promise<boolean> {
  const snapshot = await pageBridge.snapshot(tab)
  const target =
    snapshot.elements.find((el) => EMAIL_LOGIN_TEXT_RE.test(el.text)) ??
    snapshot.elements.find((el) => LOGIN_TEXT_RE.test(el.text.trim())) ??
    snapshot.elements.find((el) => el.href !== undefined && LOGIN_HREF_RE.test(el.href)) ??
    snapshot.elements.find((el) => /로그인|login|sign in/i.test(el.text))
  if (!target) return false
  await pageBridge.click(tab, target.id)
  await pageBridge.waitForLoad(tab)
  return true
}

/**
 * 로그인 폼을 찾는다. 못 찾으면 도구 호출 1회 안에서 아래 순서로 되짚는다(모델 왕복 감소).
 *   1) 알려진 로그인 URL(knownLoginUrl)로 이동 → 재탐지
 *   2) 현재 페이지의 로그인 링크를 눌러 이동 → 재탐지
 * 끝내 못 찾으면 마지막 탐지 결과(stage: 'none')를 그대로 돌려준다.
 */
export async function findLoginFieldsWithFallback(
  tabs: TabManager,
  tab: Tab,
  host: string
): Promise<LoginFieldsResult> {
  let fields = await pageBridge.findLoginFields(tab)
  if (fields.stage !== 'none') return fields

  // 1) 지금 페이지가 로그인 페이지로 보이지 않을 때만 알려진 로그인 URL 로 옮겨 간다
  const known = knownLoginUrl(host)
  if (known !== undefined && !isLikelyLoginUrl(tab.view.webContents.getURL())) {
    try {
      await tabs.navigate(tab.id, known)
      await pageBridge.waitForLoad(tab)
      fields = await pageBridge.findLoginFields(tab)
      if (fields.stage !== 'none') return fields
    } catch {
      // 이동 실패는 다음 단계(로그인 링크 클릭)로 넘어간다
    }
  }

  // 2) 페이지 안의 로그인 링크를 눌러 본다
  try {
    if (await clickLoginLink(tab)) fields = await pageBridge.findLoginFields(tab)
  } catch {
    // 스냅샷·클릭 실패는 무시하고 마지막 탐지 결과를 돌려준다
  }
  return fields
}

export function createSambaTools(ctx: ToolContext): ReturnType<typeof createSdkMcpServer> {
  // 상한 도달 알림은 1회만 보낸다
  let limitNotified = false

  // label 은 실행 뒤에야 알 수 있는 경우(예: login 의 호스트·계정)를 위해 함수도 받는다
  const guard = async <T>(
    label: string | (() => string),
    fn: () => Promise<T>
  ): Promise<ReturnType<typeof text>> => {
    const resolveLabel = (): string => (typeof label === 'string' ? label : label())
    const over = ctx.tick()
    if (over) {
      if (!limitNotified) {
        limitNotified = true
        ctx.onStep('도구 호출 상한 도달', false)
      }
      return text(over)
    }
    try {
      const r = await fn()
      const raw = typeof r === 'string' ? r : JSON.stringify(r)
      ctx.onStep(
        resolveLabel(),
        !/not found|not set up|host unknown|refused|denied|error|locked|fail/i.test(raw)
      )
      // 실행 중 자동으로 닫은 페이지 대화상자가 있으면 그 문구를 결과 앞에 알려 준다
      const dialog = ctx.tabs.takeDialogMessage?.()
      return text(
        dialog
          ? `${formatDialogNote(dialog)}
${raw}`
          : raw
      )
    } catch (e) {
      ctx.onStep(resolveLabel(), false)
      return text(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 현재 탭의 URL. 탭이 없으면 빈 문자열
  const currentUrl = (): string => {
    const tab = activeOr(ctx)
    return tab ? tab.view.webContents.getURL() : ''
  }

  // 현재 탭의 호스트(정규화). 탭이 없거나 정규화에 실패하면 빈 문자열
  const currentHost = (): string => normalizeHost(currentUrl())

  // 현재 호스트가 제외 도메인 목록에 있는지 확인한다. 정확 일치뿐 아니라 같은 등록 도메인
  // (eTLD+1)이면 제외로 취급한다 — 제외 설정이 "example.com" 이어도 "login.example.com" 은
  // 새는 서브도메인이 되면 안 된다
  const isHostExcluded = (host: string): boolean => {
    const excluded = ctx.vaultExcludedHosts ?? []
    if (excluded.length === 0 || !host) return false
    const hostDomain = registrableDomain(host)
    return excluded.some((raw) => {
      const h = normalizeHost(raw) || raw
      return h === host || registrableDomain(h) === hostDomain
    })
  }

  // 전역 접근 정책(계정이 'inherit' 일 때 적용된다)
  const globalPolicy = (): VaultAccessPolicy => ctx.vaultAccessPolicy ?? 'while_unlocked'

  // 금고 인스턴스가 있고 설정도 끝났는지만 본다(정책 판정 전 단계).
  // 미주입은 기존 호출부·테스트 호환을 위해 "잠금"으로 취급한다
  const vaultAvailable = (): VaultService | string => {
    const v = ctx.vault
    if (!v) return VAULT_LOCKED
    if (v.state() === 'uninitialized') return VAULT_NOT_SET_UP
    return v
  }

  // 정해진 정책으로 실제 사용 가능 여부를 판정한다.
  // never 는 즉시 거부하고, always 는 잠겨 있을 때 기기 키로 자동 해제를 시도한다
  const applyPolicy = async (
    v: VaultService,
    policy: VaultAccessPolicy
  ): Promise<VaultService | string> => {
    if (policy === 'never') return VAULT_ACCESS_NEVER
    if (policy === 'always' && v.state() !== 'unlocked') {
      await v.ensureUnlockedByDevice()
    }
    const state = v.state()
    if (state === 'uninitialized') return VAULT_NOT_SET_UP
    if (state !== 'unlocked') return VAULT_LOCKED
    return v
  }

  // 계정을 특정하지 않는 경로(현재는 없음)를 위한 전역 정책 게이트

  const getPage = tool(
    'get_page',
    'Read the current page: URL, title, numbered interactive elements, visible text.',
    {},
    () =>
      guard('페이지 읽기', async () => {
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        await pageBridge.waitForLoad(tab)
        return serializeSnapshot(await pageBridge.snapshot(tab))
      })
  )

  // 화면 캡처: get_page 텍스트로는 알 수 없는 정보(이미지 캡차·그래프·레이아웃)가 필요할 때 사용.
  // read_only 모드에서도 허용(조회일 뿐 조작이 아님). 이미지 블록을 돌려줘야 하므로 text() 기반
  // guard() 를 그대로 쓰지 않고, 같은 호출 상한·step 기록 로직만 인라인으로 맞춘다
  const screenshot = tool(
    'screenshot',
    'Screenshot the active tab as an image. Use when get_page text is not enough (image captcha, chart, layout). Password fields show as dots, never the real value.',
    { full: z.boolean().optional() },
    async () => {
      const over = ctx.tick()
      if (over) {
        if (!limitNotified) {
          limitNotified = true
          ctx.onStep('도구 호출 상한 도달', false)
        }
        return text(over)
      }
      try {
        const tab = activeOr(ctx)
        const bounds = tab?.view.getBounds()
        // 키마스터 등 웹뷰가 접힌 화면(view !== 'browser')은 bounds 가 0 이 되어 캡처 대상이 아니다
        if (!tab || !bounds || bounds.width === 0 || bounds.height === 0) {
          ctx.onStep('화면 캡처', false)
          return text('no visible page')
        }
        const image = await tab.view.webContents.capturePage()
        const { width, height } = image.getSize()
        // 긴 변을 1280px 로 맞춰 리사이즈(비율 유지)
        const resized =
          Math.max(width, height) > 1280
            ? image.resize(width >= height ? { width: 1280 } : { height: 1280 })
            : image
        const base64 = resized.toJPEG(70).toString('base64')
        const { width: w, height: h } = resized.getSize()
        ctx.onStep('화면 캡처', true)
        return {
          content: [
            { type: 'image' as const, data: base64, mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text: `screenshot of ${currentHost() || 'unknown'} (${w}x${h})`
            }
          ]
        }
      } catch (e) {
        ctx.onStep('화면 캡처', false)
        return text(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  const navigate = tool(
    'navigate',
    'Open a URL or search query in the active tab.',
    { url: z.string() },
    ({ url }) =>
      guard(`이동: ${url}`, async () => {
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        await ctx.tabs.navigate(tab.id, url)
        await pageBridge.waitForLoad(tab)
        return `ok: ${tab.view.webContents.getURL()}`
      })
  )

  const click = tool(
    'click',
    'Click element [n] from get_page.',
    { id: z.number().int(), label: z.string().describe('element text, for logging') },
    ({ id, label }) =>
      guard(`클릭: ${label} (#${id})`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 위험 판정 근거는 페이지의 실제 텍스트. AI 가 준 label 은 기록용일 뿐 신뢰하지 않는다
        const pageText = await pageBridge.textOf(tab, id)
        // full 모드는 위험 단어 확인을 생략한다(SECRET 거부·URL 허용목록·호출 상한은 그대로 유지)
        if (ctx.mode !== 'full' && isDangerous(`${pageText} ${label}`, ctx.dangerWords)) {
          const ok = await ctx.confirm(`클릭: ${pageText || label}`, 'danger')
          if (!ok) return 'denied by user'
        }
        const r = await pageBridge.click(tab, id)
        await pageBridge.waitForLoad(tab)
        return r
      })
  )

  const typeTool = tool(
    'type',
    'Type text into input [n]. submit=true presses Enter.',
    { id: z.number().int(), text: z.string(), submit: z.boolean().default(false) },
    ({ id, text: t, submit }) =>
      guard(`입력: "${t.slice(0, 30)}" (#${id})`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 입력값 자체와 대상 입력칸의 실제 텍스트를 함께 판정
        const pageText = await pageBridge.textOf(tab, id)
        if (ctx.mode !== 'full' && isDangerous(`${pageText} ${t}`, ctx.dangerWords)) {
          const ok = await ctx.confirm(`입력: ${t}${pageText ? ` → ${pageText}` : ''}`, 'danger')
          if (!ok) return 'denied by user'
        }
        const r = await pageBridge.type(tab, id, t, submit)
        if (submit) await pageBridge.waitForLoad(tab)
        return r
      })
  )

  const select = tool(
    'select',
    'Choose an option in <select> [n] by value or visible text.',
    { id: z.number().int(), value: z.string() },
    ({ id, value }) =>
      guard(`선택: ${value} (#${id})`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        return tab ? pageBridge.select(tab, id, value) : 'no active tab'
      })
  )

  const scroll = tool(
    'scroll',
    'Scroll the page up or down.',
    { direction: z.enum(['up', 'down']) },
    ({ direction }) =>
      guard(`스크롤 ${direction}`, async () => {
        const tab = activeOr(ctx)
        return tab ? pageBridge.scroll(tab, direction) : 'no active tab'
      })
  )

  const wait = tool(
    'wait',
    'Wait up to 5000 ms for the page to settle.',
    { ms: z.number().int().min(100).max(5000) },
    ({ ms }) =>
      guard(`대기 ${ms}ms`, async () => {
        await new Promise((r) => setTimeout(r, ms))
        return 'ok'
      })
  )

  const newTab = tool(
    'new_tab',
    'Open a new tab (optionally with profile name and mobile mode) and make it active.',
    { url: z.string().optional(), profile: z.string().optional(), mobile: z.boolean().optional() },
    (o) =>
      guard(`새 탭 ${o.profile ?? ''}`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const t = ctx.tabs.create(o)
        return `ok: tab ${t.id}`
      })
  )

  const switchTab = tool(
    'switch_tab',
    'Activate a tab by id (see list in results).',
    { id: z.string() },
    ({ id }) =>
      guard('탭 전환', async () => {
        ctx.tabs.activate(id)
        return `ok. tabs: ${JSON.stringify(
          ctx.tabs.list().map((t) => ({ id: t.id, title: t.title, profile: t.profile }))
        )}`
      })
  )

  const listAccounts = tool(
    'list_accounts',
    'List saved accounts for a host (usernames are masked). Use it to pick an account label for fill_secret/login.',
    { host: z.string().optional() },
    ({ host }) =>
      guard('계정 목록', async () => {
        const v = ctx.vault
        if (!v) return JSON.stringify({ vaultLocked: true, accounts: [] })
        // 현재 탭 호스트를 모르면 전체 계정으로 폴백하지 않는다
        const target = currentHost()
        if (!target) {
          return JSON.stringify({ accounts: [], note: 'host unknown' })
        }
        // host 인자는 현재 탭 호스트(또는 같은 등록 도메인)로만 제한한다 — 모델이 임의 호스트를
        // 넣어 저장된 계정 전체를 훑는 것(열거)을 막되, nid.naver.com 처럼 같은 사이트의
        // 다른 서브도메인에 저장된 계정은 허용한다
        if (host) {
          const h = normalizeHost(host) || host
          if (h !== target && registrableDomain(h) !== registrableDomain(target)) {
            return JSON.stringify({ accounts: [], note: HOST_MISMATCH })
          }
        }
        // 접근 정책 never·제외 도메인은 vaultGate 와 같은 기준으로 즉시 거부한다(계정 열거 자체를 막는다)
        if (globalPolicy() === 'never') return VAULT_ACCESS_NEVER
        if (isHostExcluded(target)) return LIST_ACCOUNTS_HOST_EXCLUDED
        const state = v.state()
        if (state === 'uninitialized') {
          return JSON.stringify({ accounts: [], note: VAULT_NOT_SET_UP })
        }
        // 사용자명은 비밀값이 아니므로 잠겨 있어도 목록 자체는 보여 준다
        const accounts = v.listAccounts(target).map((a) => ({
          label: a.label,
          username: maskUsername(a.username),
          types: a.itemTypes,
          tags: a.tags
        }))
        if (state !== 'unlocked') return JSON.stringify({ vaultLocked: true, accounts })
        return JSON.stringify(accounts)
      })
  )

  const fillSecret = tool(
    'fill_secret',
    'Fill a saved secret (password, card number, ...) into input [n] without ever revealing its value. Use field for a specific field such as "card.number".',
    {
      elementId: z.number().int(),
      itemType: z.enum(ITEM_TYPES),
      field: z.string().optional(),
      accountLabel: z.string().optional()
    },
    ({ elementId, itemType, field, accountLabel }) =>
      guard(`입력: ${itemType}${field ? `.${field}` : ''} (#${elementId})`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        const host = currentHost()
        if (!host) return HOST_UNKNOWN
        // 평문(http) 페이지에는 비밀값을 절대 채우지 않는다(네트워크 도청·다운그레이드 방어)
        if (!isSecurePageUrl(currentUrl())) return INSECURE_PAGE
        if (isHostExcluded(host)) return VAULT_HOST_EXCLUDED
        const available = vaultAvailable()
        if (typeof available === 'string') return available
        // 계정을 먼저 특정해야 계정별 접근 정책을 적용할 수 있다.
        // 계정 목록 조회는 값(비밀번호)을 건드리지 않으므로 잠금 상태에서도 안전하다
        const account = resolveAccount(available.listAccounts(host), accountLabel, tab.profile)
        if (!account) return ACCOUNT_NOT_FOUND
        // 항목별 agentAccess 가 전역 정책을 override 한다
        const gate = await applyPolicy(
          available,
          effectiveAccess(account.agentAccess, globalPolicy())
        )
        if (typeof gate === 'string') return gate
        const v = gate
        // 비밀번호류는 대상 요소가 실제 비밀 입력칸(type=password)일 때만 채운다.
        // 최신 스냅샷을 신뢰하지 않고, 매번 페이지에서 직접 확인한다
        if (SECRET_TARGET_ITEM_TYPES.includes(itemType)) {
          const isSecret = await pageBridge.isSecretField(tab, elementId)
          if (!isSecret) return NOT_A_SECRET_FIELD
        }
        // guard 모드에서 결제 비밀번호·카드는 사용자 확인을 한 번 더 받는다
        if (ctx.mode === 'guard' && CONFIRM_ITEM_TYPES.includes(itemType)) {
          const ok = await ctx.confirm(`키마스터 입력: ${itemType}`, 'danger')
          if (!ok) return 'denied by user'
        }
        const fieldKey = field ?? DEFAULT_FIELD_KEY
        const value = v.getSecretForFill(account.id, itemType, fieldKey, ctx.jobId)
        if (value === null) return `not found: no ${itemType}.${fieldKey} saved for this account`
        // 평문은 여기서만 존재하고 반환값·step 라벨·로그 어디에도 남기지 않는다
        const filled = await pageBridge.fillValue(tab, elementId, value)
        if (filled !== 'ok') return filled
        return 'ok'
      })
  )

  const login = tool(
    'login',
    'Sign in to the current site with a saved account. Never ask the user for a password.',
    { accountLabel: z.string().optional() },
    ({ accountLabel }) => {
      let label = '로그인'
      return guard(
        () => label,
        async () => {
          if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          const host = currentHost()
          if (!host) return HOST_UNKNOWN
          // 평문(http) 로그인 페이지에는 비밀번호를 채우지 않는다
          if (!isSecurePageUrl(currentUrl())) return INSECURE_PAGE
          if (isHostExcluded(host)) return VAULT_HOST_EXCLUDED
          const available = vaultAvailable()
          if (typeof available === 'string') return available
          label = `로그인: ${host}`
          // 폼이 없으면 알려진 로그인 URL 이동 → 페이지 내 로그인 링크 클릭까지 한 번에 시도한다
          let fields = await findLoginFieldsWithFallback(ctx.tabs, tab, host)
          if (fields.stage === 'none') {
            return 'fields not found: navigate to the login page first'
          }
          // 폴백 이동으로 평문(http) 페이지에 내려섰을 수 있어 다시 확인한다
          if (!isSecurePageUrl(currentUrl())) return INSECURE_PAGE
          // 라벨을 안 주면 탭 프로필과 같은 라벨의 계정을 자동으로 고른다(계정 순회 지원)
          const account = resolveAccount(available.listAccounts(host), accountLabel, tab.profile)
          if (!account) return ACCOUNT_NOT_FOUND
          const gate = await applyPolicy(
            available,
            effectiveAccess(account.agentAccess, globalPolicy())
          )
          if (typeof gate === 'string') return gate
          const v = gate
          label = `로그인: ${host} (${account.label})`
          // 2단계 로그인 1단계(아이디 화면): 아이디만 채워 제출한 뒤 비밀번호 화면을 다시 탐지한다
          if (fields.stage === 'username-only' && fields.username !== undefined) {
            const idFilled = await pageBridge.fillValue(tab, fields.username, account.username)
            if (idFilled !== 'ok') return idFilled
            if (ctx.vaultAutoSubmit === false) {
              return 'filled: submit is disabled by setting; ask the user to press login'
            }
            const idSubmitted = await pageBridge.submitForm(tab, fields.submit ?? fields.username)
            if (idSubmitted !== 'ok') return idSubmitted
            await pageBridge.waitForLoad(tab)
            fields = await pageBridge.findLoginFields(tab)
          }
          if (fields.password === undefined) {
            return 'fields not found: navigate to the login page first'
          }
          const password = v.getSecretForFill(account.id, 'login', DEFAULT_FIELD_KEY, ctx.jobId)
          if (password === null) return 'not found: no login password saved for this account'
          // 사용자명은 비밀값이 아니므로 평문 그대로 채운다. 실패해도 전파한다
          if (fields.username !== undefined) {
            const userFilled = await pageBridge.fillValue(tab, fields.username, account.username)
            if (userFilled !== 'ok') return userFilled
          }
          const pwFilled = await pageBridge.fillValue(tab, fields.password, password)
          if (pwFilled !== 'ok') return pwFilled
          // 자동 제출이 꺼져 있으면 채우기만 하고 제출은 사용자에게 맡긴다
          if (ctx.vaultAutoSubmit === false) {
            return 'filled: submit is disabled by setting; ask the user to press login'
          }
          const submitted = await pageBridge.submitForm(tab, fields.submit ?? fields.password)
          if (submitted !== 'ok') return submitted
          await pageBridge.waitForLoad(tab)
          return 'submitted: check the page for success or captcha/2FA'
        }
      )
    }
  )

  // done 은 guard 를 거치지 않으므로 도구 호출 상한(tick)에 계산되지 않는다.
  // 상한에 도달했을 때 "done 으로 마무리하라"고 안내하기 때문에, 마무리 호출까지 막으면 안 된다
  const done = tool(
    'done',
    'Finish the task with a short summary for the user.',
    { summary: z.string() },
    async ({ summary }) => {
      if (ctx.finalConfirm) {
        const ok = await ctx.confirm(summary, 'finish')
        if (!ok) {
          ctx.onStep(`계속 진행: ${summary.slice(0, 60)}`, true)
          return text(CONTINUE_INSTRUCTION)
        }
      }
      ctx.onStep(`완료: ${summary.slice(0, 60)}`, true)
      return text(`DONE: ${summary}`)
    }
  )

  return createSdkMcpServer({
    name: 'samba',
    version: '0.1.0',
    tools: [
      getPage,
      screenshot,
      createOcrTool(ctx),
      navigate,
      click,
      typeTool,
      select,
      scroll,
      wait,
      newTab,
      switchTab,
      listAccounts,
      fillSecret,
      login,
      done
    ]
  })
}

export const SAMBA_TOOL_NAMES = [
  'get_page',
  'screenshot',
  'ocr',
  'navigate',
  'click',
  'type',
  'select',
  'scroll',
  'wait',
  'new_tab',
  'switch_tab',
  'list_accounts',
  'fill_secret',
  'login',
  'done'
].map((n) => `mcp__samba__${n}`)
