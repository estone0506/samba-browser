# 자동화 페이지 흐름 그래프·판정 카드 구현 계획 (하네스 3/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자동화 페이지의 플레이북 카드(내장 "SAMBA 미이행 주문 처리") 바로 아래에, 밖에서 도는 하네스(`samba-agent`)의 **감독자 → 전문 에이전트 흐름 그래프**·**작업 목록**·**판정 카드**를 붙인다. 화면은 하네스의 읽기 API 3개(`/graph`·`/jobs`·`/releases`)만 보고, 밖을 바꾸는 동작은 **규칙 파일 저장(`PUT /graph/rules/{agent}`) 하나뿐**이며 저장 전에 확인을 받는다. **승격 버튼은 두지 않는다**(스펙 §4.4b·§10-4).

**Architecture:** 메인 프로세스에 하네스 API 클라이언트(`src/main/harness/client.ts`)를 두고 — 127.0.0.1 주소만 허용, 타임아웃 4초, 실패는 상태값(`offline`·`timeout`·`bad-response`·`bad-url`)으로 —, IPC 4개(`harness:graph|jobs|releases|putRules`)로 렌더러에 연다. 렌더러는 zustand 스토어(`harnessStore`)가 5초마다 `/jobs`·`/releases` 를 다시 읽고(`/graph` 는 진입 시 1회 + 수동 새로고침), 순수 표시 로직(`flowgraph-view.ts`)이 노드 상태·문구 키를 계산하며, 컴포넌트는 그 결과를 그리기만 한다(기존 `recommend-view.ts` 와 같은 구조).

**Tech Stack:** Electron 39 main(Node `fetch`), preload, React 19 + zustand + Tailwind, react-i18next(ko/en), vitest(node 환경, `tests/**/*.test.ts`).

## Global Constraints

- 하네스 주소는 `127.0.0.1`(또는 `localhost`)·`http:` 만 허용한다. 다른 호스트면 호출하지 않고 `bad-url` 을 돌려준다(스펙 §4.4b — 하네스는 로컬 전용).
- 설정 키 `harnessApiUrl`, 기본 `http://127.0.0.1:47812`. 이 PC 값이라 **동기화 대상이 아니다**(`SYNCED_SETTING_KEYS` 에 넣지 않는다).
- **외부 시스템을 바꾸는 동작은 규칙 파일 저장 하나뿐**이다(스펙 §10-1). 저장은 모달 안 2단계 확인(저장 → "네, 저장합니다")을 거치고, 저장 뒤 "새 버전이 되어 판정 시스템을 다시 통과해야 운영에 반영된다"를 화면에 알린다.
- **앱에서 승격(promote)·승인하지 않는다.** 판정 카드의 "사용자 승인" 자리는 슬랙 `@삼바 승인 <버전>` / 명령줄 `uv run python -m samba_agent.ops.gate --version <버전> --approve` **안내 문구와 복사 버튼**뿐이다(스펙 §4.5 6번·§10-4).
- 하네스가 꺼져 있는 것은 정상 상태다 — 화면은 "연결 안 됨"을 조용히 보이고 플레이북 카드 동작을 막지 않는다. 오류(401·타임아웃·JSON 아님)도 같은 자리에 사유만 보인다.
- `any` 금지. 하네스 응답은 `src/shared/harness.ts` 의 타입으로만 다룬다(진실은 `samba-agent/src/samba_agent/api/server.py`).
- 코드 주석·커밋 메시지는 한국어. 들여쓰기 2칸, 세미콜론 없음, 작은따옴표, camelCase/PascalCase.
- i18n 은 ko/en 양쪽에 같은 키. 반응형(최소 폭 360px에서 가로 스크롤 없이) 필수.
- 테스트는 `tests/` 에 vitest(`tests/**/*.test.ts`, node 환경 — React 렌더 테스트는 이 저장소에 없다). 컴포넌트 검증은 **순수 표시 모듈의 텍스트·i18n 키 단언**으로 한다. 각 태스크 끝에 `npx vitest run` 전체 통과 뒤 커밋.

## 하네스 응답(진실 = 코드)

`samba-agent/src/samba_agent/api/server.py`, `ops/gate.py`, `ops/releases.py` 확인 결과:

| 엔드포인트 | 응답 |
|---|---|
| `GET /graph` | `{version, stages: ['buy','pay','record','verify'], agents: [{name, kind, match, tools[], rules, retry}]}` |
| `GET /jobs` | `{jobs: [{order_no, state, assignee_agent, step, requester, harness_version, attempts, updated_at}]}` |
| `GET /releases` | `{current: Release\|null, history: Release[], candidate: {version, report}\|null}` |
| `PUT /graph/rules/{agent}` 본문 `{text}` | `{ok: true, version}` · 오류 `400 bad name|bad json|empty rules|bad path`, `404 unknown agent`, `413 payload too large` |

- `Release` = `{version, verdict: 'promote'|'improve'|'rollback', decided_by, decided_at, report_path, prompt_commits}`.
- `candidate.report` 는 `ops/reports/<version>.md` **본문 전체**다. 여섯 조건은 JSON 이 아니라 그 마크다운 표(`| observe | 통과 |`)에 있다 → 앱이 파싱한다(Task 2).
- 판정 조건 키 6개(`ops/gate.py` `GATE_RULES`): `observe · accuracy · regression · dry_run · review_queue · approval`.
- `step` 이 `승인 대기: pay|record` 로 시작하면 사람 승인 대기다(`queue/db.py`·`worker.py`). 그때 `assignee_agent` 는 `approval.<stage>` 다.
- **규칙 파일을 읽는 엔드포인트는 없다**(PUT 만 있다). 그래서 편집 모달은 "전체 교체"로 동작하고, 빈 채로 열리며 그 사실을 경고로 알린다(§빠진 것 참고).

## 완료 조건 / 다음 단계 진입 조건

- 완료 조건: Task 1~9 전부 커밋, `npx vitest run` 전부 통과, `pnpm typecheck` 오류 0, 실기 확인(하네스 켠 상태 / 끈 상태 / 잘못된 주소 3가지 화면).
- 진입 조건(이 계획 시작): 플랜 2/3 완료 — `uv run python -m samba_agent` 가 뜨고 `curl http://127.0.0.1:47812/graph` 가 등록부를 돌려주며, `ops/reports/<v>.md` 가 하나 있다.
- 검증 범위: 성공(3개 API·규칙 저장) / 실패(하네스 꺼짐·401·404·JSON 아님) / 재시도·시간 초과(4초 뒤 `timeout`, 폴링은 계속) / 중복(폴링 중복 실행 방지, 저장 중 재저장 차단) / 권한 부족(127.0.0.1 아닌 주소 거부).
- 이 계획은 **쇼핑몰·SAMBA-WAVE·슬랙·LangSmith 를 건드리지 않는다.** 하네스의 규칙 파일만 사용자 확인 뒤 바꾼다.

---

### Task 1: 설정 키 `harnessApiUrl`

**Files:**
- Modify: `src/shared/settings.ts` (`DEFAULT_SETTINGS` 의 `bridgeToken: '',` 다음 / 스키마의 `bridgeToken: z.string()...` 다음)
- Test: `tests/harness-settings.test.ts`

**Interfaces:**
- Produces: `Settings.harnessApiUrl: string`(기본 `http://127.0.0.1:47812`). `SYNCED_SETTING_KEYS` 에 넣지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/harness-settings.test.ts
// 하네스 읽기 API 주소 설정 — 기본 127.0.0.1:47812, 이 PC 값이라 동기화하지 않는다
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

