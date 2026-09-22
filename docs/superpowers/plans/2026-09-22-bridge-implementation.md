# SAMBA Browser 브릿지 구현 계획 (하네스 1/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SAMBA Browser 가 이미 가진 에이전트 도구(페이지 읽기·클릭·run_js·저장 스크립트·키마스터·폰 결제)를 로컬 HTTP 로 열어, 밖의 LangGraph 하네스가 "손발"로 쓸 수 있게 한다.

**Architecture:** `AgentRunner` 가 채팅 실행에 쓰는 도구 문맥(ToolContext) 조립을 메서드로 뽑아 재사용하고, 그 위에 "도구 세션"(이름으로 도구를 부르는 객체)을 만든다. `src/main/bridge/server.ts` 가 127.0.0.1 전용 Node `http` 서버로 `POST /tool/{name}` 을 받아 세션에 넘긴다. 토큰은 설정에 저장되고 헤더 `X-Samba-Token` 으로 검사한다. 채팅 실행과 브릿지 세션은 동시에 돌지 않는다(한 손발).

**Tech Stack:** Electron 39 main 프로세스, Node `http`, zod(설정 스키마), vitest.

## Global Constraints

- 브릿지는 `127.0.0.1` 에만 바인딩한다. 외부 인터페이스 바인딩 금지(스펙 §4.4).
- 인증 헤더 `X-Samba-Token`. 토큰은 32바이트 랜덤(hex 64자). 설정 키 `bridgeToken` 은 동기화 대상이 아니다.
- 기본 포트 `47811`(스펙 §4.4). 설정 키 `bridgePort`, 기본 꺼짐 `bridgeEnabled: false`.
- 브릿지 응답에 비밀값(비밀번호·토큰·키패드 값)을 절대 싣지 않는다 — 기존 도구가 돌려주는 문자열을 그대로 쓴다(도구가 이미 값을 안 돌려준다).
- 도구 호출 1건 제한 시간 90초(기존 `withToolTimeout` 과 같다). 채팅 실행 중이면 `409`.
- 코드 주석·커밋 메시지는 한국어. 들여쓰기 2칸, 세미콜론 없음, 작은따옴표.
- 테스트는 `tests/` 에 vitest. 전체 `npx vitest run` 이 통과해야 커밋한다.
- 진행 규칙(스펙 §10): 외부 시스템 변경 전 사용자 검토 / 단계마다 완료 조건·진입 조건 구분 / 실패·재시도·중복·권한 부족 검증. 이 계획(브릿지)은 외부 시스템을 바꾸지 않는다 — 앱 안의 로컬 문만 연다.

## 완료 조건 / 다음 단계 진입 조건
- 완료 조건: Task 1~5 전부 커밋, `npx vitest run` 전부 통과, curl 실기 3건(health·list_tabs·401) 확인.
- 다음 단계(하네스 2/3) 진입 조건: 완료 조건 + 사용자가 설정에서 브릿지를 켜고 `health` 응답을 직접 확인. 외부 시스템 변경 없음.
- 검증 범위: 성공(도구 호출) / 실패(없는 도구·JSON 오류·도구 예외) / 재시도·시간 초과(90초 뒤 세션 정리) / 중복(동시 요청 두 번째 409, 채팅 실행 중 409) / 권한 부족(토큰 없음·틀림 401).

---

### Task 1: 설정 키 3개 (bridgeEnabled · bridgePort · bridgeToken)

**Files:**
- Modify: `src/shared/settings.ts` (DEFAULT_SETTINGS 의 `agentSound: false,` 다음, 스키마의 `agentSound: z.boolean()...` 다음)
- Test: `tests/bridge-settings.test.ts`

**Interfaces:**
- Produces: `Settings.bridgeEnabled: boolean`, `Settings.bridgePort: number`, `Settings.bridgeToken: string`. `SYNCED_SETTING_KEYS` 에 넣지 않는다(기기 고유값).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/bridge-settings.test.ts
// 브릿지 설정 키 — 기본 꺼짐, 포트 범위 검사, 토큰은 이 PC 에만 남는다
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

