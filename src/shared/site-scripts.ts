// 사이트 스크립트 — 한 번 통한 run_js 코드를 매개변수째 저장해 두고, 다음에는 호출 한 번으로 재생한다.
//
// 왜 필요한가
//  - 사이트 기억의 경로(recipe)는 60자 라벨이라 "이렇게 했었다"는 힌트일 뿐 다시 실행할 수 없다.
//    그래서 같은 주문 처리를 할 때마다 모델이 검색·행 읽기·기록 입력 코드를 새로 쓰고(토큰),
//    요소를 다시 찾느라 호출이 늘었다.
//  - 스크립트는 코드 전문을 남긴다. 주문마다 달라지는 값(주문번호·금액·옵션)은 `args` 로 받는다.
//  - 판단(마진·결제수단 선택)은 여전히 모델 몫이다. 스크립트는 "정해진 손놀림"만 맡는다.
//
// 안전
//  - 스크립트는 run_js 와 같은 샌드박스·같은 다리(page.*, tabs.*)로만 돈다. 비밀값에 닿는 길이 없다.
//  - 연속으로 실패한 스크립트는 프롬프트 목록에서 빠진다(사이트가 바뀌면 자연히 도태된다).

import { z } from 'zod'

/** 스크립트 이름: 소문자로 시작하는 snake_case, 3~40자 */
export const SITE_SCRIPT_NAME_RE = /^[a-z][a-z0-9_]{2,39}$/
/** 저장하는 스크립트 수 상한(오래 안 쓴 것부터 버린다) */
export const SITE_SCRIPT_MAX = 40
export const SITE_SCRIPT_DESCRIPTION_MAX = 240
export const SITE_SCRIPT_PARAM_MAX = 10
export const SITE_SCRIPT_PARAM_LENGTH_MAX = 60
/** run_js 상한과 같다(RUN_JS_MAX_CODE) */
export const SITE_SCRIPT_CODE_MAX = 4000
/** 연속 실패가 이만큼 쌓이면 프롬프트 목록에서 뺀다 */
export const SITE_SCRIPT_FAIL_LIMIT = 3
/** 프롬프트에 붙이는 목록 블록 길이 상한 */
export const SITE_SCRIPT_BLOCK_MAX = 3000

export interface SiteScript {
  name: string
  /** 주로 쓰는 사이트(등록 가능 도메인). 목록 표시에만 쓴다 */
  host: string
  /** 무엇을 하고 무엇을 돌려주는지 한두 문장 */
  description: string
  /** `args` 로 받는 값의 이름과 뜻(예: "orderNo — 상품주문번호") */
  params: string[]
  code: string
  createdAt: number
  updatedAt: number
  /** 성공한 실행 횟수 */
  runs: number
  /** 연속 실패 횟수(성공하면 0 으로 돌아간다) */
  fails: number
}

export const siteScriptSchema = z.object({
  name: z.string().regex(SITE_SCRIPT_NAME_RE),
  host: z.string().max(120).catch(''),
  description: z.string().max(SITE_SCRIPT_DESCRIPTION_MAX),
  params: z.array(z.string().max(SITE_SCRIPT_PARAM_LENGTH_MAX)).max(SITE_SCRIPT_PARAM_MAX).catch([]),
  code: z.string().min(1).max(SITE_SCRIPT_CODE_MAX),
  createdAt: z.number().catch(0),
  updatedAt: z.number().catch(0),
  runs: z.number().catch(0),
  fails: z.number().catch(0)
})

/** 파일 전체. 깨진 항목만 버리고 나머지는 살린다 */
export const siteScriptFileSchema = z
  .array(z.unknown())
  .transform((list) =>
    list.flatMap((raw) => {
      const parsed = siteScriptSchema.safeParse(raw)
      return parsed.success ? [parsed.data] : []
    })
  )
  .catch([])

export interface SiteScriptInput {
  name: string
  host?: string
  description: string
  params?: readonly string[]
  code: string
}

