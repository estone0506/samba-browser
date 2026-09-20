// 사이트 기억 — 공유 타입·순수 함수.
//
// "한 번 성공했으면 다음엔 빨라져야 한다". 성공한 실행에서 **행동 경로**만 뽑아
// 호스트별로 남겨 두고, 다음 실행의 시스템 프롬프트 뒤에 붙여 준다.
//
// 담지 않는 것
//  - 비밀값·개인정보(수령인·전화·주소·이메일·카드번호)는 라벨에서 `***` 로 지운다.
//  - 전체 URL 은 남기지 않는다 — 경로만 남기고 쿼리는 버린다(주문번호·검색어가 쿼리에 실린다).
//  - 파일은 기기 로컬(userData/site-memory.json)이고 동기화 대상이 아니다.

import { z } from 'zod'
import { maskSecrets } from './notify'
import { normalizeHost, registrableDomain } from './host'

/** 호스트 한 곳에 남기는 경로(recipe) 개수 상한 */
export const SITE_RECIPE_MAX = 5
/** 경로 한 건의 단계 수 상한 */
export const SITE_RECIPE_STEP_MAX = 30
/** 호스트 한 곳에 남기는 메모 개수 상한 */
export const SITE_NOTE_MAX = 20
/** 메모 한 줄의 길이 상한 */
export const SITE_NOTE_LENGTH_MAX = 160
/** 경로에 적는 사용자 지시(목표) 앞부분 길이 */
export const SITE_GOAL_MAX = 60
/** 단계 라벨 길이 상한 */
export const SITE_STEP_LABEL_MAX = 60
/** 프롬프트에 붙이는 기억 블록 전체 길이 상한 */
export const SITE_MEMORY_BLOCK_MAX = 1500
/** 파일 하나에 담는 호스트 수 상한(기억이 한없이 불어나지 않게) */
export const SITE_HOST_MAX = 100

/**
 * 경로에 남기는 **행동** 도구. 관찰 도구(get_page·find_elements·screenshot·ocr)는
 * 다음 실행에 알려 줄 것이 없으므로 넣지 않는다
 */
export const SITE_ACTION_TOOLS = [
  'click',
  'type',
  'select',
  'scroll',
  'switch_tab',
  'dismiss_overlay',
  'run_js'
] as const

export type SiteActionTool = (typeof SITE_ACTION_TOOLS)[number]

export function isSiteActionTool(tool: string): tool is SiteActionTool {
  return (SITE_ACTION_TOOLS as readonly string[]).includes(tool)
}

/** 성공 경로 한 단계 */
export interface SiteRecipeStep {
  tool: SiteActionTool
  /** 요소 텍스트(또는 role). 마스킹을 거친 값만 들어온다 */
  label: string
  /** 그 단계를 밟던 위치. 경로만 남기고 쿼리는 버린다 */
  urlPattern: string
}

/** 성공한 실행 하나에서 뽑은 경로 */
export interface SiteRecipe {
  /** 사용자 지시 앞부분(마스킹 뒤 60자) */
  goal: string
  steps: SiteRecipeStep[]
  createdAt: number
  /** 이 경로를 프롬프트에 실어 보낸 횟수 */
  uses: number
  /** 마지막으로 이 경로가 통한 시각 */
  lastOkAt: number
}

/** 호스트 한 곳의 기억 */
export interface SiteMemoryEntry {
  recipes: SiteRecipe[]
  notes: string[]
}

/** 파일 전체 — 호스트(등록 가능 도메인) → 기억 */
export type SiteMemoryFile = Record<string, SiteMemoryEntry>

/** 설정 화면이 받는 요약 한 줄(기억 본문은 화면으로 나가지 않는다) */
export interface SiteMemorySummary {
  host: string
  recipes: number
  notes: number
}

const recipeStepSchema = z.object({
  tool: z.enum(SITE_ACTION_TOOLS),
  label: z.string().max(SITE_STEP_LABEL_MAX),
  urlPattern: z.string().max(200)
})

const recipeSchema = z.object({
  goal: z.string().max(SITE_GOAL_MAX),
  steps: z.array(recipeStepSchema).max(SITE_RECIPE_STEP_MAX),
  createdAt: z.number(),
  uses: z.number().catch(0),
  lastOkAt: z.number().catch(0)
})