describe('하네스 API 주소 설정', () => {
  it('기본값은 http://127.0.0.1:47812', () => {
    expect(DEFAULT_SETTINGS.harnessApiUrl).toBe('http://127.0.0.1:47812')
  })

  it('깨진 값은 기본값으로 돌아간다', () => {
    expect(parseSettings({ ...DEFAULT_SETTINGS, harnessApiUrl: 42 }).harnessApiUrl).toBe(
      'http://127.0.0.1:47812'
    )
    expect(parseSettings({ ...DEFAULT_SETTINGS, harnessApiUrl: 'x'.repeat(500) }).harnessApiUrl).toBe(
      'http://127.0.0.1:47812'
    )
  })

  it('주소는 동기화 대상이 아니다(이 PC 고유값)', () => {
    const synced: readonly string[] = SYNCED_SETTING_KEYS
    expect(synced).not.toContain('harnessApiUrl')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/harness-settings.test.ts`
Expected: FAIL — `harnessApiUrl` 이 undefined

- [ ] **Step 3: 설정 키 추가**

`src/shared/settings.ts` 의 `DEFAULT_SETTINGS` 에서 `bridgeToken: '',` 바로 아래에:

```ts
  // 밖에서 도는 하네스(samba-agent)의 읽기 API 주소. 자동화 페이지의 흐름 그래프·판정 카드가 읽는다.
  // 로컬 전용이라 127.0.0.1(또는 localhost) 만 허용한다 — 이 PC 값이라 동기화하지 않는다
  harnessApiUrl: 'http://127.0.0.1:47812',
```

스키마의 `bridgeToken: z.string().max(128).catch(DEFAULT_SETTINGS.bridgeToken),` 바로 아래에:

```ts
  harnessApiUrl: z.string().max(200).catch(DEFAULT_SETTINGS.harnessApiUrl),
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/harness-settings.test.ts tests/bridge-settings.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/shared/settings.ts tests/harness-settings.test.ts
git commit -m "추가: 하네스 읽기 API 주소 설정 키(harnessApiUrl) — 기본 127.0.0.1:47812, 기기 고유값"
```

---

### Task 2: 하네스 응답 공유 타입 + 판정 리포트(md) 읽기

**Files:**
- Create: `src/shared/harness.ts`
- Test: `tests/harness-report.test.ts`

**Interfaces:**
- Produces: `HarnessGraph`·`HarnessAgent`·`HarnessJob`·`HarnessJobs`·`HarnessRelease`·`HarnessReleases`·`HarnessRulesSaved` 타입, 상수 `HARNESS_STAGES`·`GATE_RULES`, 함수 `parseGateReport(md): GateReport`.
- `GateReport.checks` 는 여섯 조건 전부를 키로 갖는다. 표에 없으면 `null`(= 모름).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/harness-report.test.ts
// 판정 리포트(md) 읽기 — 하네스의 GateResult.to_markdown 이 만든 표를 화면이 쓸 모양으로 바꾼다
import { describe, it, expect } from 'vitest'
import { GATE_RULES, parseGateReport } from '../src/shared/harness'

// samba-agent/src/samba_agent/ops/gate.py 의 GateResult.to_markdown 출력과 같은 모양
const REPORT = `# 판정 — v2026.09.22-ab12cd: **improve**

| 조건 | 결과 |
|---|---|
| observe | 통과 |
| accuracy | 미달 |
| regression | 통과 |
| dry_run | 통과 |
| review_queue | 통과 |
| approval | 미달 |

## 다음 할 일
- 데이터셋이 10건 미만이거나 비어 있다
- 사용자 승인이 없다(@삼바 승인 <버전> 또는 --approve)
`

describe('parseGateReport', () => {
  it('버전·판정·여섯 조건·다음 할 일을 읽는다', () => {
    const r = parseGateReport(REPORT)
    expect(r.version).toBe('v2026.09.22-ab12cd')
    expect(r.verdict).toBe('improve')
    expect(r.checks).toEqual({
      observe: true,
      accuracy: false,
      regression: true,
      dry_run: true,
      review_queue: true,
      approval: false
    })
    expect(r.reasons).toHaveLength(2)
    expect(r.reasons[0]).toContain('데이터셋')
  })

  it('promote 도 읽는다', () => {
    const r = parseGateReport('# 판정 — v1: **promote**\n\n| 조건 | 결과 |\n|---|---|\n| observe | 통과 |\n')
    expect(r.verdict).toBe('promote')
    expect(r.checks.observe).toBe(true)
    // 표에 없는 조건은 모름(null) — "통과"로 오해하지 않는다
    expect(r.checks.approval).toBeNull()
  })

  it('빈 글·엉뚱한 글이면 판정을 모른다고 답한다', () => {
    const r = parseGateReport('아직 판정 파일이 없습니다')
    expect(r.verdict).toBeNull()
    expect(r.version).toBe('')
    expect(Object.keys(r.checks).sort()).toEqual([...GATE_RULES].sort())
    for (const rule of GATE_RULES) expect(r.checks[rule]).toBeNull()
    expect(r.reasons).toEqual([])
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/harness-report.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 공유 타입·파서 구현**

```ts
// src/shared/harness.ts
// 하네스(samba-agent) 읽기 API 의 응답 모양과 판정 리포트 읽기. 메인·렌더러 양쪽에서 쓴다.
//
// 진실은 하네스 코드다 — samba-agent/src/samba_agent/api/server.py(응답),
// ops/gate.py(판정 조건·리포트 마크다운), ops/releases.py(Release).
// 앱은 읽기만 한다. 승격·승인은 슬랙 `@삼바 승인 <버전>` 또는 명령줄에서만 일어난다(스펙 §10-4)

/** 감독자가 넘기는 순서. 하네스 supervisor/policy.py 의 STAGES 와 같다 */
export const HARNESS_STAGES = ['buy', 'pay', 'record', 'verify'] as const
export type HarnessStage = (typeof HARNESS_STAGES)[number]

/** 판정 여섯 조건(ops/gate.py GATE_RULES). 하나라도 미달이면 improve */
export const GATE_RULES = [
  'observe',
  'accuracy',
  'regression',
  'dry_run',
  'review_queue',
  'approval'
] as const
export type GateRule = (typeof GATE_RULES)[number]

export type AgentKind = 'buyer' | 'payer' | 'recorder' | 'verifier'

/** 등록부 한 행(agents/registry.yaml) */
export interface HarnessAgent {
  name: string
  kind: AgentKind
  /** 담당 조건(소싱처·판매처 등). 값은 하네스가 정하므로 문자열 지도로만 받는다 */
  match: Record<string, string>
  /** 브릿지 도구 허용 목록 */
  tools: string[]
  /** 규칙 파일 경로(하네스 저장소 기준 상대 경로) */
  rules: string
  retry: number
}

export interface HarnessGraph {
  version: string
  stages: string[]
  agents: HarnessAgent[]
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'needs_human' | 'cancelled'

export interface HarnessJob {
  order_no: string
  state: JobState
  assignee_agent: string | null
  /** 진행 단계 설명. '승인 대기: pay' 처럼 오면 사람 승인 대기다 */
  step: string | null
  requester: string
  harness_version: string
  attempts: number
  updated_at: string
}

export interface HarnessJobs {
  jobs: HarnessJob[]
}

export interface HarnessRelease {
  version: string
  verdict: 'promote' | 'improve' | 'rollback'
  decided_by: string
  decided_at: string
  report_path: string
  prompt_commits: Record<string, string>
}

export interface HarnessReleases {
  current: HarnessRelease | null
  history: HarnessRelease[]
  /** 지금 코드·규칙·프롬프트가 만드는 후보 버전의 판정 리포트(md 본문). 판정 전이면 null */
  candidate: { version: string; report: string } | null
}

/** 규칙 파일 저장 응답 */
export interface HarnessRulesSaved {
  ok: boolean
  version: string
}

/** 판정 리포트에서 읽어 낸 것 */
export interface GateReport {
  version: string
  verdict: 'promote' | 'improve' | null
  /** 여섯 조건. 표에 없으면 null(모름) — 없는 것을 통과로 읽지 않는다 */
  checks: Record<GateRule, boolean | null>
  reasons: string[]
}

const HEAD_RE = /^#\s*판정\s*—\s*(\S+)\s*:\s*\*\*(promote|improve)\*\*/m
const ROW_RE = /^\|\s*([a-z_]+)\s*\|\s*(통과|미달)\s*\|/gm
const REASONS_RE = /^##\s*다음 할 일\s*$/m

/**
 * 하네스가 만든 판정 리포트(ops/reports/<version>.md) 를 읽는다.
 * JSON 이 아니라 사람이 읽는 표라서 여기서 한 번만 해석하고, 화면은 결과만 쓴다
 */
export function parseGateReport(md: string): GateReport {
  const checks = Object.fromEntries(GATE_RULES.map((r) => [r, null])) as Record<
    GateRule,
    boolean | null
  >
  const head = HEAD_RE.exec(md)
  for (const m of md.matchAll(ROW_RE)) {
    const rule = m[1] as GateRule
    if (GATE_RULES.includes(rule)) checks[rule] = m[2] === '통과'
  }
  const reasons: string[] = []
  const at = REASONS_RE.exec(md)
  if (at) {
    for (const line of md.slice(at.index + at[0].length).split('\n')) {
      const text = line.trim()
      if (text.startsWith('- ')) reasons.push(text.slice(2).trim())
      else if (text.startsWith('#')) break
    }
  }
  return {
    version: head ? head[1] : '',
    verdict: head ? (head[2] as 'promote' | 'improve') : null,
    checks,
    reasons
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/harness-report.test.ts && pnpm typecheck`
Expected: PASS(3), 타입 오류 0

- [ ] **Step 5: 커밋**

```bash
git add src/shared/harness.ts tests/harness-report.test.ts
git commit -m "추가: 하네스 응답 공유 타입과 판정 리포트 읽기(parseGateReport)"
```

---

### Task 3: 하네스 API 클라이언트 (`src/main/harness/client.ts`)

**Files:**
- Create: `src/main/harness/client.ts`
- Test: `tests/harness-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HarnessStatus = 'ok' | 'offline' | 'timeout' | 'bad-response' | 'bad-url'
  export interface HarnessResult<T> { status: HarnessStatus; data: T | null; error: string }
  export interface HarnessDeps {
    /** 지금 설정의 주소(호출마다 다시 읽는다 — 설정을 고치면 바로 반영된다) */
    url: () => string
    fetchImpl?: typeof globalThis.fetch
    /** 한 요청 제한 시간(ms). 기본 4000 */
    timeoutMs?: number
  }
  export function localHarnessBase(raw: string): string | null
  export class HarnessClient {
    constructor(deps: HarnessDeps)
    graph(): Promise<HarnessResult<HarnessGraph>>
    jobs(): Promise<HarnessResult<HarnessJobs>>
    releases(): Promise<HarnessResult<HarnessReleases>>
    putRules(agent: string, text: string): Promise<HarnessResult<HarnessRulesSaved>>
  }
  ```
- 오류는 던지지 않는다 — 전부 `status` 로 돌려준다(하네스가 꺼져 있는 것은 정상 상태다).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/harness-client.test.ts
// 하네스 읽기 API 클라이언트 — 성공 / 127.0.0.1 밖 거부 / 연결 거부 / 타임아웃 / JSON 아님 / 401·404
import { describe, it, expect, vi } from 'vitest'
import { HarnessClient, localHarnessBase } from '../src/main/harness/client'

const URL_OK = 'http://127.0.0.1:47812'

function jsonFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  ) as unknown as typeof globalThis.fetch
}

describe('localHarnessBase', () => {
  it('127.0.0.1·localhost 의 http 주소만 받는다', () => {
    expect(localHarnessBase('http://127.0.0.1:47812')).toBe('http://127.0.0.1:47812')
    expect(localHarnessBase('http://localhost:47812/')).toBe('http://localhost:47812')
    expect(localHarnessBase('http://10.0.0.5:47812')).toBeNull()
    expect(localHarnessBase('https://example.com')).toBeNull()
    expect(localHarnessBase('그냥 글자')).toBeNull()
  })
})

describe('HarnessClient', () => {
  it('graph 를 읽는다', async () => {
    const fetchImpl = jsonFetch({ version: 'v1', stages: ['buy'], agents: [] })
    const c = new HarnessClient({ url: () => URL_OK, fetchImpl })
    const r = await c.graph()
    expect(r.status).toBe('ok')
    expect(r.data?.version).toBe('v1')
    expect(fetchImpl).toHaveBeenCalledWith(`${URL_OK}/graph`, expect.objectContaining({ method: 'GET' }))
  })

  it('127.0.0.1 밖 주소는 부르지 않는다', async () => {
    const fetchImpl = jsonFetch({})
    const r = await new HarnessClient({ url: () => 'http://10.0.0.5:47812', fetchImpl }).jobs()
    expect(r.status).toBe('bad-url')
    expect(r.data).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('하네스가 꺼져 있으면 offline', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).jobs()
    expect(r.status).toBe('offline')
  })

  it('응답이 없으면 제한 시간에 끊고 timeout', async () => {
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })) as unknown as typeof globalThis.fetch
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl, timeoutMs: 20 }).releases()
    expect(r.status).toBe('timeout')
  })

  it('JSON 이 아니면 bad-response', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof globalThis.fetch
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).graph()
    expect(r.status).toBe('bad-response')
    expect(r.error).not.toBe('')
  })

  it('401·404 는 사유를 담아 bad-response', async () => {
    const r401 = await new HarnessClient({
      url: () => URL_OK,
      fetchImpl: jsonFetch({ error: 'unauthorized' }, 401)
    }).jobs()
    expect(r401.status).toBe('bad-response')
    expect(r401.error).toContain('401')
    const r404 = await new HarnessClient({
      url: () => URL_OK,
      fetchImpl: jsonFetch({ error: 'unknown agent: x' }, 404)
    }).putRules('x', '규칙')
    expect(r404.status).toBe('bad-response')
    expect(r404.error).toContain('404')
  })

  it('규칙 저장은 PUT 과 본문 {text} 로 보낸다', async () => {
    const fetchImpl = jsonFetch({ ok: true, version: 'v2' })
    const r = await new HarnessClient({ url: () => URL_OK, fetchImpl }).putRules('buyer.musinsa', '새 규칙')
    expect(r.status).toBe('ok')
    expect(r.data?.version).toBe('v2')
    expect(fetchImpl).toHaveBeenCalledWith(
      `${URL_OK}/graph/rules/buyer.musinsa`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ text: '새 규칙' }) })
    )
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/harness-client.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 클라이언트 구현**

```ts
// src/main/harness/client.ts
// 하네스(samba-agent) 읽기 API 클라이언트. 브릿지와 반대 방향(앱 → 하네스)이다.
//
// 규칙
// - 127.0.0.1(또는 localhost)의 http 주소만 부른다. 다른 주소는 아예 부르지 않는다
// - 던지지 않는다. 꺼짐·타임아웃·엉뚱한 응답을 전부 status 로 돌려준다(하네스가 꺼져 있는 건 정상이다)
// - 바꾸는 요청은 putRules 하나뿐이다. 나머지는 읽기다
import type {
  HarnessGraph,
  HarnessJobs,
  HarnessReleases,
  HarnessRulesSaved
} from '../../shared/harness'

export type HarnessStatus = 'ok' | 'offline' | 'timeout' | 'bad-response' | 'bad-url'

export interface HarnessResult<T> {
  status: HarnessStatus
  data: T | null
  /** 사람이 읽는 사유(성공이면 빈 문자열) */
  error: string
}

export interface HarnessDeps {
  url: () => string
  fetchImpl?: typeof globalThis.fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4000
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1']
/** 오류 본문은 화면에 한 줄로만 보인다 */
const ERROR_TEXT_MAX = 200

/** 설정 주소를 검사해 기준 주소(origin)로 바꾼다. 로컬이 아니면 null */
export function localHarnessBase(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:') return null
    if (!LOCAL_HOSTS.includes(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

export class HarnessClient {
  constructor(private readonly deps: HarnessDeps) {}

  graph(): Promise<HarnessResult<HarnessGraph>> {
    return this.request<HarnessGraph>('GET', '/graph')
  }

  jobs(): Promise<HarnessResult<HarnessJobs>> {
    return this.request<HarnessJobs>('GET', '/jobs')
  }

  releases(): Promise<HarnessResult<HarnessReleases>> {
    return this.request<HarnessReleases>('GET', '/releases')
  }

  /** 규칙 파일 전체 교체. 고치면 새 harness_version 이 되어 판정을 다시 통과해야 한다 */
  putRules(agent: string, text: string): Promise<HarnessResult<HarnessRulesSaved>> {
    return this.request<HarnessRulesSaved>(
      'PUT',
      `/graph/rules/${encodeURIComponent(agent)}`,
      { text }
    )
  }

  private async request<T>(
    method: 'GET' | 'PUT',
    path: string,
    body?: { text: string }
  ): Promise<HarnessResult<T>> {
    const base = localHarnessBase(this.deps.url())
    if (base === null) return { status: 'bad-url', data: null, error: this.deps.url() }
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        signal: abort.signal,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      })
      const text = await res.text()
      if (!res.ok) {
        return {
          status: 'bad-response',
          data: null,
          error: `HTTP ${res.status}: ${text.slice(0, ERROR_TEXT_MAX)}`
        }
      }
      try {
        return { status: 'ok', data: JSON.parse(text) as T, error: '' }
      } catch {
        return { status: 'bad-response', data: null, error: text.slice(0, ERROR_TEXT_MAX) }
      }
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { status: 'timeout', data: null, error: 'timeout' }
      }
      return { status: 'offline', data: null, error: e instanceof Error ? e.message : String(e) }
    } finally {
      clearTimeout(timer)
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/harness-client.test.ts && pnpm typecheck`
Expected: PASS(8), 타입 오류 0

- [ ] **Step 5: 전체 테스트 후 커밋**

Run: `npx vitest run`
Expected: 전부 PASS

```bash
git add src/main/harness/client.ts tests/harness-client.test.ts
git commit -m "추가: 하네스 읽기 API 클라이언트 — 127.0.0.1 만, 4초 제한, 실패를 상태로 돌려준다"
```

---

### Task 4: IPC 4개 배선 + 설정 화면 주소 칸

**Files:**
- Create: `src/main/harness/wiring.ts`
- Modify: `src/shared/ipc.ts` (`bridgeRegenerateToken:` 다음)
- Modify: `src/preload/renderer.ts` (`bridge: { ... },` 다음)
- Modify: `src/main/ipc/handlers.ts` (브릿지 배선 블록 — `handleFromRenderer(IPC.bridgeRegenerateToken, ...)` 다음)
- Modify: `src/renderer/src/components/settings/AgentSection.tsx` (하네스 브릿지 카드의 `bridgeHint` 문단 앞)
- Modify: `src/renderer/src/i18n/ko.json`, `en.json` (`settingsPage.behavior` 아래)
- Test: `tests/harness-wiring.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HarnessApi {
    graph(): Promise<HarnessResult<HarnessGraph>>
    jobs(): Promise<HarnessResult<HarnessJobs>>
    releases(): Promise<HarnessResult<HarnessReleases>>
    putRules(agent: string, text: string): Promise<HarnessResult<HarnessRulesSaved>>
  }
  export function createHarnessApi(settings: () => Settings, fetchImpl?: typeof globalThis.fetch): HarnessApi
  ```
- IPC: `harness:graph`·`harness:jobs`·`harness:releases`·`harness:putRules`.
- 설정 화면: 하네스 브릿지 카드 안에 "하네스 주소" 입력 + "연결 확인" 버튼(그래프를 한 번 읽어 성공/사유 표시).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/harness-wiring.test.ts
// 설정 주소를 그때그때 읽어 부른다 — 주소를 고치면 다음 호출부터 바로 반영된다
import { describe, it, expect, vi } from 'vitest'
import { createHarnessApi } from '../src/main/harness/wiring'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

function fetchOk(): typeof globalThis.fetch {
  return vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })) as unknown as typeof globalThis.fetch
}

describe('createHarnessApi', () => {
  it('설정의 주소로 읽는다', async () => {
    const fetchImpl = fetchOk()
    const api = createHarnessApi(() => ({ ...DEFAULT_SETTINGS }) as Settings, fetchImpl)
    const r = await api.jobs()
    expect(r.status).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:47812/jobs', expect.anything())
  })

  it('주소를 고치면 다음 호출부터 새 주소로 간다', async () => {
    const fetchImpl = fetchOk()
    let url = 'http://127.0.0.1:47812'
    const api = createHarnessApi(() => ({ ...DEFAULT_SETTINGS, harnessApiUrl: url }) as Settings, fetchImpl)
    await api.jobs()
    url = 'http://127.0.0.1:48000'
    await api.jobs()
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:48000/jobs', expect.anything())
  })

  it('규칙 저장은 빈 글을 보내지 않는다(하네스가 400 을 주기 전에 막는다)', async () => {
    const fetchImpl = fetchOk()
    const api = createHarnessApi(() => ({ ...DEFAULT_SETTINGS }) as Settings, fetchImpl)
    const r = await api.putRules('buyer.musinsa', '   ')
    expect(r.status).toBe('bad-response')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/harness-wiring.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 배선 모듈**

```ts
// src/main/harness/wiring.ts
// 설정(harnessApiUrl) → 하네스 클라이언트. handlers 가 IPC 4개를 여기에 건다.
// 주소는 호출마다 설정에서 다시 읽는다 — 설정을 고치면 앱을 다시 켜지 않아도 된다
import { HarnessClient, type HarnessResult } from './client'
import type { Settings } from '../../shared/settings'
import type {
  HarnessGraph,
  HarnessJobs,
  HarnessReleases,
  HarnessRulesSaved
} from '../../shared/harness'

export interface HarnessApi {
  graph(): Promise<HarnessResult<HarnessGraph>>
  jobs(): Promise<HarnessResult<HarnessJobs>>
  releases(): Promise<HarnessResult<HarnessReleases>>
  putRules(agent: string, text: string): Promise<HarnessResult<HarnessRulesSaved>>
}

export function createHarnessApi(
  settings: () => Settings,
  fetchImpl?: typeof globalThis.fetch
): HarnessApi {
  const client = new HarnessClient({
    url: () => settings().harnessApiUrl,
    ...(fetchImpl === undefined ? {} : { fetchImpl })
  })
  return {
    graph: () => client.graph(),
    jobs: () => client.jobs(),
    releases: () => client.releases(),
    putRules: async (agent, text) => {
      // 빈 규칙은 파일을 날리는 것과 같다 — 하네스에 가기 전에 막는다
      if (text.trim() === '') {
        return { status: 'bad-response', data: null, error: 'empty rules' }
      }
      return client.putRules(agent, text)
    }
  }
}
```

- [ ] **Step 4: IPC·preload·handlers 배선**

`src/shared/ipc.ts` — `bridgeRegenerateToken: ...` 줄 다음:

```ts
  // 하네스 읽기 API — 자동화 페이지의 흐름 그래프·판정 카드가 읽는다(127.0.0.1 만)
  harnessGraph: 'harness:graph',
  harnessJobs: 'harness:jobs',
  harnessReleases: 'harness:releases',
  // 바꾸는 유일한 채널 — 규칙 파일 전체 교체(화면에서 확인을 받은 뒤에만 부른다)
  harnessPutRules: 'harness:putRules',
```

`src/preload/renderer.ts` — `bridge: { ... },` 다음(파일 위 import 에 `HarnessResult` 와 `@shared/harness` 타입 추가):

```ts
  // 하네스(밖에서 도는 주문처리 하네스)의 읽기 API. 오류는 status 로 온다
  harness: {
    graph: (): Promise<IpcResult<HarnessResult<HarnessGraph>>> => invoke(IPC.harnessGraph),
    jobs: (): Promise<IpcResult<HarnessResult<HarnessJobs>>> => invoke(IPC.harnessJobs),
    releases: (): Promise<IpcResult<HarnessResult<HarnessReleases>>> => invoke(IPC.harnessReleases),
    putRules: (agent: string, text: string): Promise<IpcResult<HarnessResult<HarnessRulesSaved>>> =>
      invoke(IPC.harnessPutRules, agent, text)
  },
```

`src/main/ipc/handlers.ts` — import 추가:

```ts
import { createHarnessApi } from '../harness/wiring'
```

`handleFromRenderer(IPC.bridgeRegenerateToken, ...)` 블록 다음:

```ts
  // 하네스 읽기 API — 자동화 페이지가 5초마다 부른다. 바꾸는 것은 규칙 파일 하나뿐이다
  const harness = createHarnessApi(() => settings.get())
  handleFromRenderer(IPC.harnessGraph, () => harness.graph())
  handleFromRenderer(IPC.harnessJobs, () => harness.jobs())
  handleFromRenderer(IPC.harnessReleases, () => harness.releases())
  handleFromRenderer(IPC.harnessPutRules, (agent: string, text: string) =>
    harness.putRules(agent, text)
  )
```

- [ ] **Step 5: 설정 화면 주소 칸**

`src/renderer/src/components/settings/AgentSection.tsx` — 하네스 브릿지 카드의 `bridgeHint` 문단(`<p className="text-[11.5px] ...">{t('settingsPage.behavior.bridgeHint')}</p>`) **바로 앞**에:

```tsx
        <SettingsRow label={t('settingsPage.behavior.harnessUrl')}>
          <div className="flex items-center gap-2">
            <TextInput
              value={settings.harnessApiUrl}
              onChange={(v) => update({ harnessApiUrl: v.trim() })}
            />
            <SecondaryButton
              onClick={() =>
                void window.samba.harness.graph().then((r) => {
                  if (!r.ok) return setHarnessCheck('fail')
                  setHarnessCheck(r.data.status === 'ok' ? 'ok' : 'fail')
                })
              }
            >
              {t('settingsPage.behavior.harnessCheck')}
            </SecondaryButton>
          </div>
        </SettingsRow>
        {harnessCheck !== 'none' && (
          <p className="text-[11.5px] text-[var(--text2)]">
            {t(
              harnessCheck === 'ok'
                ? 'settingsPage.behavior.harnessOk'
                : 'settingsPage.behavior.harnessFail'
            )}
          </p>
        )}
```

같은 컴포넌트 맨 위(다른 `useState` 옆)에:

```tsx
  // "연결 확인" 결과. 화면에만 남는 값이라 설정에 저장하지 않는다
  const [harnessCheck, setHarnessCheck] = useState<'none' | 'ok' | 'fail'>('none')
```

(`useState` 가 아직 import 되어 있지 않으면 `import { useState } from 'react'` 를 추가한다.)

i18n `settingsPage.behavior` 에 추가 —

ko.json
```json
"harnessUrl": "하네스 주소",
"harnessCheck": "연결 확인",
"harnessOk": "하네스에 연결됐어요. 자동화 페이지에서 처리 흐름을 볼 수 있습니다",
"harnessFail": "하네스에 닿지 못했어요. 하네스가 켜져 있는지, 주소가 127.0.0.1 인지 확인해 주세요"
```

en.json
```json
"harnessUrl": "Harness address",
"harnessCheck": "Test connection",
"harnessOk": "Connected. The process flow now shows on the Automation page",
"harnessFail": "Could not reach the harness. Check that it is running and that the address is on 127.0.0.1"
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run tests/harness-wiring.test.ts && pnpm typecheck && npx vitest run`
Expected: 전부 PASS

- [ ] **Step 7: 커밋**

```bash
git add src/main/harness/wiring.ts src/main/ipc/handlers.ts src/shared/ipc.ts src/preload/renderer.ts src/renderer/src/components/settings/AgentSection.tsx src/renderer/src/i18n tests/harness-wiring.test.ts
git commit -m "추가: 하네스 읽기 API IPC 4개 배선과 설정의 하네스 주소·연결 확인"
```

---

### Task 5: 흐름 그래프 표시 로직 (`flowgraph-view.ts`)

**Files:**
- Create: `src/renderer/src/components/automation/flowgraph-view.ts`
- Test: `tests/flowgraph-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NodeStatus = 'idle' | 'running' | 'waiting' | 'attention'
  export function stageOfKind(kind: AgentKind): HarnessStage
  export function waitingStageOf(step: string | null): HarnessStage | null
  export function columnsOf(graph: HarnessGraph): Array<{ stage: HarnessStage; agents: HarnessAgent[] }>
  export function nodeStatusOf(agent: HarnessAgent, jobs: HarnessJob[]): NodeStatus
  export function matchTextOf(agent: HarnessAgent): string
  export function jobLineOf(job: HarnessJob): { stateKey: string; step: string; needsHuman: boolean }
  export function connectionKeyOf(status: HarnessStatus): string
  ```
- 문구는 i18n 키만 돌려주고 번역은 컴포넌트가 `t()` 로 한다(기존 `recommend-view.ts` 와 같은 규칙).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/flowgraph-view.test.ts
// 흐름 그래프의 표시 로직 — 어느 노드가 도는 중인지, 사람 승인을 기다리는지
import { describe, it, expect } from 'vitest'
import {
  columnsOf,
  connectionKeyOf,
  jobLineOf,
  matchTextOf,
  nodeStatusOf,
  stageOfKind,
  waitingStageOf
} from '@renderer/components/automation/flowgraph-view'
import type { HarnessAgent, HarnessGraph, HarnessJob } from '@shared/harness'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'

function agent(patch: Partial<HarnessAgent> = {}): HarnessAgent {
  return {
    name: 'buyer.musinsa',
    kind: 'buyer',
    match: { source: 'musinsa', seller: 'poison' },
    tools: ['page.get', 'run_js'],
    rules: 'rules/buyer_musinsa.md',
    retry: 1,
    ...patch
  }
}

function job(patch: Partial<HarnessJob> = {}): HarnessJob {
  return {
    order_no: '734501000740906',
    state: 'running',
    assignee_agent: 'buyer.musinsa',
    step: '옵션 선택',
    requester: 'U123',
    harness_version: 'v1',
    attempts: 0,
    updated_at: '2026-09-22T01:00:00Z',
    ...patch
  }
}

const graph: HarnessGraph = {
  version: 'v1',
  stages: ['buy', 'pay', 'record', 'verify'],
  agents: [
    agent(),
    agent({ name: 'buyer.29cm', match: { source: '29cm' } }),
    agent({ name: 'payer', kind: 'payer', match: {}, rules: 'rules/payer.md', retry: 0 }),
    agent({ name: 'recorder', kind: 'recorder', match: {}, rules: 'rules/recorder.md' }),
    agent({ name: 'verifier', kind: 'verifier', match: {}, rules: 'rules/verifier.md' })
  ]
}

describe('단계 배치', () => {
  it('kind 로 단계를 정한다', () => {
    expect(stageOfKind('buyer')).toBe('buy')
    expect(stageOfKind('payer')).toBe('pay')
    expect(stageOfKind('recorder')).toBe('record')
    expect(stageOfKind('verifier')).toBe('verify')
  })

  it('단계 순서대로 열을 만들고, 같은 단계의 에이전트는 함께 묶는다', () => {
    const cols = columnsOf(graph)
    expect(cols.map((c) => c.stage)).toEqual(['buy', 'pay', 'record', 'verify'])
    expect(cols[0].agents.map((a) => a.name)).toEqual(['buyer.musinsa', 'buyer.29cm'])
    expect(cols[1].agents).toHaveLength(1)
  })
})

describe('노드 상태', () => {
  it('담당 에이전트가 도는 중이면 running, 다른 노드는 idle', () => {
    expect(nodeStatusOf(agent(), [job()])).toBe('running')
    expect(nodeStatusOf(agent({ name: 'payer', kind: 'payer' }), [job()])).toBe('idle')
  })

  it('승인 대기는 그 단계 노드를 waiting 으로 칠한다', () => {
    const waiting = job({ assignee_agent: 'approval.pay', step: '승인 대기: pay' })
    expect(waitingStageOf(waiting.step)).toBe('pay')
    expect(nodeStatusOf(agent({ name: 'payer', kind: 'payer' }), [waiting])).toBe('waiting')
    expect(nodeStatusOf(agent(), [waiting])).toBe('idle')
  })

  it('needs_human 은 담당 노드를 attention 으로 칠한다', () => {
    expect(nodeStatusOf(agent(), [job({ state: 'needs_human' })])).toBe('attention')
  })

  it('끝난 작업은 아무 노드도 칠하지 않는다', () => {
    expect(nodeStatusOf(agent(), [job({ state: 'done' })])).toBe('idle')
    expect(nodeStatusOf(agent(), [])).toBe('idle')
  })
})

describe('문구', () => {
  it('담당 조건은 키=값 으로 한 줄이 된다', () => {
    expect(matchTextOf(agent())).toBe('source=musinsa · seller=poison')
    expect(matchTextOf(agent({ match: {} }))).toBe('')
  })

  it('작업 한 줄은 상태 키·단계·사람 확인 여부를 준다', () => {
    const line = jobLineOf(job({ state: 'needs_human', step: '승인 대기: pay' }))
    expect(line.stateKey).toBe('automation.harness.state.needs_human')
    expect(line.needsHuman).toBe(true)
    expect(line.step).toBe('승인 대기: pay')
    expect(jobLineOf(job()).needsHuman).toBe(false)
  })

  it('연결 상태 문구 키는 ko·en 양쪽에 있다', () => {
    for (const status of ['ok', 'offline', 'timeout', 'bad-response', 'bad-url'] as const) {
      const key = connectionKeyOf(status)
      const path = key.split('.')
      const read = (src: Record<string, unknown>): unknown =>
        path.reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], src)
      expect(read(ko as unknown as Record<string, unknown>), key).toBeTypeOf('string')
      expect(read(en as unknown as Record<string, unknown>), key).toBeTypeOf('string')
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/flowgraph-view.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 표시 로직 구현**

```ts
// src/renderer/src/components/automation/flowgraph-view.ts
// 흐름 그래프의 순수 표시 로직(React 없음 — 단위 테스트에서 그대로 부른다).
//
// 문구는 i18n 키만 돌려주고 번역은 컴포넌트가 t() 로 한다.
// 여기서 정하는 것은 "어느 노드를 무슨 색으로 칠할지"와 "한 줄에 무엇을 쓸지"뿐이다

import {
  HARNESS_STAGES,
  type AgentKind,
  type HarnessAgent,
  type HarnessGraph,
  type HarnessJob,
  type HarnessStage
} from '@shared/harness'
import type { HarnessStatus } from '../../../../main/harness/client'

/** 노드 색. running=도는 중, waiting=사람 승인 대기, attention=사람 확인 필요 */
export type NodeStatus = 'idle' | 'running' | 'waiting' | 'attention'

const STAGE_OF_KIND: Record<AgentKind, HarnessStage> = {
  buyer: 'buy',
  payer: 'pay',
  recorder: 'record',
  verifier: 'verify'
}

export function stageOfKind(kind: AgentKind): HarnessStage {
  return STAGE_OF_KIND[kind]
}

/** '승인 대기: pay' → 'pay'. 승인 대기가 아니면 null */
export function waitingStageOf(step: string | null): HarnessStage | null {
  if (step === null) return null
  const m = /^승인 대기:\s*(\w+)/.exec(step)
  const stage = m?.[1]
  return stage !== undefined && (HARNESS_STAGES as readonly string[]).includes(stage)
    ? (stage as HarnessStage)
    : null
}

/** 감독자가 넘기는 순서대로 열을 만든다. 등록부에 없는 단계는 빈 열로 남는다 */
export function columnsOf(
  graph: HarnessGraph
): Array<{ stage: HarnessStage; agents: HarnessAgent[] }> {
  return HARNESS_STAGES.map((stage) => ({
    stage,
    agents: graph.agents.filter((a) => stageOfKind(a.kind) === stage)
  }))
}

/** 살아 있는 작업만 노드를 칠한다(done·failed·cancelled 은 지나간 일이다) */
export function nodeStatusOf(agent: HarnessAgent, jobs: HarnessJob[]): NodeStatus {
  let status: NodeStatus = 'idle'
  for (const job of jobs) {
    const waiting = waitingStageOf(job.step)
    if (waiting !== null && waiting === stageOfKind(agent.kind)) return 'waiting'
    if (job.assignee_agent !== agent.name) continue
    if (job.state === 'needs_human') return 'attention'
    if (job.state === 'running') status = 'running'
  }
  return status
}

/** 담당 조건 한 줄 — 'source=musinsa · seller=poison' */
export function matchTextOf(agent: HarnessAgent): string {
  return Object.entries(agent.match)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ')
}

/** 작업 목록 한 줄 */
export function jobLineOf(job: HarnessJob): {
  stateKey: string
  step: string
  needsHuman: boolean
} {
  return {
    stateKey: `automation.harness.state.${job.state}`,
    step: job.step ?? '',
    needsHuman: job.state === 'needs_human' || waitingStageOf(job.step) !== null
  }
}

/** 연결 상태 문구 키 */
export function connectionKeyOf(status: HarnessStatus): string {
  if (status === 'ok') return 'automation.harness.conn.ok'
  if (status === 'timeout') return 'automation.harness.conn.timeout'
  if (status === 'bad-response') return 'automation.harness.conn.badResponse'
  if (status === 'bad-url') return 'automation.harness.conn.badUrl'
  return 'automation.harness.conn.offline'
}
```

- [ ] **Step 4: i18n 문구 추가**

ko.json 의 `automation` 아래에 `harness` 를 새로 만든다(이 태스크에서는 위 테스트가 보는 `conn`·`state` 만 넣고, 나머지는 Task 7·8 에서 더한다):

```json
"harness": {
  "conn": {
    "ok": "하네스에 연결됨",
    "offline": "하네스 연결 안 됨 — 하네스가 꺼져 있어요",
    "timeout": "하네스가 응답하지 않아요",
    "badResponse": "하네스 응답을 알아볼 수 없어요",
    "badUrl": "하네스 주소가 127.0.0.1 이 아니에요"
  },
  "state": {
    "queued": "대기",
    "running": "진행 중",
    "done": "완료",
    "failed": "실패",
    "needs_human": "사람 확인 필요",
    "cancelled": "취소됨"
  }
}
```

en.json 의 `automation` 아래에:

```json
"harness": {
  "conn": {
    "ok": "Connected to harness",
    "offline": "Harness not connected - it looks turned off",
    "timeout": "The harness is not responding",
    "badResponse": "The harness reply could not be read",
    "badUrl": "The harness address is not on 127.0.0.1"
  },
  "state": {
    "queued": "Queued",
    "running": "Running",
    "done": "Done",
    "failed": "Failed",
    "needs_human": "Needs a person",
    "cancelled": "Cancelled"
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run tests/flowgraph-view.test.ts && pnpm typecheck`
Expected: PASS(9), 타입 오류 0

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/src/components/automation/flowgraph-view.ts src/renderer/src/i18n tests/flowgraph-view.test.ts
git commit -m "추가: 흐름 그래프 표시 로직 — 단계 배치·노드 상태(진행·승인 대기·사람 확인)·연결 문구"
```

---

### Task 6: 하네스 스토어 (5초 폴링)

**Files:**
- Create: `src/renderer/src/stores/harnessStore.ts`
- Test: `tests/harness-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const HARNESS_POLL_MS = 5000
  interface HarnessState {
    graph: HarnessGraph | null
    jobs: HarnessJob[]
    releases: HarnessReleases | null
    status: HarnessStatus
    error: string
    saving: boolean
    saveError: string
    /** 그래프까지 전부 다시 읽는다(진입·수동 새로고침) */
    refresh: () => Promise<void>
    /** 5초 폴링 시작. 돌려주는 함수를 부르면 멈춘다(두 번 시작해도 타이머는 하나) */
    start: () => () => void
    /** 규칙 파일 전체 교체. 성공하면 그래프를 다시 읽는다 */
    putRules: (agent: string, text: string) => Promise<boolean>
  }
  ```
- 폴링은 `/jobs`·`/releases` 만 읽는다(`/graph` 는 진입·새로고침·규칙 저장 뒤). 하네스가 꺼져 있으면 `status` 만 바뀌고 앞서 읽은 값은 그대로 둔다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/harness-store.test.ts
// 하네스 스토어 — 진입 시 한 번, 그 뒤 5초마다, 꺼져 있으면 상태만 바뀐다
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HARNESS_POLL_MS, useHarnessStore } from '@renderer/stores/harnessStore'

interface FakeApi {
  graph: ReturnType<typeof vi.fn>
  jobs: ReturnType<typeof vi.fn>
  releases: ReturnType<typeof vi.fn>
  putRules: ReturnType<typeof vi.fn>
}

function ok<T>(data: T): { ok: true; data: { status: 'ok'; data: T; error: '' } } {
  return { ok: true, data: { status: 'ok', data, error: '' } }
}

let api: FakeApi

beforeEach(() => {
  vi.useFakeTimers()
  api = {
    graph: vi.fn(async () => ok({ version: 'v1', stages: ['buy'], agents: [] })),
    jobs: vi.fn(async () => ok({ jobs: [{ order_no: '1', state: 'running' }] })),
    releases: vi.fn(async () => ok({ current: null, history: [], candidate: null })),
    putRules: vi.fn(async () => ok({ ok: true, version: 'v2' }))
  }
  ;(globalThis as unknown as { window: { samba: { harness: FakeApi } } }).window = {
    samba: { harness: api }
  }
  useHarnessStore.setState({ graph: null, jobs: [], releases: null, status: 'offline', error: '' })
})

afterEach(() => vi.useRealTimers())

describe('harnessStore', () => {
  it('refresh 는 세 API 를 모두 읽는다', async () => {
    await useHarnessStore.getState().refresh()
    expect(api.graph).toHaveBeenCalledTimes(1)
    expect(useHarnessStore.getState().status).toBe('ok')
    expect(useHarnessStore.getState().jobs).toHaveLength(1)
  })

  it('폴링은 5초마다 jobs·releases 만 다시 읽고, 멈추면 더 읽지 않는다', async () => {
    const stop = useHarnessStore.getState().start()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.graph).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HARNESS_POLL_MS)
    expect(api.jobs).toHaveBeenCalledTimes(2)
    expect(api.graph).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(HARNESS_POLL_MS * 2)
    expect(api.jobs).toHaveBeenCalledTimes(2)
  })

  it('하네스가 꺼지면 상태만 바뀌고 앞서 읽은 그래프는 남는다', async () => {
    await useHarnessStore.getState().refresh()
    api.jobs.mockResolvedValue({ ok: true, data: { status: 'offline', data: null, error: 'fetch failed' } })
    api.releases.mockResolvedValue({ ok: true, data: { status: 'offline', data: null, error: 'fetch failed' } })
    api.graph.mockResolvedValue({ ok: true, data: { status: 'offline', data: null, error: 'fetch failed' } })
    await useHarnessStore.getState().refresh()
    expect(useHarnessStore.getState().status).toBe('offline')
    expect(useHarnessStore.getState().graph?.version).toBe('v1')
  })

  it('규칙 저장은 성공하면 그래프를 다시 읽고, 실패하면 사유를 남긴다', async () => {
    expect(await useHarnessStore.getState().putRules('buyer.musinsa', '새 규칙')).toBe(true)
    expect(api.putRules).toHaveBeenCalledWith('buyer.musinsa', '새 규칙')
    expect(api.graph).toHaveBeenCalled()
    api.putRules.mockResolvedValue({
      ok: true,
      data: { status: 'bad-response', data: null, error: 'HTTP 404: unknown agent' }
    })
    expect(await useHarnessStore.getState().putRules('없음', '새 규칙')).toBe(false)
    expect(useHarnessStore.getState().saveError).toContain('404')
    expect(useHarnessStore.getState().saving).toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/harness-store.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 스토어 구현**

```ts
// src/renderer/src/stores/harnessStore.ts
// 하네스(밖에서 도는 주문처리 하네스)의 읽기 API 를 담아 두는 스토어.
//
// 하네스가 꺼져 있는 것은 정상이다 — 그때는 status 만 바꾸고 앞서 읽은 값은 그대로 둔다
// (화면이 깜빡이며 비지 않게). 밖을 바꾸는 것은 putRules 하나뿐이고, 확인은 화면이 받는다
import { create } from 'zustand'
import type {
  HarnessGraph,
  HarnessJob,
  HarnessReleases
} from '@shared/harness'
import type { HarnessStatus } from '../../../main/harness/client'

/** 그래프·판정 다시 읽는 주기(스펙 §4.4b — 5초) */
export const HARNESS_POLL_MS = 5000

interface HarnessState {
  graph: HarnessGraph | null
  jobs: HarnessJob[]
  releases: HarnessReleases | null
  status: HarnessStatus
  /** 사람이 읽는 사유(연결됨이면 빈 문자열) */
  error: string
  saving: boolean
  saveError: string
  refresh: () => Promise<void>
  start: () => () => void
  putRules: (agent: string, text: string) => Promise<boolean>
}

let timer: ReturnType<typeof setInterval> | null = null

export const useHarnessStore = create<HarnessState>((set, get) => ({
  graph: null,
  jobs: [],
  releases: null,
  status: 'offline',
  error: '',
  saving: false,
  saveError: '',

  refresh: async () => {
    const api = window.samba.harness
    const [graph, jobs, releases] = await Promise.all([api.graph(), api.jobs(), api.releases()])
    // 세 응답 중 아무거나 하나라도 실패하면 그 사유를 연결 상태로 보인다(원인은 대개 하나다)
    const failed = [graph, jobs, releases].find((r) => !r.ok || r.data.status !== 'ok')
    if (failed !== undefined) {
      const reason = failed.ok ? failed.data : { status: 'offline' as HarnessStatus, error: 'ipc' }
      set({ status: reason.status, error: reason.error })
    } else {
      set({ status: 'ok', error: '' })
    }
    if (graph.ok && graph.data.data !== null) set({ graph: graph.data.data })
    if (jobs.ok && jobs.data.data !== null) set({ jobs: jobs.data.data.jobs })
    if (releases.ok && releases.data.data !== null) set({ releases: releases.data.data })
  },

  start: () => {
    void get().refresh()
    if (timer === null) {
      // 등록부(그래프)는 자주 바뀌지 않는다 — 폴링은 작업·판정만 다시 읽는다
      timer = setInterval(() => {
        const api = window.samba.harness
        void Promise.all([api.jobs(), api.releases()]).then(([jobs, releases]) => {
          const failed = [jobs, releases].find((r) => !r.ok || r.data.status !== 'ok')
          if (failed !== undefined) {
            const reason = failed.ok ? failed.data : { status: 'offline' as HarnessStatus, error: 'ipc' }
            set({ status: reason.status, error: reason.error })
          } else {
            set({ status: 'ok', error: '' })
          }
          if (jobs.ok && jobs.data.data !== null) set({ jobs: jobs.data.data.jobs })
          if (releases.ok && releases.data.data !== null) set({ releases: releases.data.data })
        })
      }, HARNESS_POLL_MS)
    }
    return () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
  },

  putRules: async (agent, text) => {
    // 저장 중 다시 저장하지 않는다(같은 파일을 두 번 덮어쓰면 어느 쪽이 남는지 알 수 없다)
    if (get().saving) return false
    set({ saving: true, saveError: '' })
    const r = await window.samba.harness.putRules(agent, text)
    const failed = !r.ok || r.data.status !== 'ok'
    set({ saving: false, saveError: failed ? (r.ok ? r.data.error : 'ipc') : '' })
    if (failed) return false
    // 규칙이 바뀌면 새 버전이다 — 그래프·판정을 다시 읽어 버전 표시를 맞춘다
    await get().refresh()
    return true
  }
}))
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/harness-store.test.ts && pnpm typecheck`
Expected: PASS(4), 타입 오류 0

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/src/stores/harnessStore.ts tests/harness-store.test.ts
git commit -m "추가: 하네스 스토어 — 진입 시 전체 갱신, 5초마다 작업·판정만, 규칙 저장 중복 방지"
```

---

### Task 7: FlowGraph 컴포넌트 + 규칙 편집 모달

**Files:**
- Create: `src/renderer/src/components/automation/FlowGraph.tsx`
- Create: `src/renderer/src/components/automation/RulesDialog.tsx`
- Modify: `src/renderer/src/i18n/ko.json`, `en.json` (`automation.harness` 아래)

**Interfaces:**
- Produces:
  ```tsx
  export function FlowGraph(props: {
    graph: HarnessGraph
    jobs: HarnessJob[]
    onEditRules: (agent: HarnessAgent) => void
  }): React.JSX.Element
  export function RulesDialog(props: {
    agent: HarnessAgent | null
    open: boolean
    saving: boolean
    error: string
    onOpenChange: (open: boolean) => void
    onSave: (text: string) => Promise<boolean>
  }): React.JSX.Element
  ```
- 규칙 저장은 모달 안 **2단계**다: [저장] → 경고 문구 + [네, 저장합니다]. 빈 글이면 저장 버튼이 잠긴다.

- [ ] **Step 1: i18n 문구 추가**

ko.json `automation.harness` 아래에:

```json
"title": "처리 흐름",
"desc": "밖에서 도는 주문처리 하네스의 감독자·에이전트 구성이에요. 지금 도는 작업이 어느 단계에 있는지 색으로 보입니다",
"version": "버전 {{version}}",
"refresh": "새로고침",
"expand": "처리 흐름 보기",
"collapse": "접기",
"stage": { "buy": "구매", "pay": "결제", "record": "기록", "verify": "검증" },
"node": {
  "supervisor": "감독자",
  "retry": "재시도 {{n}}회",
  "noRetry": "재시도 없음",
  "tools": "도구 {{n}}개",
  "edit": "규칙 고치기",
  "status": { "running": "진행 중", "waiting": "승인 대기", "attention": "사람 확인" }
},
"empty": "등록부에 에이전트가 없어요",
"rules": {
  "title": "{{agent}} 규칙 파일",
  "path": "파일: {{path}}",
  "warn": "저장하면 규칙 파일 전체가 여기 쓴 내용으로 바뀝니다. 하네스에는 지금 내용을 읽어 오는 통로가 없어 빈 칸에서 시작해요 — 기존 내용을 살리려면 파일에서 복사해 붙여 넣으세요",
  "newVersion": "고치면 새 하네스 버전이 됩니다. 판정을 다시 통과하고 사람이 승인해야 운영에 반영돼요",
  "placeholder": "규칙을 마크다운으로 쓰세요",
  "save": "저장",
  "confirm": "네, 저장합니다",
  "confirmDesc": "정말 규칙 파일을 이 내용으로 바꿀까요?",
  "cancel": "취소",
  "saved": "저장했어요. 새 버전 {{version}}",
  "failed": "저장하지 못했어요: {{error}}"
}
```

en.json `automation.harness` 아래에:

```json
"title": "Process flow",
"desc": "The supervisor and agents of the external order-processing harness. Colors show where the running job is",
"version": "Version {{version}}",
"refresh": "Refresh",
"expand": "Show process flow",
"collapse": "Hide",
"stage": { "buy": "Buy", "pay": "Pay", "record": "Record", "verify": "Verify" },
"node": {
  "supervisor": "Supervisor",
  "retry": "Retries {{n}}",
  "noRetry": "No retry",
  "tools": "{{n}} tools",
  "edit": "Edit rules",
  "status": { "running": "Running", "waiting": "Awaiting approval", "attention": "Needs a person" }
},
"empty": "No agents in the registry",
"rules": {
  "title": "{{agent}} rules file",
  "path": "File: {{path}}",
  "warn": "Saving replaces the whole rules file with what you type here. The harness has no endpoint to read the current text, so this box starts empty - copy the existing file in if you want to keep it",
  "newVersion": "Editing creates a new harness version. It must pass the gate and be approved by a person before it runs in production",
  "placeholder": "Write the rules in Markdown",
  "save": "Save",
  "confirm": "Yes, save",
  "confirmDesc": "Replace the rules file with this text?",
  "cancel": "Cancel",
  "saved": "Saved. New version {{version}}",
  "failed": "Could not save: {{error}}"
}
```

- [ ] **Step 2: FlowGraph 구현**

```tsx
// src/renderer/src/components/automation/FlowGraph.tsx
// 감독자 → 전문 에이전트 흐름 그래프.
//
// 단계(구매·결제·기록·검증)를 열로 두고, 등록부의 에이전트를 그 열에 담는다.
// 지금 도는 작업의 담당 노드는 색으로 칠하고, 승인 대기는 따로 표시한다.
// 좁은 화면에서는 열이 세로로 쌓인다(가로 스크롤 없음)
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Pencil } from 'lucide-react'
import type { HarnessAgent, HarnessGraph, HarnessJob } from '@shared/harness'
import { StatusBadge } from '@renderer/components/settings/shared'
import { columnsOf, matchTextOf, nodeStatusOf, type NodeStatus } from './flowgraph-view'

const NODE_TONE: Record<NodeStatus, string> = {
  idle: 'border-[var(--line)] bg-white',
  running: 'border-[#2563eb] bg-[#eff6ff]',
  waiting: 'border-[#b45309] bg-[#fffbeb]',
  attention: 'border-[#b91c1c] bg-[#fef2f2]'
}

export function FlowGraph({
  graph,
  jobs,
  onEditRules
}: {
  graph: HarnessGraph
  jobs: HarnessJob[]
  onEditRules: (agent: HarnessAgent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const columns = columnsOf(graph)
  if (graph.agents.length === 0) {
    return (
      <p className="rounded-[9px] border border-dashed border-[var(--line)] px-2.5 py-3 text-center text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.empty')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex w-fit items-center gap-1.5 rounded-[9px] border border-[var(--line)] bg-[var(--bg2)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--text)]">
        {t('automation.harness.node.supervisor')}
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        {columns.map((column, i) => (
          <div key={column.stage} className="flex min-w-0 flex-1 items-stretch gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-[11px] font-semibold text-[var(--text2)]">
                {t(`automation.harness.stage.${column.stage}`)}
              </p>
              {column.agents.map((agent) => (
                <AgentNode
                  key={agent.name}
                  agent={agent}
                  status={nodeStatusOf(agent, jobs)}
                  onEdit={() => onEditRules(agent)}
                />
              ))}
            </div>
            {i < columns.length - 1 && (
              <ChevronRight
                className="hidden h-4 w-4 shrink-0 self-center text-[var(--text2)] md:block"
                aria-hidden
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function AgentNode({
  agent,
  status,
  onEdit
}: {
  agent: HarnessAgent
  status: NodeStatus
  onEdit: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const match = matchTextOf(agent)
  return (
    <div className={`rounded-[9px] border p-2 ${NODE_TONE[status]}`}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text)]">
          {agent.name}
        </span>
        {status !== 'idle' && (
          <StatusBadge
            label={t(`automation.harness.node.status.${status}`)}
            tone={status === 'running' ? 'strong' : 'warn'}
          />
        )}
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('automation.harness.node.edit')}
          title={t('automation.harness.node.edit')}
          className="rounded p-1 text-[var(--text2)] hover:bg-[var(--bg2)]"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
      {match !== '' && (
        <p className="mt-1 truncate text-[11px] text-[var(--text2)]">{match}</p>
      )}
      <p className="mt-0.5 text-[11px] text-[var(--text2)]">
        {agent.retry > 0
          ? t('automation.harness.node.retry', { n: agent.retry })
          : t('automation.harness.node.noRetry')}
        {' · '}
        {t('automation.harness.node.tools', { n: agent.tools.length })}
      </p>
    </div>
  )
}
```

(`StatusBadge` 의 `tone` 은 `'neutral' | 'strong' | 'warn'` 이다 — `'ok'` 같은 값은 없다.)

- [ ] **Step 3: 규칙 편집 모달 구현**

```tsx
// src/renderer/src/components/automation/RulesDialog.tsx
// 에이전트 규칙 파일 편집 — 밖(하네스)을 바꾸는 이 화면의 유일한 동작.
//
// 하네스에는 규칙을 읽어 오는 통로가 없어서 빈 칸에서 시작하고, 저장은 "전체 교체"다.
// 그래서 저장 전에 한 번 더 확인을 받고(2단계), 새 버전이 된다는 사실을 함께 알린다(스펙 §10-1)
import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { PrimaryButton, SecondaryButton } from '@renderer/components/settings/shared'
import type { HarnessAgent } from '@shared/harness'

export function RulesDialog({
  agent,
  open,
  saving,
  error,
  onOpenChange,
  onSave
}: {
  agent: HarnessAgent | null
  open: boolean
  saving: boolean
  /** 저장 실패 사유(없으면 빈 문자열) */
  error: string
  onOpenChange: (open: boolean) => void
  onSave: (text: string) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) return
    // 열 때마다 빈 칸에서 시작한다(하네스가 지금 내용을 주지 않는다)
    setText('')
    setConfirming(false)
  }, [open, agent])

  const save = async (): Promise<void> => {
    const ok = await onSave(text)
    if (ok) onOpenChange(false)
    else setConfirming(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('automation.harness.rules.title', { agent: agent?.name ?? '' })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[11.5px] text-[var(--text2)]">
          {t('automation.harness.rules.path', { path: agent?.rules ?? '' })}
        </p>
        <p className="rounded-[9px] border border-[#b45309] px-2.5 py-2 text-[11.5px] text-[#b45309]">
          {t('automation.harness.rules.warn')}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('automation.harness.rules.placeholder')}
          className="min-h-[220px] w-full rounded-[9px] border border-[var(--line)] bg-white p-2 font-mono text-[12px] text-[var(--text)]"
        />
        <p className="text-[11.5px] text-[var(--text2)]">
          {t('automation.harness.rules.newVersion')}
        </p>
        {error !== '' && (
          <p className="text-[11.5px] text-[#b91c1c]">
            {t('automation.harness.rules.failed', { error })}
          </p>
        )}
        {confirming && (
          <p className="text-[11.5px] font-semibold text-[var(--text)]">
            {t('automation.harness.rules.confirmDesc')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={() => onOpenChange(false)}>
            {t('automation.harness.rules.cancel')}
          </SecondaryButton>
          {confirming ? (
            <PrimaryButton disabled={saving} onClick={() => void save()}>
              {t('automation.harness.rules.confirm')}
            </PrimaryButton>
          ) : (
            <PrimaryButton disabled={text.trim() === '' || saving} onClick={() => setConfirming(true)}>
              {t('automation.harness.rules.save')}
            </PrimaryButton>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm typecheck && npx vitest run`
Expected: 타입 오류 0, 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/src/components/automation/FlowGraph.tsx src/renderer/src/components/automation/RulesDialog.tsx src/renderer/src/i18n
git commit -m "추가: 흐름 그래프 화면과 규칙 편집 모달(저장 전 2단계 확인·새 버전 안내)"
```

---

### Task 8: 판정 카드 + 작업 목록

**Files:**
- Create: `src/renderer/src/components/automation/VerdictCard.tsx`
- Create: `src/renderer/src/components/automation/JobList.tsx`
- Modify: `src/renderer/src/i18n/ko.json`, `en.json` (`automation.harness` 아래)

**Interfaces:**
- Produces:
  ```tsx
  export function VerdictCard(props: { releases: HarnessReleases }): React.JSX.Element
  export function JobList(props: { jobs: HarnessJob[] }): React.JSX.Element
  ```
- 판정 카드: 운영 버전 · 후보 버전 · `promote|improve` · 여섯 조건 체크 · 다음 할 일 · **리포트 md 펼쳐 보기** · **승인 안내(명령 복사)**. 승인·승격 버튼은 없다.

- [ ] **Step 1: i18n 문구 추가**

ko.json `automation.harness` 아래에:

```json
"verdict": {
  "title": "운영 판정",
  "desc": "지금 운영에 도는 버전과, 지금 코드·규칙이 만드는 후보 버전의 판정이에요",
  "prod": "운영 버전",
  "prodNone": "아직 운영에 올라간 버전이 없어요",
  "candidate": "후보 버전",
  "candidateNone": "아직 판정을 돌리지 않았어요. 하네스에서 ops.gate 를 실행하세요",
  "promote": "운영 배포 가능",
  "improve": "디버그·개선 필요",
  "checks": "여섯 조건",
  "pass": "통과",
  "fail": "미달",
  "unknown": "모름",
  "rule": {
    "observe": "관측(추적·마스킹)",
    "accuracy": "정확도·안전",
    "regression": "소요·도구 호출 회귀",
    "dry_run": "staging 실기 1건",
    "review_queue": "검수 큐 차단 0건",
    "approval": "사용자 승인"
  },
  "todo": "다음 할 일",
  "report": "판정 리포트 보기",
  "reportHide": "리포트 접기",
  "reportPath": "리포트 파일: {{path}}",
  "approveTitle": "사용자 승인은 앱에서 하지 않아요",
  "approveDesc": "슬랙에 `@삼바 승인 {{version}}` 을 쓰거나, 하네스에서 아래 명령을 실행하세요",
  "approveCopy": "명령 복사",
  "approveCopied": "복사했어요"
},
"jobs": {
  "title": "작업",
  "empty": "지금 도는 작업이 없어요",
  "order": "주문 {{orderNo}}",
  "agent": "담당 {{agent}}",
  "requester": "요청 {{requester}}",
  "attempts": "재시도 {{n}}회",
  "needsHuman": "사람 확인"
}
```

en.json `automation.harness` 아래에:

```json
"verdict": {
  "title": "Release verdict",
  "desc": "The version running in production and the verdict for the candidate built from the current code and rules",
  "prod": "Production version",
  "prodNone": "No version has been promoted yet",
  "candidate": "Candidate version",
  "candidateNone": "No verdict yet. Run ops.gate on the harness",
  "promote": "Ready for production",
  "improve": "Needs debugging",
  "checks": "Six conditions",
  "pass": "Pass",
  "fail": "Fail",
  "unknown": "Unknown",
  "rule": {
    "observe": "Observe (traces, masking)",
    "accuracy": "Accuracy and safety",
    "regression": "Duration and tool-call regression",
    "dry_run": "One staging dry run",
    "review_queue": "No blocking review items",
    "approval": "User approval"
  },
  "todo": "Next steps",
  "report": "Show verdict report",
  "reportHide": "Hide report",
  "reportPath": "Report file: {{path}}",
  "approveTitle": "Approval does not happen in this app",
  "approveDesc": "Post `@samba approve {{version}}` in Slack, or run the command below on the harness",
  "approveCopy": "Copy command",
  "approveCopied": "Copied"
},
"jobs": {
  "title": "Jobs",
  "empty": "No jobs running",
  "order": "Order {{orderNo}}",
  "agent": "Agent {{agent}}",
  "requester": "Requested by {{requester}}",
  "attempts": "{{n}} retries",
  "needsHuman": "Needs a person"
}
```

- [ ] **Step 2: 판정 카드 구현**

```tsx
// src/renderer/src/components/automation/VerdictCard.tsx
// 판정 카드 — 하네스의 GET /releases 를 그대로 보인다.
//
// 승인·승격 버튼은 두지 않는다(스펙 §4.4b·§10-4). 승인은 슬랙이나 명령줄에서만 하고,
// 여기서는 그 명령을 복사해 갈 수 있게만 한다
import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { GATE_RULES, parseGateReport, type HarnessReleases } from '@shared/harness'
import { SecondaryButton, StatusBadge } from '@renderer/components/settings/shared'

/** 승인 명령(하네스 저장소에서 실행) */
function approveCommand(version: string): string {
  return `uv run python -m samba_agent.ops.gate --version ${version} --approve`
}

export function VerdictCard({ releases }: { releases: HarnessReleases }): React.JSX.Element {
  const { t } = useTranslation()
  const [showReport, setShowReport] = useState(false)
  const [copied, setCopied] = useState(false)
  const report = releases.candidate ? parseGateReport(releases.candidate.report) : null

  return (
    <section className="rounded-[9px] border border-[var(--line)] bg-white p-3">
      <h3 className="text-[12px] font-semibold text-[var(--text)]">
        {t('automation.harness.verdict.title')}
      </h3>
      <p className="mt-1 text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.verdict.desc')}
      </p>

      <dl className="mt-2 flex flex-col gap-1 text-[11.5px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="text-[var(--text2)]">{t('automation.harness.verdict.prod')}</dt>
          <dd className="font-mono text-[var(--text)]">
            {releases.current
              ? releases.current.version
              : t('automation.harness.verdict.prodNone')}
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="text-[var(--text2)]">{t('automation.harness.verdict.candidate')}</dt>
          <dd className="font-mono text-[var(--text)]">
            {releases.candidate
              ? releases.candidate.version
              : t('automation.harness.verdict.candidateNone')}
          </dd>
          {report?.verdict !== null && report !== null && (
            <StatusBadge
              label={t(`automation.harness.verdict.${report.verdict}`)}
              tone={report.verdict === 'promote' ? 'strong' : 'warn'}
            />
          )}
        </div>
      </dl>

      {report !== null && (
        <>
          <p className="mt-2 text-[11px] font-semibold text-[var(--text2)]">
            {t('automation.harness.verdict.checks')}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {GATE_RULES.map((rule) => (
              <li key={rule} className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="min-w-0 truncate text-[var(--text)]">
                  {t(`automation.harness.verdict.rule.${rule}`)}
                </span>
                <span
                  className={
                    report.checks[rule] === true
                      ? 'text-[#15803d]'
                      : report.checks[rule] === false
                        ? 'text-[#b91c1c]'
                        : 'text-[var(--text2)]'
                  }
                >
                  {t(
                    report.checks[rule] === true
                      ? 'automation.harness.verdict.pass'
                      : report.checks[rule] === false
                        ? 'automation.harness.verdict.fail'
                        : 'automation.harness.verdict.unknown'
                  )}
                </span>
              </li>
            ))}
          </ul>

          {report.reasons.length > 0 && (
            <>
              <p className="mt-2 text-[11px] font-semibold text-[var(--text2)]">
                {t('automation.harness.verdict.todo')}
              </p>
              <ul className="mt-1 list-disc pl-4 text-[11.5px] text-[var(--text)]">
                {report.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-2 flex flex-wrap gap-2">
            <SecondaryButton onClick={() => setShowReport(!showReport)}>
              {t(
                showReport
                  ? 'automation.harness.verdict.reportHide'
                  : 'automation.harness.verdict.report'
              )}
            </SecondaryButton>
          </div>
          {showReport && releases.candidate !== null && (
            <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-[9px] border border-[var(--line)] bg-[var(--bg2)] p-2 font-mono text-[11px] text-[var(--text)]">
              {releases.candidate.report}
            </pre>
          )}

          {/* 승인은 앱 밖에서만 한다 — 여기서는 어떻게 하는지 알려 주고 명령만 복사한다 */}
          <div className="mt-2 rounded-[9px] border border-dashed border-[var(--line)] p-2">
            <p className="text-[11.5px] font-semibold text-[var(--text)]">
              {t('automation.harness.verdict.approveTitle')}
            </p>
            <p className="mt-0.5 text-[11.5px] text-[var(--text2)]">
              {t('automation.harness.verdict.approveDesc', {
                version: releases.candidate?.version ?? ''
              })}
            </p>
            <code className="mt-1 block overflow-x-auto whitespace-pre rounded bg-[var(--bg2)] p-1.5 font-mono text-[11px] text-[var(--text)]">
              {approveCommand(releases.candidate?.version ?? '')}
            </code>
            <SecondaryButton
              onClick={() => {
                void navigator.clipboard.writeText(
                  approveCommand(releases.candidate?.version ?? '')
                )
                setCopied(true)
              }}
            >
              {t(
                copied
                  ? 'automation.harness.verdict.approveCopied'
                  : 'automation.harness.verdict.approveCopy'
              )}
            </SecondaryButton>
          </div>
        </>
      )}

      {releases.current !== null && (
        <p className="mt-2 truncate text-[11px] text-[var(--text2)]">
          {t('automation.harness.verdict.reportPath', { path: releases.current.report_path })}
        </p>
      )}
    </section>
  )
}
```

- [ ] **Step 3: 작업 목록 구현**

```tsx
// src/renderer/src/components/automation/JobList.tsx
// 하네스 작업 목록(GET /jobs) — 상태·단계·담당 에이전트·사람 확인 여부.
// 살아 있는 작업만 온다(하네스의 queue.live())
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { HarnessJob } from '@shared/harness'
import { StatusBadge } from '@renderer/components/settings/shared'
import { jobLineOf } from './flowgraph-view'

export function JobList({ jobs }: { jobs: HarnessJob[] }): React.JSX.Element {
  const { t } = useTranslation()
  if (jobs.length === 0) {
    return (
      <p className="rounded-[9px] border border-dashed border-[var(--line)] px-2.5 py-3 text-center text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.jobs.empty')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {jobs.map((job) => {
        const line = jobLineOf(job)
        return (
          <li
            key={job.order_no}
            className="rounded-[9px] border border-[var(--line)] bg-white p-2 text-[11.5px]"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--text)]">
                {t('automation.harness.jobs.order', { orderNo: job.order_no })}
              </span>
              <StatusBadge label={t(line.stateKey)} tone={line.needsHuman ? 'warn' : 'neutral'} />
              {line.needsHuman && (
                <StatusBadge label={t('automation.harness.jobs.needsHuman')} tone="warn" />
              )}
            </div>
            <p className="mt-0.5 truncate text-[var(--text2)]">
              {[
                line.step,
                job.assignee_agent === null
                  ? ''
                  : t('automation.harness.jobs.agent', { agent: job.assignee_agent }),
                t('automation.harness.jobs.requester', { requester: job.requester }),
                job.attempts > 0 ? t('automation.harness.jobs.attempts', { n: job.attempts }) : ''
              ]
                .filter((s) => s !== '')
                .join(' · ')}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm typecheck && npx vitest run`
Expected: 타입 오류 0, 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/src/components/automation/VerdictCard.tsx src/renderer/src/components/automation/JobList.tsx src/renderer/src/i18n
git commit -m "추가: 판정 카드(여섯 조건·리포트·승인 안내)와 하네스 작업 목록"
```

---

### Task 9: 자동화 페이지 배선 + i18n 키 짝 테스트 + 실기 확인

**Files:**
- Create: `src/renderer/src/components/automation/HarnessPanel.tsx`
- Modify: `src/renderer/src/pages/AutomationPage.tsx` (플레이북 목록 `items.map(...)` 안)
- Test: `tests/harness-i18n.test.ts`

**Interfaces:**
- Produces: `export function HarnessPanel(): React.JSX.Element` — 접이식(기본 접힘). 펼치면 스토어 폴링을 시작하고 접으면 멈춘다.
- 붙는 자리: 내장 플레이북 `BUILTIN_UNFULFILLED_ID`("SAMBA 미이행 주문 처리") 카드 **바로 아래**(스펙 §4.4b). 다른 플레이북 아래에는 그리지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/harness-i18n.test.ts
// 처리 흐름·판정 카드 문구 — ko·en 키가 같고, 자리표시자도 같다
import { describe, it, expect } from 'vitest'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'
import { GATE_RULES, HARNESS_STAGES } from '@shared/harness'

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value }
  if (value === null || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flatten(child, prefix === '' ? key : `${prefix}.${key}`))
  }
  return out
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
}

const koFlat = flatten((ko as Record<string, unknown>).automation)
const enFlat = flatten((en as Record<string, unknown>).automation)

describe('하네스 화면 문구', () => {
  it('automation 아래 ko·en 키가 같다', () => {
    expect(Object.keys(enFlat).sort()).toEqual(Object.keys(koFlat).sort())
  })

  it('빈 문구가 없고 자리표시자가 같다', () => {
    for (const key of Object.keys(koFlat)) {
      expect(koFlat[key].trim(), key).not.toBe('')
      expect(enFlat[key].trim(), key).not.toBe('')
      expect(placeholders(enFlat[key]), key).toEqual(placeholders(koFlat[key]))
    }
  })

  it('단계·판정 조건 문구가 코드의 값과 하나씩 짝을 이룬다', () => {
    for (const stage of HARNESS_STAGES) {
      expect(koFlat[`harness.stage.${stage}`], stage).toBeTypeOf('string')
      expect(enFlat[`harness.stage.${stage}`], stage).toBeTypeOf('string')
    }
    for (const rule of GATE_RULES) {
      expect(koFlat[`harness.verdict.rule.${rule}`], rule).toBeTypeOf('string')
      expect(enFlat[`harness.verdict.rule.${rule}`], rule).toBeTypeOf('string')
    }
  })

  it('en 문구에는 한글이 없다', () => {
    for (const [key, text] of Object.entries(enFlat)) {
      expect(text, key).not.toMatch(/[가-힣]/)
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/harness-i18n.test.ts`
Expected: 이 시점에는 Task 5·7·8 의 문구가 이미 들어 있으므로, 빠진 키(예: `harness.title` 미기입·en 누락)가 있으면 FAIL. 전부 갖췄다면 PASS — 그때는 `automation.harness.title` 을 en.json 에서 잠시 지워 FAIL 을 확인하고 되돌린다.

- [ ] **Step 3: HarnessPanel 구현**

```tsx
// src/renderer/src/components/automation/HarnessPanel.tsx
// 플레이북 카드 아래 붙는 "처리 흐름" 패널 — 흐름 그래프 + 작업 목록 + 판정 카드.
//
// 기본은 접혀 있다. 펼칠 때만 하네스를 읽고(5초 폴링), 접으면 멈춘다 —
// 하네스가 꺼져 있어도 자동화 페이지는 그대로 쓸 수 있어야 하기 때문이다
import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { HarnessAgent } from '@shared/harness'
import { useHarnessStore } from '@renderer/stores/harnessStore'
import { SecondaryButton } from '@renderer/components/settings/shared'
import { connectionKeyOf } from './flowgraph-view'
import { FlowGraph } from './FlowGraph'
import { JobList } from './JobList'
import { RulesDialog } from './RulesDialog'
import { VerdictCard } from './VerdictCard'

export function HarnessPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<HarnessAgent | null>(null)
  const graph = useHarnessStore((s) => s.graph)
  const jobs = useHarnessStore((s) => s.jobs)
  const releases = useHarnessStore((s) => s.releases)
  const status = useHarnessStore((s) => s.status)
  const saving = useHarnessStore((s) => s.saving)
  const saveError = useHarnessStore((s) => s.saveError)
  const refresh = useHarnessStore((s) => s.refresh)
  const start = useHarnessStore((s) => s.start)
  const putRules = useHarnessStore((s) => s.putRules)

  useEffect(() => {
    if (!open) return
    return start()
  }, [open, start])

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text)]">
          {t('automation.harness.title')}
        </h2>
        {open && graph !== null && (
          <span className="truncate font-mono text-[11px] text-[var(--text2)]">
            {t('automation.harness.version', { version: graph.version })}
          </span>
        )}
        <SecondaryButton onClick={() => setOpen(!open)}>
          <span className="flex items-center gap-1.5">
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {t(open ? 'automation.harness.collapse' : 'automation.harness.expand')}
          </span>
        </SecondaryButton>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <p
              className={`min-w-0 flex-1 truncate text-[11.5px] ${
                status === 'ok' ? 'text-[var(--text2)]' : 'text-[#b45309]'
              }`}
            >
              {t(connectionKeyOf(status))}
            </p>
            <SecondaryButton onClick={() => void refresh()}>
              {t('automation.harness.refresh')}
            </SecondaryButton>
          </div>
          <p className="text-[11.5px] text-[var(--text2)]">{t('automation.harness.desc')}</p>

          {graph !== null && (
            <FlowGraph graph={graph} jobs={jobs} onEditRules={(agent) => setEditing(agent)} />
          )}

          <div>
            <h3 className="text-[12px] font-semibold text-[var(--text)]">
              {t('automation.harness.jobs.title')}
            </h3>
            <div className="mt-1.5">
              <JobList jobs={jobs} />
            </div>
          </div>

          {releases !== null && <VerdictCard releases={releases} />}
        </div>
      )}

      <RulesDialog
        agent={editing}
        open={editing !== null}
        saving={saving}
        error={saveError}
        onOpenChange={(v) => {
          if (!v) setEditing(null)
        }}
        onSave={(text) => putRules(editing?.name ?? '', text)}
      />
    </section>
  )
}
```

- [ ] **Step 4: 자동화 페이지에 붙이기**

`src/renderer/src/pages/AutomationPage.tsx` — import 추가:

```tsx
import { BUILTIN_UNFULFILLED_ID } from '@shared/playbook'
import { HarnessPanel } from '@renderer/components/automation/HarnessPanel'
```

`items.map((playbook) => (` 블록을 `<PlaybookCard .../>` 한 장 대신 조각으로 감싼다 — 하네스가 맡는 플레이북(내장 "SAMBA 미이행 주문 처리") 바로 아래에만 패널을 붙인다:

```tsx
        {items.map((playbook) => (
          <Fragment key={playbook.id}>
            <PlaybookCard
              playbook={playbook}
              /* …기존 props 그대로… */
            />
            {/* 하네스가 맡는 절차의 카드 아래에만 처리 흐름을 보인다(스펙 §4.4b) */}
            {playbook.id === BUILTIN_UNFULFILLED_ID && <HarnessPanel />}
          </Fragment>
        ))}
```

(`PlaybookCard` 의 `key` 는 `Fragment` 로 옮기고 카드에서는 지운다. 파일 위 `import { useEffect, useState } from 'react'` 를 `import { Fragment, useEffect, useState } from 'react'` 로 고친다.)

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run && pnpm typecheck && pnpm lint`
Expected: 전부 PASS, 타입·린트 오류 0

- [ ] **Step 6: 실기 확인(3가지 화면)**

1. 하네스를 켠 상태:

```bash
cd samba-agent && uv run python -m samba_agent
```

다른 창에서:

```bash
curl -s http://127.0.0.1:47812/graph
```
Expected: `{"version":"...","stages":["buy","pay","record","verify"],"agents":[{"name":"buyer.musinsa",...}]}`

앱 → 자동화 → "SAMBA 미이행 주문 처리" 카드 아래 [처리 흐름 보기] → 감독자 아래 네 열(구매·결제·기록·검증)과 에이전트 노드, "하네스에 연결됨", 작업 목록, 판정 카드가 보인다.

2. 하네스를 끈 상태: 패널에 "하네스 연결 안 됨 — 하네스가 꺼져 있어요"만 보이고 플레이북 카드는 그대로 쓰인다.

3. 잘못된 주소: 설정 → 동작 → 하네스 주소를 `http://10.0.0.5:47812` 로 바꾸고 [연결 확인] → 실패 문구. 자동화 페이지 패널은 "하네스 주소가 127.0.0.1 이 아니에요". 주소를 되돌린다.

4. 규칙 저장(외부 변경 — **사용자에게 먼저 묻고** 한다): 노드의 연필 → 경고 확인 → 아무 글 입력 → [저장] → [네, 저장합니다] → 모달이 닫히고 버전 표시가 새 값으로 바뀐다. 하네스 저장소에서 `git diff rules/` 로 파일이 바뀐 것을 확인한다.

- [ ] **Step 7: 커밋**

```bash
git add src/renderer/src/components/automation/HarnessPanel.tsx src/renderer/src/pages/AutomationPage.tsx tests/harness-i18n.test.ts
git commit -m "추가: 자동화 페이지에 처리 흐름 패널 배선(내장 절차 카드 아래, 접이식)과 하네스 문구 키 짝 테스트"
```

---

## 이 계획이 다루지 않는 것

- 규칙 파일의 **현재 내용 불러오기**: 하네스에 `GET /graph/rules/{agent}` 가 없다. 지금은 "전체 교체"로 동작하고 모달이 그 사실을 경고한다. 하네스에 읽기 엔드포인트가 생기면 IPC `harness:rules` 하나를 더해 모달을 채우면 된다(별도 작업).
- 진단 표(`ops/reports/<version>.diagnose.md`) 열기: API 로 오지 않는다(파일만 있다). 필요해지면 하네스가 `/releases` 에 함께 실어 주는 쪽이 맞다.
- 판정 이력(`releases.history`) 표: 지금은 운영 버전·후보 버전만 보인다(YAGNI).
- 앱에서의 승격·승인·롤백: 하지 않는다(스펙 §4.5 6번·§10-4).
- 실기 주문 처리(스펙 §7 ⑥)와 프롬프트 허브 `prod` 태그 이동: 사람이 한다.

## Self-review

**스펙 커버리지**
- §4.4b "플레이북 카드 바로 아래 감독자 → 전문 에이전트 그래프" → Task 5·7·9(내장 절차 카드 아래, `BUILTIN_UNFULFILLED_ID`).
- §4.4b "`GET /graph`·`GET /jobs` 를 5초마다 읽어 현재 위치를 색으로" → Task 6(`HARNESS_POLL_MS`), Task 5(`nodeStatusOf`).
- §4.4b "에이전트 클릭 → 규칙 파일 편집(`PUT /graph/rules/{agent}`), 저장 전 확인 카드, 새 버전 안내" → Task 7(2단계 확인 + `newVersion` 문구).
- §4.4b "판정 카드 = 운영 버전·후보·조건 6개·진단 상위 사유. 승인 버튼은 두지 않는다" → Task 8(`GATE_RULES` 6개 + `todo` + 승인 안내만).
- §4.5 4단계 판정 키 6개 → `src/shared/harness.ts` `GATE_RULES` 가 `ops/gate.py` 와 같은 순서·이름.
- §7 검증 축(성공/실패/재시도·시간 초과/중복/권한 부족) → Task 3 테스트 8건(성공·offline·timeout·JSON 아님·401·404·비로컬 주소·PUT 본문), Task 6(폴링 중복 방지·저장 중 재저장 차단).
- §10-1(외부 변경 전 사용자 검토) → 규칙 저장 2단계 확인 + 실기 Step 6-4 에 "사용자에게 먼저 묻고".
- §10-4(자동 승격 없음) → 앱에 승격·승인 동작 없음. 명령 복사만.

**placeholder 점검**: 모든 코드 블록은 실제 파일에 그대로 넣을 수 있는 내용이다. 단 하나 `AutomationPage.tsx` Step 4 의 `/* …기존 props 그대로… */` 는 지금 파일에 있는 16개 prop 을 옮겨 쓰라는 표시다(추가·삭제 없음).

**이름 일관성**: 설정 `harnessApiUrl` · IPC `harness:graph|jobs|releases|putRules` · 모듈 `src/main/harness/{client,wiring}.ts` · 공유 `src/shared/harness.ts` · 렌더러 `stores/harnessStore.ts`·`components/automation/{flowgraph-view.ts,FlowGraph.tsx,JobList.tsx,VerdictCard.tsx,RulesDialog.tsx,HarnessPanel.tsx}` · i18n `automation.harness.*`(화면)·`settingsPage.behavior.harness*`(설정). 상태값 이름은 클라이언트 `HarnessStatus` 하나를 메인·렌더러가 함께 쓴다.

**남는 위험**: `HarnessStatus` 를 렌더러가 `../../../main/harness/client` 에서 타입으로만 가져온다(값이 아니라 타입이라 번들에는 들어가지 않는다). 타입 체크가 경로를 싫어하면 `src/shared/harness.ts` 로 옮기고 클라이언트가 그것을 가져다 쓰도록 바꾼다 — 이름은 그대로 둔다.