describe('브릿지 설정', () => {
  it('기본값은 꺼짐·47811·빈 토큰', () => {
    expect(DEFAULT_SETTINGS.bridgeEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.bridgePort).toBe(47811)
    expect(DEFAULT_SETTINGS.bridgeToken).toBe('')
  })

  it('깨진 값은 기본값으로 돌아간다(포트 범위 1024~65535)', () => {
    const s = parseSettings({ ...DEFAULT_SETTINGS, bridgePort: 80, bridgeEnabled: 'yes', bridgeToken: 42 })
    expect(s.bridgePort).toBe(47811)
    expect(s.bridgeEnabled).toBe(false)
    expect(s.bridgeToken).toBe('')
  })

  it('토큰·포트·켬은 동기화 대상이 아니다(이 PC 고유값)', () => {
    const synced: readonly string[] = SYNCED_SETTING_KEYS
    for (const key of ['bridgeEnabled', 'bridgePort', 'bridgeToken']) expect(synced).not.toContain(key)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/bridge-settings.test.ts`
Expected: FAIL — `bridgeEnabled` 가 undefined

- [ ] **Step 3: 설정 키 추가**

`src/shared/settings.ts` 의 `DEFAULT_SETTINGS` 에서 `agentSound: false,` 바로 아래에:

```ts
  // === 하네스 브릿지 ==========================================================
  // 밖의 LangGraph 하네스가 이 앱의 도구를 HTTP 로 부르게 여는 문. 기본 꺼짐.
  // 포트·토큰은 이 PC 의 값이라 동기화하지 않는다(SYNCED_SETTING_KEYS 에 없음)
  bridgeEnabled: false,
  bridgePort: 47811,
  // 32바이트 hex. 비어 있으면 켤 때 만든다
  bridgeToken: '',
```

스키마(`agentSound: z.boolean().catch(DEFAULT_SETTINGS.agentSound),` 바로 아래)에:

```ts
  bridgeEnabled: z.boolean().catch(DEFAULT_SETTINGS.bridgeEnabled),
  bridgePort: z.number().int().min(1024).max(65535).catch(DEFAULT_SETTINGS.bridgePort),
  bridgeToken: z.string().max(128).catch(DEFAULT_SETTINGS.bridgeToken),
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/bridge-settings.test.ts tests/settings*.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/shared/settings.ts tests/bridge-settings.test.ts
git commit -m "추가: 하네스 브릿지 설정 키(bridgeEnabled·bridgePort·bridgeToken) — 기본 꺼짐, 기기 고유값"
```

---

### Task 2: AgentRunner 도구 세션 — 문맥 조립 메서드 추출 + `createToolSession`

**Files:**
- Modify: `src/main/agent/runner.ts`
  - `run()` 안의 `const server = createSambaTools({ ... })` 인자 객체(현재 `tabs: this.tabs,` 부터 `pay: ... : undefined` 까지)를 `private buildToolContext(...)` 로 옮긴다
  - `createToolSession()`·`ToolSession` 추가, `run()` 첫머리에 세션 활성 검사 추가
- Test: `tests/agent-tool-session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ToolSession {
    /** 부를 수 있는 도구 이름 */
    names(): string[]
    /** 도구 1건 호출. 도구가 돌려주는 본문 문자열. 없는 이름이면 throw */
    call(name: string, args: Record<string, unknown>): Promise<string>
    /** 세션 종료 — 이후 채팅 실행이 다시 가능해진다 */
    dispose(): void
  }
  AgentRunner.createToolSession(opts: { onStep?: (label: string, ok: boolean) => void }): ToolSession
  ```
- 세션이 살아 있는 동안 `run()` 은 `Error('브릿지 세션 사용 중')` 를 던진다. 채팅 실행 중(`this.abort` 있음)에는 `createToolSession()` 이 `Error('이미 실행 중')` 을 던진다.
- 세션 문맥: `mode: 'full'`, `finalConfirm: false`, `confirm: async () => true`(하네스가 이미 판단), `handoff: async (req) => ({ outcome: 'skipped', url: req.currentUrl() })`(캡차 등은 하네스가 `needs_human` 으로 처리), `tick: () => null`(상한 없음), `jobId: randomUUID()`.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/agent-tool-session.test.ts
// 브릿지가 쓰는 도구 세션 — 채팅 실행과 겹치지 않고, 도구를 이름으로 부른다
import { describe, it, expect, vi } from 'vitest'
import { AgentRunner } from '../src/main/agent/runner'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { SettingsStore } from '../src/main/settings/store'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

vi.mock('../src/main/browser/page-bridge', () => ({
  pageBridge: {
    snapshot: vi.fn(async () => ({ url: 'https://a.test/', title: 'A', text: '본문', elements: [] })),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    rectOf: vi.fn(async () => null),
    overlays: vi.fn(async () => [])
  }
}))

function runner(): AgentRunner {
  const tabs = {
    active: () => ({ id: 't1', view: { webContents: { getURL: () => 'https://a.test/', isDestroyed: () => false } } }),
    list: () => [],
    listTargets: () => [],
    create: vi.fn(),
    activate: vi.fn(),
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const settings = { get: () => ({ ...DEFAULT_SETTINGS }) } as unknown as SettingsStore
  return new AgentRunner(tabs, settings, () => {})
}

describe('createToolSession', () => {
  it('도구 이름 목록을 주고, 없는 이름은 거부한다', async () => {
    const s = runner().createToolSession({})
    expect(s.names()).toContain('get_page')
    expect(s.names()).toContain('run_js')
    expect(s.names()).not.toContain('done')
    await expect(s.call('없는_도구', {})).rejects.toThrow('unknown tool')
    s.dispose()
  })

  it('세션이 살아 있는 동안 채팅 실행은 거부되고, 닫으면 풀린다', async () => {
    const r = runner()
    const s = r.createToolSession({})
    await expect(r.run('아무 지시')).rejects.toThrow('브릿지 세션 사용 중')
    s.dispose()
    // dispose 뒤에는 세션 검사에 걸리지 않는다(실제 실행은 연결이 없어 다른 이유로 끝난다)
    await expect(r.createToolSession({})).not.toThrow
  })

  it('도구 호출은 진행 로그를 onStep 으로 넘긴다', async () => {
    const steps: string[] = []
    const s = runner().createToolSession({ onStep: (label) => steps.push(label) })
    const out = await s.call('get_page', {})
    expect(typeof out).toBe('string')
    expect(steps.some((l) => l.includes('페이지 읽기'))).toBe(true)
    s.dispose()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/agent-tool-session.test.ts`
Expected: FAIL — `createToolSession is not a function`

- [ ] **Step 3: 문맥 조립을 메서드로 추출**

`src/main/agent/runner.ts` 에서 `const server = createSambaTools({` 로 시작해 `})` 로 끝나는 인자 객체 전체를 잘라 아래 메서드로 옮긴다(객체 내용은 그대로, 바깥 지역변수를 인자로 받는다). `run()` 쪽은 다음 한 줄로 바꾼다:

```ts
    const server = createSambaTools(
      this.buildToolContext({
        s,
        jobId,
        tick: counter.tick,
        emit,
        confirm: (action, kind = 'danger') => this.requestConfirm(action, kind, emit),
        handoff: (req) => this.requestHandoff(req, emit),
        onCall: (call) => calls.push(call),
        onRunJs: (run) => runJsLog.push(run),
        scripts,
        phoneCtx,
        waitSms,
        runPay,
        prompt
      })
    )
```

클래스 안에 추가하는 메서드(기존 객체 리터럴을 그대로 붙이되 `s`·`jobId`·`counter.tick`·`emit`·`calls`·`runJsLog`·`scripts`·`phones`·`prompt` 참조를 인자로 바꾼다):

```ts
  /**
   * 도구 서버에 넘길 문맥. 채팅 실행(run)과 브릿지 세션(createToolSession)이 같은 조립을 쓴다 —
   * 차이는 인자(권한 모드·확인 카드·상한)뿐이다
   */
  private buildToolContext(o: {
    s: Settings
    jobId: string
    tick: () => string | null
    emit: (e: AgentEvent) => void
    confirm: ToolContext['confirm']
    handoff: NonNullable<ToolContext['handoff']>
    onCall: (call: AgentToolCall) => void
    onRunJs: NonNullable<ToolContext['onRunJs']>
    scripts: SiteScriptStore | null
    phoneCtx: () => PhoneRunContext
    waitSms: (host?: string) => Promise<SmsCodeOutcome>
    runPay: (req: PayToolRequest) => Promise<PayResult>
    prompt: string
  }): ToolContext {
    const { s, jobId, tick, emit, scripts, phoneCtx, waitSms, runPay, prompt } = o
    const phones = this.phones
    void phoneCtx
    return {
      tabs: this.tabs,
      vault: this.vault,
      jobId,
      dangerWords: s.dangerWords,
      mode: s.permissionMode,
      finalConfirm: s.finalConfirm,
      vaultAccessPolicy: s.vaultAccessPolicy,
      vaultAutoSubmit: s.vaultAutoSubmit,
      vaultKeepSignedIn: s.vaultKeepSignedIn,
      vaultExcludedHosts: s.vaultExcludedHosts,
      tick,
      onStep: (label, ok) => emit({ type: 'step', label, ok }),
      onCall: o.onCall,
      onRunJs: o.onRunJs,
      siteMemory: this.siteMemory
        ? { remember: (host, note) => this.siteMemory?.remember(host, note) ?? '' }
        : undefined,
      scripts: scripts
        ? {
            find: (name) => scripts.find(name),
            save: (input) => scripts.save(input),
            ran: (name, ok) => scripts.ran(name, ok)
          }
        : undefined,
      playbooks: this.playbookEditor
        ? {
            list: () => this.playbookEditor?.list() ?? [],
            update: (id, instructions) =>
              this.playbookEditor?.setInstructions(id, instructions) ?? null
          }
        : undefined,
      onProgress: ({ done, total, label }) =>
        emit(
          label === undefined
            ? { type: 'progress', kind: 'task', done, total }
            : { type: 'progress', kind: 'task', done, total, label }
        ),
      confirm: o.confirm,
      handoff: o.handoff,
      phone: phones
        ? {
            phones: phones.phones,
            assigned: phones.assigned,
            mode: s.permissionMode,
            tick,
            onStep: (label, ok) => emit({ type: 'step', label, ok }),
            confirm: o.confirm,
            ...(phones.waitForSmsCode === undefined
              ? {}
              : { waitForSmsCode: (host?: string) => waitSms(host) })
          }
        : undefined,
      pay:
        phones && phones.approvePayment
          ? {
              tick,
              onStep: (label, ok) => emit({ type: 'step', label, ok }),
              run: (req) => runPay(req),
              ...(cardNamedIn(prompt) === undefined ? {} : { requiredCard: cardNamedIn(prompt) })
            }
          : undefined
    }
  }
```

(기존 `pay` 블록에 `requiredCard` 가 이미 있으니 그대로 옮긴다. `import type { ToolContext } from './tools'` 와 `import type { Settings } from '../../shared/settings'` 를 파일 위에 추가한다.)

- [ ] **Step 4: 세션 추가**

`runner.ts` 의 `run()` 첫머리 `if (this.abort) {` 앞에:

```ts
    if (this.session) throw new Error('브릿지 세션 사용 중')
```

클래스 필드에 `private session: ToolSession | null = null` 를, 파일 위에 타입을 추가한다:

```ts
/** 브릿지가 쓰는 도구 세션. 채팅 실행과 같은 도구를 이름으로 부른다(한 손발이라 동시에 못 돈다) */
export interface ToolSession {
  names(): string[]
  call(name: string, args: Record<string, unknown>): Promise<string>
  dispose(): void
}
```

메서드:

```ts
  /**
   * 밖의 하네스가 쓰는 도구 세션. 권한은 full, 확인 카드는 자동 승인(판단은 하네스가 했다),
   * 캡차·2단계 인증 같은 넘김은 즉시 skipped 로 돌려 하네스가 needs_human 으로 처리하게 한다.
   * 채팅 실행이 도는 동안은 만들 수 없고, 세션이 있는 동안 채팅 실행은 거부된다
   */
  createToolSession(opts: { onStep?: (label: string, ok: boolean) => void }): ToolSession {
    if (this.abort) throw new Error('이미 실행 중')
    if (this.session) throw new Error('브릿지 세션 사용 중')
    const s = this.settings.get()
    const jobId = randomUUID()
    const emit = (e: AgentEvent): void => {
      if (e.type === 'step') opts.onStep?.(e.label, e.ok)
    }
    const phones = this.phones
    const phoneCtx = (): PhoneRunContext => ({
      jobId,
      confirm: async () => true,
      onStep: (label, ok) => emit({ type: 'step', label, ok }),
      handoff: async (req) => ({ outcome: 'skipped', url: req.currentUrl() }),
      cancelled: () => false
    })
    const server = createSambaTools(
      this.buildToolContext({
        s: { ...s, permissionMode: 'full', finalConfirm: false },
        jobId,
        tick: () => null,
        emit,
        confirm: async () => true,
        handoff: async (req) => ({ outcome: 'skipped', url: req.currentUrl() }),
        onCall: () => {},
        onRunJs: () => {},
        scripts: this.siteScripts,
        phoneCtx,
        waitSms: (host) =>
          phones?.waitForSmsCode
            ? phones.waitForSmsCode(phoneCtx(), host)
            : Promise.resolve({ filled: false, digits: 0 }),
        runPay: (req) =>
          phones?.approvePayment
            ? phones.approvePayment(phoneCtx(), req)
            : Promise.resolve({ ok: false, reason: 'declined' as const }),
        prompt: ''
      })
    )
    const tools = (server as unknown as { tools: SdkToolLike[] }).tools.filter((t) => t.name !== 'done')
    const session: ToolSession = {
      names: () => tools.map((t) => t.name),
      call: async (name, args) => {
        const t = tools.find((x) => x.name === name)
        if (!t) throw new Error(`unknown tool: ${name}`)
        const r = await t.handler(args, {})
        return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      },
      dispose: () => {
        if (this.session === session) this.session = null
      }
    }
    this.session = session
    return session
  }
```

파일 위에 도구 모양 타입:

```ts
// SDK 도구 객체에서 브릿지가 쓰는 부분만(이름·핸들러)
interface SdkToolLike {
  name: string
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run tests/agent-tool-session.test.ts && pnpm typecheck`
Expected: PASS, 타입 오류 0

- [ ] **Step 6: 전체 테스트 후 커밋**

Run: `npx vitest run`
Expected: 전부 PASS

```bash
git add src/main/agent/runner.ts tests/agent-tool-session.test.ts
git commit -m "추가: 실행기 도구 세션(createToolSession) — 브릿지가 채팅과 같은 도구를 이름으로 부른다, 문맥 조립을 buildToolContext 로 추출"
```

---

### Task 3: 브릿지 HTTP 서버 (`src/main/bridge/server.ts`)

**Files:**
- Create: `src/main/bridge/server.ts`
- Test: `tests/bridge-server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BridgeDeps {
    /** 세션을 만든다. 채팅 실행 중이면 throw('이미 실행 중') */
    openSession: (onStep: (label: string, ok: boolean) => void) => ToolSession
    token: () => string
    /** 도구 1건 제한 시간(ms). 기본 90000 */
    toolTimeoutMs?: number
  }
  export class BridgeServer {
    constructor(deps: BridgeDeps)
    /** 127.0.0.1:port 에서 듣는다. 이미 듣고 있으면 먼저 닫는다 */
    start(port: number): Promise<number>   // 실제 포트
    stop(): Promise<void>
    listening(): boolean
  }
  ```
- HTTP 규약:
  - 모든 요청에 `X-Samba-Token` 필요. 틀리면 `401 {"error":"unauthorized"}`.
  - `GET /health` → `200 {"ok":true,"tools":[...이름]}`(세션을 잠깐 열었다 닫는다. 채팅 실행 중이면 `409 {"error":"busy"}`).
  - `POST /tool/{name}` 본문 `{"args":{...}}` → `200 {"ok":true,"result":"<도구 본문>","steps":[{"label","ok"}]}`. 없는 도구 `404`, 도구 throw `500 {"ok":false,"error":"..."}`, 제한 시간 `504`, 채팅 실행 중 `409`.
  - 요청마다 세션을 열고 응답 뒤 닫는다(하네스는 요청 사이에 채팅 UI 를 쓸 수 있다). 동시 요청은 두 번째가 `409 {"error":"busy"}`.
  - 본문 1MB 초과 `413`. JSON 아니면 `400`.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/bridge-server.test.ts
// 브릿지 HTTP — 토큰·라우팅·busy·제한 시간
import { describe, it, expect, afterEach } from 'vitest'
import { BridgeServer } from '../src/main/bridge/server'
import type { ToolSession } from '../src/main/agent/runner'

const TOKEN = 'a'.repeat(64)

function fakeSession(opts: { slowMs?: number; fail?: boolean } = {}): {
  make: (onStep: (l: string, ok: boolean) => void) => ToolSession
  disposed: () => number
} {
  let disposed = 0
  return {
    disposed: () => disposed,
    make: (onStep) => ({
      names: () => ['get_page', 'click'],
      call: async (name, args) => {
        if (name === 'click') onStep(`클릭: ${String(args.id)}`, true)
        if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs))
        if (opts.fail) throw new Error('boom')
        return `${name} 결과`
      },
      dispose: () => {
        disposed += 1
      }
    })
  }
}

let server: BridgeServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
})