/** 호스트 한 칸의 스키마. 깨진 칸은 호출부가 통째로 버린다(부분 복구는 하지 않는다) */
export const siteMemoryEntrySchema = z.object({
  recipes: z.array(recipeSchema).max(SITE_RECIPE_MAX).catch([]),
  notes: z.array(z.string().max(SITE_NOTE_LENGTH_MAX)).max(SITE_NOTE_MAX).catch([])
})

export const siteMemoryFileSchema = z.record(z.string(), siteMemoryEntrySchema)

// === 마스킹 ================================================================
//
// 라벨은 페이지에서 읽은 요소 텍스트다. 배송지 화면의 버튼 라벨에는 수령인 이름·전화번호·
// 주소가 통째로 들어 있는 경우가 있어, 저장 전에 반드시 지운다

// 전화번호·카드번호처럼 구분자로 끊긴 숫자열(maskSecrets 의 6자리 규칙이 놓친다)
const DASHED_DIGITS_RE = /\d{2,4}[-.\s]\d{3,4}[-.\s]\d{4}/g
// 이메일 주소
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
// 한국 주소 꼴: "서울특별시 강남구 …", "경기도 성남시 …"
const ADDRESS_RE = /[가-힣]{2,8}(?:특별시|광역시|특별자치시|특별자치도|시|도)\s*[가-힣]{1,10}(?:시|군|구)\S*/g
// 수령인·받는분 뒤에 붙은 이름
const RECIPIENT_RE = /(수령인|받는\s?분|받으실\s?분|수취인|recipient)(?:은|는|이|가)?\s*[:=]?\s*\S+/g

/**
 * 저장 전에 비밀값·개인정보를 지운다.
 * 놓치는 것보다 과하게 지우는 쪽이 안전하다 — 기억은 편의를 위한 것이고,
 * 개인정보는 한 번 새면 되돌릴 수 없다
 */
