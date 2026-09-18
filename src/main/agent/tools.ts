import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TabManager } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import { serializeSnapshot } from '../../shared/snapshot'
import { isDangerous } from '../../shared/danger'
import type { PermissionMode, VaultAccessPolicy } from '../../shared/settings'
import type { VaultService } from '../vault/service'
import type { AccountDto, VaultItemType } from '../../shared/vault'
import { normalizeHost } from '../../shared/host'

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
// 계정을 특정하지 못했을 때 돌려주는 문자열
const ACCOUNT_NOT_FOUND = 'account not found: use list_accounts'
// guard 모드에서 추가 확인을 받아야 하는 민감 항목
const CONFIRM_ITEM_TYPES: VaultItemType[] = ['payment_password', 'card']
// fill_secret 대상 요소가 실제로 비밀 입력칸(type=password)이어야 하는 항목 종류
const SECRET_TARGET_ITEM_TYPES: VaultItemType[] = ['login_password', 'payment_password', 'card']
// 대상 요소가 비밀 입력칸이 아닐 때 돌려주는 문자열
const NOT_A_SECRET_FIELD = 'refused: target is not a secret input'
// 접근 정책이 never 일 때 돌려주는 문자열
const VAULT_ACCESS_NEVER = 'refused: KeyMaster access policy is Never'
// 현재 호스트가 제외 도메인 목록에 있을 때 돌려주는 문자열
const VAULT_HOST_EXCLUDED = 'refused: host is excluded from KeyMaster'
// 접근 정책 always 에서 기기 자동 해제를 시도하는 횟수
const AUTO_UNLOCK_ATTEMPTS = 3

// 금고에 저장된 항목 종류(도구 스키마용). shared/vault 의 VaultItemType 과 단일 소스로 유지한다.
// `satisfies` 는 초과/오타 항목을 잡고, 아래 완전성 체크는 누락 항목을 컴파일 타임에 잡는다
const ITEM_TYPES = [
  'login_password',
  'payment_password',
  'card',
  'passport',
  'id_card',
  'birth_date',
  'address',
  'phone',
  'custom'
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
 * 계정 선택 규칙 — 라벨 지정 > 기본 계정 > 유일한 계정.
 * 특정하지 못하면 null 을 돌려준다(도구는 ACCOUNT_NOT_FOUND 를 반환).
 */
export function resolveAccount(accounts: AccountDto[], label?: string): AccountDto | null {
  if (label) return accounts.find((a) => a.label === label) ?? null
  const preferred = accounts.find((a) => a.isDefault)
  if (preferred) return preferred
  return accounts.length === 1 ? accounts[0] : null
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
      const s = typeof r === 'string' ? r : JSON.stringify(r)
      ctx.onStep(
        resolveLabel(),
        !/not found|not set up|host unknown|refused|denied|error|locked|fail/i.test(s)
      )
      return text(s)
    } catch (e) {
      ctx.onStep(resolveLabel(), false)
      return text(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 현재 탭의 호스트(정규화). 탭이 없거나 정규화에 실패하면 빈 문자열
  const currentHost = (): string => {
    const tab = activeOr(ctx)
    return tab ? normalizeHost(tab.view.webContents.getURL()) : ''
  }

  // 현재 호스트가 제외 도메인 목록에 있는지 확인한다(양쪽 다 normalizeHost 를 거쳐 비교)
  const isHostExcluded = (host: string): boolean => {
    const excluded = ctx.vaultExcludedHosts ?? []
    if (excluded.length === 0 || !host) return false
    return excluded.some((h) => (normalizeHost(h) || h) === host)
  }

  // 실행 가능하면 잠금 해제된 금고를, 아니면 사용자에게 보여 줄 안내 문자열을 돌려준다.
  // 미주입은 기존 호출부·테스트 호환을 위해 "잠금"으로 취급한다.
  // 접근 정책 never 는 즉시 거부하고, always 는 잠겨 있을 때 기기 키로 자동 해제를 시도한다
  const vaultGate = async (): Promise<VaultService | string> => {
    const v = ctx.vault
    if (!v) return VAULT_LOCKED
    const policy = ctx.vaultAccessPolicy ?? 'while_unlocked'
    if (policy === 'never') return VAULT_ACCESS_NEVER
    if (v.state() === 'uninitialized') return VAULT_NOT_SET_UP
    if (policy === 'always') {
      for (let i = 0; i < AUTO_UNLOCK_ATTEMPTS && v.state() !== 'unlocked'; i++) {
        await v.ensureUnlockedByDevice()
      }
    }
    const state = v.state()
    if (state === 'uninitialized') return VAULT_NOT_SET_UP
    if (state !== 'unlocked') return VAULT_LOCKED
    return v
  }

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
        // host 인자도 없고 현재 탭 호스트도 알 수 없으면 전체 계정으로 폴백하지 않는다
        if (!host && !currentHost()) {
          return JSON.stringify({ accounts: [], note: 'host unknown' })
        }
        const target = host ?? currentHost()
        const state = v.state()
        if (state === 'uninitialized') {
          return JSON.stringify({ accounts: [], note: VAULT_NOT_SET_UP })
        }
        // 사용자명은 비밀값이 아니므로 잠겨 있어도 목록 자체는 보여 준다
        const accounts = v.listAccounts(target || undefined).map((a) => ({
          label: a.label,
          username: maskUsername(a.username),
          types: a.itemTypes
        }))
        if (state !== 'unlocked') return JSON.stringify({ vaultLocked: true, accounts })
        return JSON.stringify(accounts)
      })
  )

  const fillSecret = tool(
    'fill_secret',
    'Fill a saved secret (password, card, ...) into input [n] without ever revealing its value.',
    {
      elementId: z.number().int(),
      itemType: z.enum(ITEM_TYPES),
      accountLabel: z.string().optional()
    },
    ({ elementId, itemType, accountLabel }) =>
      guard(`입력: ${itemType} (#${elementId})`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        const host = currentHost()
        if (!host) return HOST_UNKNOWN
        if (isHostExcluded(host)) return VAULT_HOST_EXCLUDED
        const gate = await vaultGate()
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
        const account = resolveAccount(v.listAccounts(host), accountLabel)
        if (!account) return ACCOUNT_NOT_FOUND
        const value = v.getSecretForFill(account.id, itemType, ctx.jobId)
        if (value === null) return `not found: no ${itemType} saved for this account`
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
          if (isHostExcluded(host)) return VAULT_HOST_EXCLUDED
          const gate = await vaultGate()
          if (typeof gate === 'string') return gate
          const v = gate
          label = `로그인: ${host}`
          const fields = await pageBridge.findLoginFields(tab)
          if (fields.password === undefined) {
            return 'fields not found: navigate to the login page first'
          }
          const account = resolveAccount(v.listAccounts(host), accountLabel)
          if (!account) return ACCOUNT_NOT_FOUND
          label = `로그인: ${host} (${account.label})`
          const password = v.getSecretForFill(account.id, 'login_password', ctx.jobId)
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