async function up(deps: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<string> {
  const fs = fakeSession()
  server = new BridgeServer({ openSession: fs.make, token: () => TOKEN, ...deps })
  const port = await server.start(0)
  return `http://127.0.0.1:${port}`
}

const H = { 'X-Samba-Token': TOKEN, 'content-type': 'application/json' }

describe('BridgeServer', () => {
  it('토큰이 없거나 틀리면 401', async () => {
    const base = await up()
    expect((await fetch(`${base}/health`)).status).toBe(401)
    expect((await fetch(`${base}/health`, { headers: { 'X-Samba-Token': 'wrong' } })).status).toBe(401)
  })

  it('health 는 도구 이름을 준다', async () => {
    const base = await up()
    const r = await fetch(`${base}/health`, { headers: H })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, tools: ['get_page', 'click'] })
  })

  it('도구를 부르고 진행 로그를 함께 돌려주며, 요청마다 세션을 닫는다', async () => {
    const fs = fakeSession()
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/click`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ args: { id: 7 } })
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, result: 'click 결과', steps: [{ label: '클릭: 7', ok: true }] })
    expect(fs.disposed()).toBe(1)
  })

  it('없는 도구 404, 도구 오류 500, JSON 아님 400', async () => {
    const base = await up()
    expect((await fetch(`${base}/tool/nope`, { method: 'POST', headers: H, body: '{"args":{}}' })).status).toBe(404)
    expect((await fetch(`${base}/tool/get_page`, { method: 'POST', headers: H, body: '{not json' })).status).toBe(400)
    const fs = fakeSession({ fail: true })
    await server?.stop()
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/get_page`, { method: 'POST', headers: H, body: '{"args":{}}' })
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ ok: false, error: 'boom' })
  })

  it('채팅 실행 중이면 409, 동시 요청도 두 번째는 409', async () => {
    server = new BridgeServer({
      openSession: () => {
        throw new Error('이미 실행 중')
      },
      token: () => TOKEN
    })
    let port = await server.start(0)
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers: H })).status).toBe(409)
    await server.stop()
    const fs = fakeSession({ slowMs: 300 })
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN })
    port = await server.start(0)
    const a = fetch(`http://127.0.0.1:${port}/tool/get_page`, { method: 'POST', headers: H, body: '{"args":{}}' })
    await new Promise((r) => setTimeout(r, 50))
    const b = await fetch(`http://127.0.0.1:${port}/tool/get_page`, { method: 'POST', headers: H, body: '{"args":{}}' })
    expect(b.status).toBe(409)
    expect((await a).status).toBe(200)
  })

  it('제한 시간을 넘기면 504 로 끝내고 세션을 닫는다', async () => {
    const fs = fakeSession({ slowMs: 500 })
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN, toolTimeoutMs: 100 })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/get_page`, { method: 'POST', headers: H, body: '{"args":{}}' })
    expect(r.status).toBe(504)
    expect(fs.disposed()).toBe(1)
  })

  it('127.0.0.1 에만 바인딩한다', async () => {
    const base = await up()
    const port = Number(new URL(base).port)
    const addr = (server as unknown as { address: () => { address: string } }).address()
    expect(addr.address).toBe('127.0.0.1')
    expect(port).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/bridge-server.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 서버 구현**

```ts
// src/main/bridge/server.ts
// 하네스 브릿지 — 밖의 LangGraph 하네스가 이 앱의 도구를 HTTP 로 부르는 문.
//
// 규칙
// - 127.0.0.1 에만 바인딩한다. 외부에서는 닿을 수 없다
// - 모든 요청은 X-Samba-Token 이 설정의 토큰과 같아야 한다(길이가 같을 때만 상수 시간 비교)
// - 요청마다 도구 세션을 열고 닫는다. 채팅 실행이 도는 중이거나 다른 요청이 도는 중이면 409
// - 응답에 비밀값은 없다 — 도구가 돌려주는 본문 그대로다(도구가 값을 돌려주지 않는다)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { ToolSession } from '../agent/runner'