export function maskMemoryText(text: string): string {
  return maskSecrets(text)
    .replace(RECIPIENT_RE, (_m, kw: string) => `${kw} ***`)
    .replace(EMAIL_RE, '***')
    .replace(ADDRESS_RE, '***')
    .replace(DASHED_DIGITS_RE, '***')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 사용자 지시 → 경로의 목표 문구(마스킹 뒤 앞부분만) */
export function toGoal(prompt: string): string {
  return maskMemoryText(prompt).slice(0, SITE_GOAL_MAX)
}

/** 메모 한 줄 정리 — 마스킹 뒤 길이를 자른다. 빈 문자열이면 저장하지 않는다 */
export function toNote(note: string): string {
  return maskMemoryText(note).slice(0, SITE_NOTE_LENGTH_MAX)
}

// === URL·라벨 정리 =========================================================

/** URL → 경로만(쿼리·해시 제거). 파싱이 안 되면 빈 문자열 */
export function toUrlPattern(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/** url 또는 호스트 → 기억 키(등록 가능 도메인) */
export function memoryHost(urlOrHost: string): string {
  return registrableDomain(urlOrHost)
}

// 도구 라벨에서 요소 텍스트만 떼어 낸다.
// "클릭: 구매하기 (#42)" → "구매하기", "입력: \"255\" (#3)" → "255"
const LABEL_PREFIX_RE = /^[^:]{1,12}:\s*/
const LABEL_SUFFIX_RE = /\s*\(#\d+\)\s*$/

/** 도구 라벨 → 사람이 읽는 요소 텍스트(마스킹 포함) */
export function stepLabel(label: string): string {
  const stripped = label.replace(LABEL_SUFFIX_RE, '').replace(LABEL_PREFIX_RE, '')
  const unquoted = stripped.replace(/^"(.*)"$/, '$1')
  return maskMemoryText(unquoted || label).slice(0, SITE_STEP_LABEL_MAX)
}

// === 추출 ==================================================================

/** 러너가 모아 주는 도구 호출 1건 */
export interface AgentToolCall {
  /** 도구 이름(click·type·get_page …) */
  tool: string
  /** 화면에 올라간 라벨 */
  label: string
  /** guard 가 판정한 성공 여부 */
  ok: boolean
  /** 도구가 돌려준 문자열(실패 표식·Enter 폴백·팝업 안내를 여기서 읽는다) */
  result: string
  /** 호출 시점의 대상 URL */
  url: string
}

// 실패로 끝난 호출의 표식. 이런 호출은 경로에 넣지 않는다
const FAILED_RESULT_RE = /\bERR\b|refused|nothing changed|denied|not found|error/i

/** 이 호출이 성공으로 끝났는가(경로에 넣을 값인가) */
export function isSuccessfulCall(call: AgentToolCall): boolean {
  return call.ok && !FAILED_RESULT_RE.test(call.result)
}

/**
 * 성공 실행의 도구 호출 기록 → 호스트별 행동 단계 시퀀스.
 *  - 실패로 끝난 호출은 뺀다
 *  - 같은 라벨이 연달아 나오면 하나만 남긴다
 *  - 관찰 도구(get_page·find_elements·screenshot)는 넣지 않는다
 */
export function extractStepsByHost(calls: AgentToolCall[]): Map<string, SiteRecipeStep[]> {
  const out = new Map<string, SiteRecipeStep[]>()
  for (const call of calls) {
    if (!isSiteActionTool(call.tool)) continue
    if (!isSuccessfulCall(call)) continue
    const host = memoryHost(call.url)
    if (!host) continue
    const steps = out.get(host) ?? []
    const step: SiteRecipeStep = {
      tool: call.tool,
      label: stepLabel(call.label),
      urlPattern: toUrlPattern(call.url)
    }
    const last = steps[steps.length - 1]
    // 같은 라벨 연속 중복 제거(스크롤을 세 번 굴린 기록은 한 줄이면 충분하다)
    if (last && last.tool === step.tool && last.label === step.label) continue
    if (steps.length >= SITE_RECIPE_STEP_MAX) continue
    steps.push(step)
    out.set(host, steps)
  }
  return out
}

// 클릭이 Enter 폴백으로 열렸을 때 도구가 붙이는 표식(preload/page-core 의 문구)
const ENTER_FALLBACK_RE = /pressed Enter|Enter fallback/i
// 버튼 하나가 새 창을 열었을 때 붙는 안내(agent/target 의 popupNotice)
const POPUP_NOTICE_RE = /opened popup/i

/**
 * 도구 결과의 표식에서 메모를 자동으로 만든다.
 * "구매하기 는 클릭이 안 먹고 Enter 로 열린다" 같은 사실은 다음 실행의 왕복을 크게 줄인다
 */
export function autoNotesByHost(calls: AgentToolCall[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (host: string, note: string): void => {
    const list = out.get(host) ?? []
    if (!list.includes(note)) list.push(note)
    out.set(host, list)
  }
  for (const call of calls) {
    if (!isSuccessfulCall(call)) continue
    const host = memoryHost(call.url)
    if (!host) continue
    const label = stepLabel(call.label)
    if (!label) continue
    if (ENTER_FALLBACK_RE.test(call.result)) add(host, `'${label}' 는 Enter 로 열린다`)
    if (POPUP_NOTICE_RE.test(call.result)) add(host, `'${label}' 는 팝업 창으로 열린다`)
  }
  return out
}

// === 저장 상한 ==============================================================

/** 메모를 추가한 목록(중복 제거 + 상한). 오래된 것부터 밀려난다 */
export function addNote(notes: readonly string[], note: string): string[] {
  const cleaned = toNote(note)
  if (!cleaned) return [...notes]
  if (notes.includes(cleaned)) return [...notes]
  return [...notes, cleaned].slice(-SITE_NOTE_MAX)
}

/** 경로를 추가한 목록(최신이 앞, 상한 초과분은 버린다) */
export function addRecipe(recipes: readonly SiteRecipe[], recipe: SiteRecipe): SiteRecipe[] {
  // 같은 목표의 옛 경로는 새 것으로 갈아 끼운다(같은 일을 두 줄로 기억하지 않는다)
  const rest = recipes.filter((r) => r.goal !== recipe.goal)
  return [recipe, ...rest].slice(0, SITE_RECIPE_MAX)
}

// === 주입 블록 ==============================================================

/** 기억 블록 첫 줄에 붙이는 안내 */
export const SITE_MEMORY_HINT =
  '이 경로가 지난번에 통했다. 같은 화면이면 run_js 로 여러 단계를 한 번에 진행하고, 다르면 평소대로 탐색하라.'

/** 블록에 싣는 경로 개수(호스트당) */
export const SITE_MEMORY_RECIPES_IN_BLOCK = 2

function formatRecipe(recipe: SiteRecipe): string {
  const steps = recipe.steps
    .map((s) => `${s.tool} ${s.label}${s.urlPattern ? ` @${s.urlPattern}` : ''}`)
    .join(' > ')
  return `- 경로(${recipe.goal}): ${steps}`
}

/**
 * 호스트별 기억 → 시스템 프롬프트 뒤에 붙일 블록.
 * 전체 길이가 상한을 넘으면 뒤쪽 줄부터 버린다(앞쪽 호스트·메모가 더 중요하다)
 */
export function buildSiteMemoryBlock(
  entries: readonly { host: string; entry: SiteMemoryEntry }[],
  max = SITE_MEMORY_BLOCK_MAX
): string {
  const lines: string[] = []
  for (const { host, entry } of entries) {
    if (entry.notes.length === 0 && entry.recipes.length === 0) continue
    lines.push(`SITE MEMORY (${host}): ${SITE_MEMORY_HINT}`)
    for (const note of entry.notes) lines.push(`- 메모: ${note}`)
    // 가장 최근 성공 경로부터 1~2개
    const recent = [...entry.recipes]
      .sort((a, b) => b.lastOkAt - a.lastOkAt)
      .slice(0, SITE_MEMORY_RECIPES_IN_BLOCK)
    for (const recipe of recent) lines.push(formatRecipe(recipe))
  }
  const out: string[] = []
  let length = 0
  for (const line of lines) {
    // +1 은 줄바꿈
    if (length + line.length + 1 > max) break
    out.push(line)
    length += line.length + 1
  }
  return out.join('\n')
}

// === 사이트명 → 호스트 ======================================================

/**
 * 지시문에 사이트 이름만 적혀 있을 때 쓰는 매핑표.
 * 플레이북 본문의 URL·현재 탭 URL 로는 호스트를 바로 뽑으므로, 여기는 "무신사에서 …"
 * 처럼 이름만 부르는 경우를 받는다
 */
export const SITE_NAME_HOSTS: ReadonlyArray<{ pattern: RegExp; host: string }> = [
  { pattern: /무신사|musinsa/i, host: 'musinsa.com' },
  { pattern: /29cm|29씨엠|이십구센티/i, host: '29cm.co.kr' },
  { pattern: /a-rt|에이알티|에이아르티/i, host: 'a-rt.com' },
  { pattern: /롯데온|lotteon|lotte\s?on/i, host: 'lotteon.com' },
  { pattern: /삼바\s?웨이브|samba[-\s]?wave/i, host: 'samba-wave.vercel.app' }
]

/** 지시문에서 사이트 이름으로 호스트를 뽑는다(중복 없이, 나온 순서대로) */
export function hostsFromText(text: string): string[] {
  const out: string[] = []
  for (const { pattern, host } of SITE_NAME_HOSTS) {
    if (pattern.test(text) && !out.includes(host)) out.push(host)
  }
  return out
}

// 플레이북 본문에서 주소를 걷어 낸다
const URL_IN_TEXT_RE = /https?:\/\/[^\s)'"<>]+/g

/** 텍스트 안의 URL 들에서 호스트를 뽑는다 */
export function hostsFromUrls(text: string): string[] {
  const out: string[] = []
  for (const url of text.match(URL_IN_TEXT_RE) ?? []) {
    const host = memoryHost(url)
    if (host && !out.includes(host)) out.push(host)
  }
  return out
}

/**
 * 이번 실행에서 볼 만한 호스트 목록.
 * 현재 탭 → 지시문의 사이트명 → 플레이북 본문의 URL 순서로 모은다
 */
export function runHosts(input: {
  prompt: string
  playbookTexts?: readonly string[]
  currentUrl?: string
}): string[] {
  const out: string[] = []
  const push = (host: string): void => {
    if (host && !out.includes(host)) out.push(host)
  }
  if (input.currentUrl) push(memoryHost(input.currentUrl))
  for (const host of hostsFromText(input.prompt)) push(host)
  for (const text of input.playbookTexts ?? []) {
    for (const host of hostsFromUrls(text)) push(host)
    for (const host of hostsFromText(text)) push(host)
  }
  return out
}

/** 호스트 문자열을 기억 키로 정리한다(도구 인자 검증용). 유효하지 않으면 빈 문자열 */
export function normalizeMemoryHost(host: string): string {
  return memoryHost(normalizeHost(host) || host)
}