/** 저장 요청을 검증한다. 문제가 있으면 모델에게 돌려줄 문구, 없으면 null */
export function validateScriptInput(input: SiteScriptInput): string | null {
  if (!SITE_SCRIPT_NAME_RE.test(input.name))
    return 'refused: name must be snake_case, 3-40 chars (e.g. samba_find_order)'
  if (input.description.trim() === '') return 'refused: description is required'
  if (input.description.length > SITE_SCRIPT_DESCRIPTION_MAX)
    return `refused: description must be ${SITE_SCRIPT_DESCRIPTION_MAX} characters or fewer`
  if (input.code.trim() === '') return 'refused: code is required'
  if (input.code.length > SITE_SCRIPT_CODE_MAX)
    return `refused: code must be ${SITE_SCRIPT_CODE_MAX} characters or fewer`
  const params = input.params ?? []
  if (params.length > SITE_SCRIPT_PARAM_MAX)
    return `refused: at most ${SITE_SCRIPT_PARAM_MAX} params`
  if (params.some((p) => p.length > SITE_SCRIPT_PARAM_LENGTH_MAX))
    return `refused: each param must be ${SITE_SCRIPT_PARAM_LENGTH_MAX} characters or fewer`
  // 주문마다 달라지는 값을 코드에 박아 두면 다음 주문에서 엉뚱한 행을 건드린다
  if (params.length > 0 && !/\bargs\b/.test(input.code))
    return 'refused: the code never reads `args` — take per-order values from args, do not hardcode them'
  if (HARDCODED_ID_RE.test(input.code))
    return 'refused: the code contains a long number (order number / amount). Pass it through args instead'
  return null
}

/** 주문번호·소싱주문번호처럼 긴 숫자. 요소 id(수천 단위)나 sleep(ms)은 걸리지 않는다 */
const HARDCODED_ID_RE = /\d{9,}/

/** 같은 이름이면 갈아 끼우고(실행 통계는 새로 시작), 없으면 더한다. 상한을 넘으면 오래 안 쓴 것부터 버린다 */
export function upsertScript(
  list: readonly SiteScript[],
  input: SiteScriptInput,
  now: number
): SiteScript[] {
  const previous = list.find((s) => s.name === input.name)
  const next: SiteScript = {
    name: input.name,
    host: (input.host ?? '').trim().slice(0, 120),
    description: input.description.trim(),
    params: [...(input.params ?? [])],
    code: input.code,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    runs: 0,
    fails: 0
  }
  const rest = list.filter((s) => s.name !== input.name)
  return [...rest, next].sort((a, b) => a.updatedAt - b.updatedAt).slice(-SITE_SCRIPT_MAX)
}

/** 실행 결과를 통계에 반영한다. 성공하면 연속 실패를 지운다 */
export function recordScriptRun(
  list: readonly SiteScript[],
  name: string,
  ok: boolean,
  now: number
): SiteScript[] {
  return list.map((s) =>
    s.name !== name
      ? s
      : ok
        ? { ...s, runs: s.runs + 1, fails: 0, updatedAt: now }
        : { ...s, fails: s.fails + 1 }
  )
}

/** 프롬프트에 실을 만한 스크립트인가(연속 실패가 쌓이면 뺀다) */
export function isUsableScript(script: SiteScript): boolean {
  return script.fails < SITE_SCRIPT_FAIL_LIMIT
}

/** 시스템 프롬프트에 붙이는 목록. 코드 전문은 싣지 않는다 — 이름·설명·인자만 */
export function buildScriptsBlock(list: readonly SiteScript[]): string {
  const usable = list.filter(isUsableScript).sort((a, b) => b.runs - a.runs)
  if (usable.length === 0) return ''
  const lines = [
    '# Saved scripts',
    'These are run_js snippets that already worked on these sites. Call run_script(name, args) instead of',
    'rewriting the same steps — it is one tool call and costs no code tokens. If a script errors or its',
    'result does not match the page, fall back to doing the steps yourself and save a fixed version.',
    ''
  ]
  for (const s of usable) {
    const params = s.params.length > 0 ? ` | args: ${s.params.join('; ')}` : ''
    const stats = s.runs > 0 ? ` | worked ${s.runs}×` : ''
    lines.push(`- ${s.name}${s.host ? ` (${s.host})` : ''}: ${s.description}${params}${stats}`)
  }
  const block = lines.join('\n')
  return block.length <= SITE_SCRIPT_BLOCK_MAX ? block : `${block.slice(0, SITE_SCRIPT_BLOCK_MAX)}…`
}

/** 실행 결과가 실패인가 — 샌드박스는 오류를 `Error:` / `refused:` 문자열로 돌려준다 */
export function isScriptFailure(result: string): boolean {
  return /^(Error:|refused:)/m.test(result)
}