export interface BridgeDeps {
  openSession: (onStep: (label: string, ok: boolean) => void) => ToolSession
  token: () => string
  toolTimeoutMs?: number
}

const DEFAULT_TOOL_TIMEOUT_MS = 90_000
const MAX_BODY_BYTES = 1024 * 1024

export class BridgeServer {
  private server: Server | null = null
  /** 지금 도구를 돌리는 중인가 — 한 손발이라 동시에 하나만 */
  private busy = false

  constructor(private readonly deps: BridgeDeps) {}

  listening(): boolean {
    return this.server?.listening === true
  }

  address(): { address: string; port: number } | null {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { address: a.address, port: a.port } : null
  }

  async start(port: number): Promise<number> {
    await this.stop()
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const a = server.address()
    return a && typeof a === 'object' ? a.port : port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private authorized(req: IncomingMessage): boolean {
    const given = req.headers['x-samba-token']
    const expected = this.deps.token()
    if (typeof given !== 'string' || expected === '' || given.length !== expected.length) return false
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) return json(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') return this.health(res)
    const m = /^\/tool\/([a-z_]+)$/.exec(url.pathname)
    if (req.method === 'POST' && m) return this.tool(m[1], req, res)
    return json(res, 404, { error: 'not found' })
  }

  private async health(res: ServerResponse): Promise<void> {
    if (this.busy) return json(res, 409, { error: 'busy' })
    let session: ToolSession
    try {
      session = this.deps.openSession(() => {})
    } catch {
      return json(res, 409, { error: 'busy' })
    }
    try {
      json(res, 200, { ok: true, tools: session.names() })
    } finally {
      session.dispose()
    }
  }

  private async tool(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.busy) return json(res, 409, { error: 'busy' })
    let body: string
    try {
      body = await readBody(req)
    } catch {
      return json(res, 413, { error: 'body too large' })
    }
    let args: Record<string, unknown>
    try {
      const parsed: unknown = body.trim() === '' ? {} : JSON.parse(body)
      const a = (parsed as { args?: unknown }).args
      args = a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
    } catch {
      return json(res, 400, { error: 'invalid json' })
    }
    const steps: Array<{ label: string; ok: boolean }> = []
    let session: ToolSession
    try {
      session = this.deps.openSession((label, ok) => steps.push({ label, ok }))
    } catch {
      return json(res, 409, { error: 'busy' })
    }
    if (!session.names().includes(name)) {
      session.dispose()
      return json(res, 404, { error: `unknown tool: ${name}` })
    }
    this.busy = true
    const timeoutMs = this.deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        session.call(name, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BridgeTimeout()), timeoutMs)
        })
      ])
      json(res, 200, { ok: true, result, steps })
    } catch (e: unknown) {
      if (e instanceof BridgeTimeout) json(res, 504, { ok: false, error: 'tool timeout', steps })
      else json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e), steps })
    } finally {
      if (timer) clearTimeout(timer)
      session.dispose()
      this.busy = false
    }
  }
}

class BridgeTimeout extends Error {}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/bridge-server.test.ts && pnpm typecheck`
Expected: PASS(7), 타입 오류 0

- [ ] **Step 5: 커밋**

```bash
git add src/main/bridge/server.ts tests/bridge-server.test.ts
git commit -m "추가: 하네스 브릿지 HTTP 서버 — 127.0.0.1 전용, 토큰 검사, 요청마다 도구 세션, busy 409, 90초 제한"
```

---

### Task 4: 배선 + 설정 화면(동작 섹션 카드) + 토큰 재발급 IPC

**Files:**
- Modify: `src/main/ipc/handlers.ts` (AgentRunner 생성 뒤; `IPC.settingsSet` 핸들러 안 `const s = settings.set(patch)` 다음)
- Modify: `src/shared/ipc.ts` (채널 추가)
- Modify: `src/preload/renderer.ts` (`settings:` 객체 옆에 `bridge:` 추가)
- Modify: `src/renderer/src/components/settings/AgentSection.tsx` (맨 아래 카드 추가)
- Modify: `src/renderer/src/i18n/ko.json`, `en.json` (`settingsPage.behavior` 아래 키)
- Test: `tests/bridge-wiring.test.ts`

**Interfaces:**
- IPC `bridge:regenerateToken` → `IpcResult<{ token: string }>`(새 토큰 저장 후 반환. 화면에서 복사 버튼용. 토큰은 설정에도 있으니 설정 읽기로도 보인다)
- 순수 함수 `applyBridgeSettings(server, s)`: `bridgeEnabled` 면 `bridgeToken` 이 비었을 때 생성(설정에 저장)하고 `start(bridgePort)`, 꺼졌으면 `stop()`. 포트가 바뀌면 재시작.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// tests/bridge-wiring.test.ts
// 설정에 따라 브릿지를 켜고 끄고, 토큰이 없으면 만든다
import { describe, it, expect, vi } from 'vitest'
import { applyBridgeSettings, newBridgeToken } from '../src/main/bridge/wiring'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

function fakeServer(): { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; listening: () => boolean; port: number | null } {
  const s = {
    port: null as number | null,
    start: vi.fn(async (p: number) => {
      s.port = p
      return p
    }),
    stop: vi.fn(async () => {
      s.port = null
    }),
    listening: () => s.port !== null
  }
  return s
}

describe('applyBridgeSettings', () => {
  it('켜면 토큰을 만들어 저장하고 그 포트로 듣는다', async () => {
    const server = fakeServer()
    const saved: Record<string, unknown>[] = []
    await applyBridgeSettings(server, { ...DEFAULT_SETTINGS, bridgeEnabled: true }, (p) => saved.push(p))
    expect(server.start).toHaveBeenCalledWith(47811)
    expect(saved).toHaveLength(1)
    expect(String(saved[0].bridgeToken)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('토큰이 이미 있으면 다시 만들지 않는다', async () => {
    const server = fakeServer()
    const saved: unknown[] = []
    await applyBridgeSettings(server, { ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }, (p) => saved.push(p))
    expect(saved).toHaveLength(0)
  })

  it('끄면 멈추고, 포트가 바뀌면 다시 듣는다', async () => {
    const server = fakeServer()
    await applyBridgeSettings(server, { ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }, () => {})
    await applyBridgeSettings(server, { ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64), bridgePort: 47900 }, () => {})
    expect(server.start).toHaveBeenLastCalledWith(47900)
    await applyBridgeSettings(server, { ...DEFAULT_SETTINGS, bridgeEnabled: false, bridgeToken: 'f'.repeat(64) }, () => {})
    expect(server.stop).toHaveBeenCalled()
    expect(server.listening()).toBe(false)
  })

  it('새 토큰은 64자 hex 다', () => {
    expect(newBridgeToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(newBridgeToken()).not.toBe(newBridgeToken())
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/bridge-wiring.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 배선 모듈**

```ts
// src/main/bridge/wiring.ts
// 설정(bridgeEnabled·bridgePort·bridgeToken) → 브릿지 서버 켜기/끄기. handlers 가 설정이 바뀔 때마다 부른다
import { randomBytes } from 'node:crypto'
import type { Settings } from '../../shared/settings'

export interface BridgeServerLike {
  start: (port: number) => Promise<number>
  stop: () => Promise<void>
  listening: () => boolean
}

/** 32바이트 랜덤 → hex 64자 */
export function newBridgeToken(): string {
  return randomBytes(32).toString('hex')
}

let currentPort: number | null = null

/**
 * 설정을 서버에 반영한다. 켜져 있는데 토큰이 없으면 만들어 저장(save)한다.
 * 포트가 바뀌었으면 다시 듣고, 꺼져 있으면 멈춘다
 */
export async function applyBridgeSettings(
  server: BridgeServerLike,
  s: Pick<Settings, 'bridgeEnabled' | 'bridgePort' | 'bridgeToken'>,
  save: (patch: { bridgeToken: string }) => void
): Promise<void> {
  if (!s.bridgeEnabled) {
    if (server.listening()) await server.stop()
    currentPort = null
    return
  }
  if (s.bridgeToken === '') save({ bridgeToken: newBridgeToken() })
  if (server.listening() && currentPort === s.bridgePort) return
  try {
    await server.start(s.bridgePort)
    currentPort = s.bridgePort
  } catch (e: unknown) {
    // 포트가 이미 쓰이는 등 — 사유만 남기고 앱은 계속 돈다
    console.error('브릿지 시작 실패', e instanceof Error ? e.message : String(e))
    currentPort = null
  }
}
```

- [ ] **Step 4: handlers 배선**

`src/main/ipc/handlers.ts` — import 추가:

```ts
import { BridgeServer } from '../bridge/server'
import { applyBridgeSettings, newBridgeToken } from '../bridge/wiring'
```

`const agent = new AgentRunner(` 블록이 끝난 뒤(예: `agent.setSiteScripts(...)` 다음)에:

```ts
  // 하네스 브릿지 — 밖의 LangGraph 하네스가 이 앱의 도구를 부르는 문. 설정으로 켜고 끈다
  const bridge = new BridgeServer({
    openSession: (onStep) => agent.createToolSession({ onStep }),
    token: () => settings.get().bridgeToken
  })
  const applyBridge = (): Promise<void> =>
    applyBridgeSettings(bridge, settings.get(), (patch) => void settings.set(patch))
  void applyBridge()
  win.once('closed', () => void bridge.stop())
  handleFromRenderer(IPC.bridgeRegenerateToken, async () => {
    const token = newBridgeToken()
    settings.set({ bridgeToken: token })
    return { token }
  })
```

`IPC.settingsSet` 핸들러 안 `const s = settings.set(patch)` 바로 다음 줄에:

```ts
    if ('bridgeEnabled' in patch || 'bridgePort' in patch) void applyBridge()
```

`src/shared/ipc.ts` 채널(설정 채널 근처):

```ts
  bridgeRegenerateToken: 'bridge:regenerateToken', // 하네스 브릿지 토큰 새로 만들기(설정에 저장)
```

`src/preload/renderer.ts` (`settings:` 객체 다음):

```ts
  bridge: {
    regenerateToken: (): Promise<IpcResult<{ token: string }>> => invoke(IPC.bridgeRegenerateToken)
  },
```

(preload 의 노출 타입 선언 파일에 `bridge` 를 같은 모양으로 추가한다 — `window.samba` 타입이 정의된 곳을 `grep -rn "settings: {" src/preload src/renderer/src/*.d.ts` 로 찾는다.)

- [ ] **Step 5: 설정 화면 카드**

`src/renderer/src/components/settings/AgentSection.tsx` 의 마지막 `</>` 앞에 카드 추가(파일의 기존 import 에 `SettingsToggleRow`, `TextInput`, `SecondaryButton`, `SettingsRow`, `Switch` 가 없으면 추가):

```tsx
      <SettingsSection
        title={t('settingsPage.behavior.bridgeTitle')}
        description={t('settingsPage.behavior.bridgeDesc')}
      >
        <SettingsToggleRow label={t('settingsPage.behavior.bridgeEnabled')}>
          <Switch
            checked={settings.bridgeEnabled}
            onCheckedChange={(v) => update({ bridgeEnabled: v })}
          />
        </SettingsToggleRow>
        <SettingsRow label={t('settingsPage.behavior.bridgePort')}>
          <TextInput
            value={String(settings.bridgePort)}
            onChange={(v) => {
              const n = Number(v.replace(/[^\d]/g, ''))
              if (n >= 1024 && n <= 65535) update({ bridgePort: n })
            }}
          />
        </SettingsRow>
        <SettingsRow label={t('settingsPage.behavior.bridgeToken')}>
          <div className="flex items-center gap-2">
            <code className="truncate font-mono text-[12px] text-[var(--text2)]">
              {settings.bridgeToken ? `${settings.bridgeToken.slice(0, 8)}…` : '-'}
            </code>
            <SecondaryButton
              disabled={!settings.bridgeToken}
              onClick={() => void navigator.clipboard.writeText(settings.bridgeToken)}
            >
              {t('settingsPage.behavior.bridgeCopy')}
            </SecondaryButton>
            <SecondaryButton onClick={() => void window.samba.bridge.regenerateToken().then(() => update({}))}>
              {t('settingsPage.behavior.bridgeRegenerate')}
            </SecondaryButton>
          </div>
        </SettingsRow>
        <p className="text-[11.5px] text-[var(--text2)]">{t('settingsPage.behavior.bridgeHint')}</p>
      </SettingsSection>
```

i18n `settingsPage.behavior` 에 추가:

ko.json
```json
"bridgeTitle": "하네스 브릿지",
"bridgeDesc": "밖에서 도는 주문처리 하네스(LangGraph)가 이 브라우저를 손발로 쓰게 여는 문이에요. 이 PC 안(127.0.0.1)에서만 열립니다",
"bridgeEnabled": "브릿지 켜기",
"bridgePort": "포트",
"bridgeToken": "토큰",
"bridgeCopy": "복사",
"bridgeRegenerate": "새로 만들기",
"bridgeHint": "하네스의 .env 에 SAMBA_BRIDGE_URL=http://127.0.0.1:<포트> 와 SAMBA_BRIDGE_TOKEN=<토큰> 을 넣으세요. 브릿지가 도구를 쓰는 동안은 채팅창 AI 를 못 씁니다"
```

en.json
```json
"bridgeTitle": "Harness bridge",
"bridgeDesc": "Lets the external order-processing harness (LangGraph) drive this browser. Listens only on 127.0.0.1",
"bridgeEnabled": "Enable bridge",
"bridgePort": "Port",
"bridgeToken": "Token",
"bridgeCopy": "Copy",
"bridgeRegenerate": "Regenerate",
"bridgeHint": "Put SAMBA_BRIDGE_URL=http://127.0.0.1:<port> and SAMBA_BRIDGE_TOKEN=<token> in the harness .env. While the bridge is using tools, the chat AI is unavailable"
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run tests/bridge-wiring.test.ts && pnpm typecheck && npx vitest run`
Expected: 전부 PASS

- [ ] **Step 7: 커밋**

```bash
git add src/main/bridge/wiring.ts src/main/ipc/handlers.ts src/shared/ipc.ts src/preload src/renderer/src/components/settings/AgentSection.tsx src/renderer/src/i18n tests/bridge-wiring.test.ts
git commit -m "추가: 하네스 브릿지 배선 — 설정으로 켜고 끔, 토큰 자동 생성·재발급, 동작 설정 카드"
```

---

### Task 5: 실기 확인 + 하네스용 사용 설명

**Files:**
- Create: `docs/bridge.md`

- [ ] **Step 1: 앱 재시작 후 브릿지 켜기**

앱 재시작 → 설정 → 동작 → 하네스 브릿지 켜기 → 토큰 복사.

- [ ] **Step 2: curl 로 확인**

```bash
curl -s -H "X-Samba-Token: <토큰>" http://127.0.0.1:47811/health
```
Expected: `{"ok":true,"tools":["get_page","find_elements",...]}`

```bash
curl -s -X POST -H "X-Samba-Token: <토큰>" -H "content-type: application/json" -d '{"args":{}}' http://127.0.0.1:47811/tool/list_tabs
```
Expected: `{"ok":true,"result":"...탭 목록...","steps":[{"label":"탭 목록","ok":true}]}`

토큰 없이: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:47811/health` → `401`

- [ ] **Step 3: 문서**

```markdown
# 하네스 브릿지

SAMBA Browser 의 에이전트 도구를 로컬 HTTP 로 연다. 밖의 LangGraph 하네스가 손발로 쓴다.

- 켜기: 설정 → 동작 → 하네스 브릿지. 포트 기본 47811, 토큰은 켤 때 자동 생성(복사 버튼).
- 바인딩: 127.0.0.1 만. 외부 접근 불가.
- 인증: 헤더 `X-Samba-Token`.

## 규약
- `GET /health` → `{ ok, tools[] }`
- `POST /tool/{name}` 본문 `{ "args": {...} }` → `{ ok, result, steps[] }`
  - `result` 는 채팅 AI 가 보는 것과 같은 도구 본문 문자열
  - `steps` 는 그 호출이 남긴 진행 로그
- 오류: 401 토큰, 404 없는 도구, 400 JSON, 409 채팅 실행 중/다른 호출 중, 504 90초 초과, 500 도구 오류

## 도구 이름
채팅 AI 와 동일: get_page, find_elements, screenshot, navigate, click, type, select, scroll,
dismiss_overlay, run_js, wait, new_tab, list_tabs, switch_tab, close_tab, list_accounts,
fill_secret, login, run_script, save_script, phone_*, phone_approve_payment(폰 연결 시)

## 주의
- 브릿지 호출 중에는 채팅창 AI 실행이 거부된다(한 손발). 반대도 같다.
- 확인 카드는 뜨지 않는다(하네스가 판단한다). 캡차·2단계 인증은 `needs_user` 문자열로 돌아오니 하네스가 사람에게 넘긴다.
```

- [ ] **Step 4: 커밋**

```bash
git add docs/bridge.md
git commit -m "문서: 하네스 브릿지 규약과 사용법"
```

---

## 다음 계획
- 2/3 `samba-agent` Python 하네스(큐·9노드 그래프·슬랙 봇·LangSmith·평가) — 별도 계획서.
- 3/3 자동화 페이지 "처리 흐름" 그래프 화면 — 별도 계획서(하네스의 `/graph`·`/jobs` 가 생긴 뒤).
