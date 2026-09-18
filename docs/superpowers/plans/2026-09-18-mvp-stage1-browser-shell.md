# 삼바브라우저 MVP 1단계 구현 계획: 브라우저 뼈대 + AI 채팅

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron 기반 브라우저 창에서 탭·프로필·PC/모바일 전환이 되고, 오른쪽 AI 채팅에 "구글 열어서 삼바웨이브 검색해"라고 치면 AI가 페이지를 읽고 클릭·입력해 끝까지 수행한다.

**Architecture:** Electron 메인 프로세스가 `WebContentsView`로 탭을 관리하고(프로필 = `persist:` 파티션), preload 스크립트가 페이지 스냅샷(요소 번호 목록)과 클릭/입력 실행기를 제공한다. Agent 모듈은 Claude Agent SDK `query()`에 in-process MCP 도구(navigate/click/type/…)를 붙여 실행하며, 진행 로그를 IPC로 렌더러(React) 채팅 패널에 흘린다. 모든 UI 문자열은 i18n 키.

**Tech Stack:** Electron 33+, electron-vite, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand, react-i18next, zod, @anthropic-ai/claude-agent-sdk, Vitest, pnpm

## Global Constraints

- 들여쓰기 스페이스 2칸, 세미콜론 없음, 작은따옴표 (Prettier로 강제)
- `any` 타입 금지 (ESLint `@typescript-eslint/no-explicit-any: error`)
- 코드 주석·커밋 메시지·문서: 한국어. 변수/함수명: 영어
- UI 문자열 하드코딩 금지 → `t('key')` (ko/en JSON)
- IPC 응답 형식 통일: `{ ok: true, data } | { ok: false, error }`
- AI는 비밀값을 절대 보지 않음: `type=password` 입력칸은 스냅샷에서 `isSecret: true`, `type` 도구는 거부
- 도구 호출 상한 작업당 40회, 위험 단어(`결제, 구매, 송금, 이체, 삭제, 탈퇴, 주문`) 클릭 전 확인 팝업
- AI 인증: Claude Code 로그인(이미 됨) 재사용. `ANTHROPIC_API_KEY` 환경변수 있으면 그것 우선
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## 파일 구조

```
samba_browser/
  package.json, pnpm-lock.yaml, electron.vite.config.ts, tsconfig*.json
  .prettierrc, eslint.config.js, components.json(shadcn), vitest.config.ts
  src/
    shared/
      ipc.ts                 IPC 채널 이름 상수 + 요청/응답 DTO 타입
      snapshot.ts            PageSnapshot, PageElement 타입 + 스냅샷 텍스트 직렬화(순수 함수)
      danger.ts              위험 단어 판정 (순수 함수)
    main/
      index.ts               앱 부팅, 창 생성, 모듈 연결
      window.ts              BrowserWindow + 레이아웃(뷰 영역 좌표 계산)
      browser/
        tab-manager.ts       탭 생성/닫기/전환, WebContentsView, 파티션
        emulation.ts         모바일 에뮬레이션(CDP)
        page-bridge.ts       preload 실행기 호출(스냅샷/클릭/입력)
      agent/
        provider.ts          Agent SDK query 래퍼(인증 감지, abort)
        tools.ts             MCP 도구 정의(navigate/click/type/…)
        runner.ts            작업 실행 루프, 호출 상한, 로그 방출
        prompt.ts            시스템 프롬프트
      settings/store.ts      config.json 읽기/쓰기
      ipc/handlers.ts        ipcMain 핸들러 등록
    preload/
      page.ts                웹페이지 안: 스냅샷 생성, click/type/scroll 실행
      renderer.ts            contextBridge → window.samba API
    renderer/
      index.html, main.tsx, App.tsx, index.css
      i18n/{index.ts, ko.json, en.json}
      stores/{browserStore.ts, chatStore.ts, uiStore.ts}
      components/
        layout/{Sidebar.tsx, RightPanel.tsx}
        browser/{TabBar.tsx, AddressBar.tsx, ProgressBar.tsx}
        chat/{ChatPanel.tsx, MessageList.tsx, StepLog.tsx, ChatInput.tsx, ConfirmDialog.tsx}
        ui/…                 shadcn 부품
  tests/
    snapshot.test.ts, danger.test.ts, page-snapshot.test.ts(jsdom)
  docs/실행방법.md
```

---

### Task 1: 프로젝트 뼈대 생성 (electron-vite + React + TS + 코드 규칙)

**Files:**
- Create: 프로젝트 루트 전체(스캐폴드), `.prettierrc`, `eslint.config.js`, `vitest.config.ts`, `tests/smoke.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm dev`(앱 실행), `pnpm test`(Vitest), `pnpm lint`, `pnpm format`

- [ ] **Step 1: pnpm 활성화 및 스캐폴드**

```bash
corepack enable
corepack prepare pnpm@latest --activate
cd C:/Users/canno/workspace
pnpm create @quick-start/electron@latest samba_browser_tmp --template react-ts --skip
```
`samba_browser_tmp` 내용을 `samba_browser/`로 이동(기존 docs, .git 유지):
```bash
cp -rn samba_browser_tmp/. samba_browser/ && rm -rf samba_browser_tmp
cd samba_browser && pnpm install
```
Expected: `pnpm dev` 실행 시 기본 Electron 창 표시.

- [ ] **Step 2: Prettier·ESLint 규칙**

`.prettierrc`:
```json
{ "semi": false, "singleQuote": true, "tabWidth": 2, "trailingComma": "none", "printWidth": 100 }
```
`eslint.config.js`에 규칙 추가(스캐폴드 파일 기반):
```js
// any 금지, 미사용 변수 오류
rules: {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
}
```
`package.json` scripts에 추가:
```json
"test": "vitest run",
"test:watch": "vitest",
"lint": "eslint . --ext .ts,.tsx",
"format": "prettier --write \"src/**/*.{ts,tsx,css,json}\""
```

- [ ] **Step 3: Vitest 설치·설정 + 스모크 테스트**

```bash
pnpm add -D vitest jsdom @testing-library/dom
```
`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
})
```
`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('스모크', () => {
  it('테스트 러너 동작', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 4: 테스트·포맷 실행**

Run: `pnpm test` → Expected: `1 passed`
Run: `pnpm format && pnpm lint` → Expected: 오류 0

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "구축: electron-vite React TS 뼈대, Prettier/ESLint/Vitest 설정

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Tailwind v4 + shadcn/ui + i18n 뼈대

**Files:**
- Create: `src/renderer/i18n/index.ts`, `src/renderer/i18n/ko.json`, `src/renderer/i18n/en.json`, `components.json`, `src/renderer/components/ui/*`(shadcn 생성), `src/renderer/lib/utils.ts`
- Modify: `src/renderer/index.css`, `src/renderer/main.tsx`, `electron.vite.config.ts`, `tsconfig.web.json`

**Interfaces:**
- Produces: `useTranslation()`의 `t('sidebar.browser')` 등 키. `cn()` 유틸. shadcn `Button, Input, Dialog, Badge, ScrollArea, Separator, Tooltip`

- [ ] **Step 1: Tailwind v4 설치**

```bash
pnpm add tailwindcss @tailwindcss/vite
pnpm add -D tailwind-merge clsx class-variance-authority lucide-react
```
`electron.vite.config.ts`의 renderer 섹션에 플러그인 추가:
```ts
import tailwindcss from '@tailwindcss/vite'
// renderer: { plugins: [react(), tailwindcss()] , resolve: { alias: { '@renderer': resolve('src/renderer'), '@shared': resolve('src/shared') } } }
```
`src/renderer/index.css` 맨 위:
```css
@import 'tailwindcss';
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css');

:root {
  --bg: #f5f5f7; --panel: #ffffff; --line: rgba(0,0,0,.08); --text: #1d1d1f; --text2: #6e6e73; --text3: #a1a1a6;
  --accent: #0a84ff; --ok: #34c759; --warn: #ff9f0a; --danger: #ff3b30;
}
html, body, #root { height: 100%; margin: 0; }
body { font-family: 'Pretendard Variable', -apple-system, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); font-size: 13px; letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; }
```

- [ ] **Step 2: shadcn 초기화 (shadcn 스킬 참조)**

```bash
pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button input dialog badge scroll-area separator tooltip
```
`components.json`의 `aliases`가 `@renderer/components`·`@renderer/lib/utils`를 가리키도록 수정. `tsconfig.web.json` `paths`에 `"@renderer/*": ["src/renderer/*"], "@shared/*": ["src/shared/*"]`.

- [ ] **Step 3: i18n**

```bash
pnpm add i18next react-i18next
```
`src/renderer/i18n/ko.json`:
```json
{
  "app": { "name": "삼바브라우저" },
  "sidebar": { "browser": "브라우저", "tasks": "작업", "automation": "자동화", "accounts": "계정 · Vault", "phones": "폰", "logs": "로그", "settings": "설정", "chats": "채팅" },
  "address": { "placeholder": "검색어 또는 URL 입력", "pc": "PC", "mobile": "모바일", "profile": "프로필" },
  "tab": { "new": "새 탭" },
  "chat": { "title": "AI", "placeholder": "지시를 입력하세요…", "send": "전송", "stop": "중단", "thinking": "생각 중…", "done": "완료", "failed": "실패", "toolCalls": "도구 호출 {{n}} / {{max}}" },
  "confirm": { "title": "확인이 필요합니다", "body": "AI가 다음 행동을 하려고 합니다: {{action}}", "approve": "승인", "deny": "거부" },
  "auth": { "missing": "AI 연결이 안 됐어요. 터미널에서 claude login 을 실행하거나 설정에서 API 키를 입력하세요.", "limit": "AI 사용 한도에 도달했어요. 잠시 후 다시 시도하세요." },
  "settings": { "model": "모델", "language": "언어" }
}
```
`en.json`은 같은 키의 영어 값(예: `"browser": "Browser"`, `"placeholder": "Search or enter URL"`, `"missing": "AI is not connected. Run claude login in a terminal or add an API key in Settings."`).

`src/renderer/i18n/index.ts`:
```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import ko from './ko.json'
import en from './en.json'

// 앱 전체 번역 초기화. 기본 한국어, 설정에서 전환
void i18n.use(initReactI18next).init({
  resources: { ko: { translation: ko }, en: { translation: en } },
  lng: 'ko',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
```
`src/renderer/main.tsx` 상단에 `import './i18n'` 추가.

- [ ] **Step 4: App.tsx를 i18n 확인용으로 교체**

```tsx
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'

export default function App(): JSX.Element {
  const { t, i18n } = useTranslation()
  return (
    <div className="p-6 flex gap-3 items-center">
      <h1 className="text-lg font-semibold">{t('app.name')}</h1>
      <Button variant="outline" onClick={() => i18n.changeLanguage(i18n.language === 'ko' ? 'en' : 'ko')}>
        {t('settings.language')}
      </Button>
    </div>
  )
}
```
Run: `pnpm dev` → Expected: "삼바브라우저" 표시, 버튼 클릭 시 "Samba Browser"로 전환.

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "구축: Tailwind v4, shadcn/ui, i18n(ko/en) 뼈대

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 공용 타입 (IPC 채널, 스냅샷, 위험 단어) — TDD

**Files:**
- Create: `src/shared/ipc.ts`, `src/shared/snapshot.ts`, `src/shared/danger.ts`
- Test: `tests/snapshot.test.ts`, `tests/danger.test.ts`

**Interfaces:**
- Produces:
  - `PageElement { id: number; tag: string; role: string; text: string; name?: string; href?: string; inputType?: string; isSecret: boolean }`
  - `PageSnapshot { url: string; title: string; text: string; elements: PageElement[] }`
  - `serializeSnapshot(s: PageSnapshot): string` — AI에게 줄 문자열
  - `isDangerous(text: string, words?: string[]): boolean`
  - `IPC` 채널 상수, `IpcResult<T>`

- [ ] **Step 1: 실패 테스트 작성**

`tests/snapshot.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { serializeSnapshot, type PageSnapshot } from '@shared/snapshot'

const snap: PageSnapshot = {
  url: 'https://example.com',
  title: '예시',
  text: '본문 텍스트',
  elements: [
    { id: 1, tag: 'a', role: 'link', text: '로그인', href: '/login', isSecret: false },
    { id: 2, tag: 'input', role: 'textbox', text: '', name: 'q', inputType: 'text', isSecret: false },
    { id: 3, tag: 'input', role: 'textbox', text: '', name: 'pw', inputType: 'password', isSecret: true }
  ]
}

describe('serializeSnapshot', () => {
  it('URL·제목·요소를 번호와 함께 직렬화', () => {
    const out = serializeSnapshot(snap)
    expect(out).toContain('URL: https://example.com')
    expect(out).toContain('[1] link "로그인" href=/login')
    expect(out).toContain('[2] textbox name=q')
  })
  it('비밀 입력칸은 SECRET 표시', () => {
    expect(serializeSnapshot(snap)).toContain('[3] textbox name=pw (SECRET)')
  })
  it('본문은 8000자에서 자름', () => {
    const long = { ...snap, text: 'a'.repeat(9000) }
    expect(serializeSnapshot(long).length).toBeLessThan(9000)
  })
})
```
`tests/danger.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isDangerous, DEFAULT_DANGER_WORDS } from '@shared/danger'

describe('isDangerous', () => {
  it('위험 단어 포함 시 true', () => {
    expect(isDangerous('지금 결제하기')).toBe(true)
    expect(isDangerous('회원 탈퇴')).toBe(true)
  })
  it('없으면 false', () => {
    expect(isDangerous('장바구니 보기')).toBe(false)
  })
  it('기본 단어 목록 7개', () => {
    expect(DEFAULT_DANGER_WORDS).toHaveLength(7)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test` → Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/shared/snapshot.ts`:
```ts
// AI가 보는 페이지 구조 스냅샷 타입과 직렬화
export interface PageElement {
  id: number
  tag: string
  role: string
  text: string
  name?: string
  href?: string
  inputType?: string
  isSecret: boolean
}

export interface PageSnapshot {
  url: string
  title: string
  text: string
  elements: PageElement[]
}

export const MAX_TEXT_CHARS = 8000
export const MAX_ELEMENTS = 150

// 요소 한 줄 표현: [id] role "텍스트" name=… href=… (SECRET)
function formatElement(e: PageElement): string {
  const parts = [`[${e.id}] ${e.role}`]
  if (e.text) parts.push(`"${e.text.slice(0, 80)}"`)
  if (e.name) parts.push(`name=${e.name}`)
  if (e.href) parts.push(`href=${e.href.slice(0, 120)}`)
  if (e.isSecret) parts.push('(SECRET)')
  return parts.join(' ')
}

export function serializeSnapshot(s: PageSnapshot): string {
  const lines = [
    `URL: ${s.url}`,
    `TITLE: ${s.title}`,
    '',
    'INTERACTIVE ELEMENTS:',
    ...s.elements.slice(0, MAX_ELEMENTS).map(formatElement),
    '',
    'PAGE TEXT:',
    s.text.slice(0, MAX_TEXT_CHARS)
  ]
  return lines.join('\n')
}
```
`src/shared/danger.ts`:
```ts
// 실행 전 사용자 확인이 필요한 위험 단어 판정
export const DEFAULT_DANGER_WORDS = ['결제', '구매', '송금', '이체', '삭제', '탈퇴', '주문']

export function isDangerous(text: string, words: string[] = DEFAULT_DANGER_WORDS): boolean {
  const lower = text.toLowerCase()
  return words.some((w) => lower.includes(w.toLowerCase()))
}
```
`src/shared/ipc.ts`:
```ts
import type { PageSnapshot } from './snapshot'

// 렌더러 ↔ 메인 IPC 채널 이름. 문자열 하드코딩 금지
export const IPC = {
  tabList: 'tab:list',
  tabCreate: 'tab:create',
  tabClose: 'tab:close',
  tabActivate: 'tab:activate',
  tabNavigate: 'tab:navigate',
  tabBack: 'tab:back',
  tabForward: 'tab:forward',
  tabReload: 'tab:reload',
  tabSetMobile: 'tab:setMobile',
  tabUpdated: 'tab:updated', // main → renderer 이벤트
  layoutSet: 'layout:set',
  agentRun: 'agent:run',
  agentStop: 'agent:stop',
  agentEvent: 'agent:event', // main → renderer 이벤트
  agentConfirmReply: 'agent:confirmReply',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set'
} as const

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface TabInfo {
  id: string
  url: string
  title: string
  profile: string
  mobile: boolean
  loading: boolean
  active: boolean
}

// 렌더러가 메인에 알려주는 웹뷰 영역(사이드바·패널 제외)
export interface Layout {
  x: number
  y: number
  width: number
  height: number
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; label: string; ok: boolean }
  | { type: 'confirm'; requestId: string; action: string }
  | { type: 'status'; state: 'running' | 'done' | 'failed' | 'stopped'; message?: string; toolCalls?: number }

export interface Settings {
  model: 'sonnet' | 'opus' | 'haiku'
  language: 'ko' | 'en'
  panelWidth: number
  lastUrl: string
  dangerWords: string[]
  maxToolCalls: number
}

export type { PageSnapshot }
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm test` → Expected: 7 passed

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "공용: IPC 채널·스냅샷·위험 단어 타입과 테스트

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 페이지 preload — 스냅샷 생성 + 실행기 (TDD, jsdom)

**Files:**
- Create: `src/preload/page.ts`, `src/preload/page-core.ts`(DOM만 쓰는 순수 로직, 테스트 대상)
- Test: `tests/page-snapshot.test.ts`

**Interfaces:**
- Produces (페이지 안 전역 `window.__samba`): `snapshot(): PageSnapshot`, `click(id: number): string`, `type(id: number, text: string, submit: boolean): string`, `scroll(dir: 'up'|'down'): string`, `select(id: number, value: string): string`
- 반환 문자열은 결과 메시지(성공: `'ok'`, 실패: 이유)

- [ ] **Step 1: 실패 테스트**

`tests/page-snapshot.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { buildSnapshot, performClick, performType } from '../src/preload/page-core'

beforeEach(() => {
  document.body.innerHTML = `
    <h1>제목</h1>
    <a href="/login" id="l">로그인</a>
    <input name="q" placeholder="검색">
    <input type="password" name="pw">
    <button>검색하기</button>
    <div style="display:none"><button>숨김</button></div>
  `
})

describe('buildSnapshot', () => {
  it('보이는 상호작용 요소만 번호 매김', () => {
    const s = buildSnapshot()
    const texts = s.elements.map((e) => e.text || e.name)
    expect(texts).toEqual(['로그인', 'q', 'pw', '검색하기'])
    expect(s.elements[0].id).toBe(1)
  })
  it('password는 isSecret', () => {
    const s = buildSnapshot()
    expect(s.elements.find((e) => e.name === 'pw')?.isSecret).toBe(true)
  })
})

describe('performClick / performType', () => {
  it('id로 클릭', () => {
    buildSnapshot()
    let clicked = false
    document.getElementById('l')!.addEventListener('click', (ev) => { ev.preventDefault(); clicked = true })
    expect(performClick(1)).toBe('ok')
    expect(clicked).toBe(true)
  })
  it('비밀 입력칸 입력 거부', () => {
    buildSnapshot()
    expect(performType(3, 'x', false)).toMatch(/SECRET/)
  })
  it('일반 입력칸 입력', () => {
    buildSnapshot()
    expect(performType(2, '삼바웨이브', false)).toBe('ok')
    expect((document.querySelector('[name=q]') as HTMLInputElement).value).toBe('삼바웨이브')
  })
  it('없는 id는 오류', () => {
    buildSnapshot()
    expect(performClick(99)).toMatch(/not found/)
  })
})
```
jsdom은 `display:none`을 `offsetParent`로 판단 못 하므로 가시성 판정은 `getComputedStyle().display !== 'none'` + `hidden` 속성 기준으로 구현한다.

- [ ] **Step 2: 실패 확인** — Run: `pnpm test tests/page-snapshot.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/preload/page-core.ts`:
```ts
import type { PageElement, PageSnapshot } from '../shared/snapshot'
import { MAX_ELEMENTS } from '../shared/snapshot'

// 스냅샷 id → 실제 DOM 요소 매핑 (스냅샷마다 갱신)
let registry: HTMLElement[] = []

const SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [contenteditable="true"]'

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false
  let node: HTMLElement | null = el
  while (node) {
    const cs = getComputedStyle(node)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    node = node.parentElement
  }
  return true
}

function roleOf(el: HTMLElement): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type
    if (t === 'submit' || t === 'button') return 'button'
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    return 'textbox'
  }
  return tag
}

function labelOf(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria.trim()
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  if (text) return text
  const ph = el.getAttribute('placeholder')
  if (ph) return ph.trim()
  const id = el.id
  if (id) {
    const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (lab?.textContent) return lab.textContent.trim()
  }
  return ''
}

export function buildSnapshot(): PageSnapshot {
  const all = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter(isVisible)
  registry = all.slice(0, MAX_ELEMENTS)
  const elements: PageElement[] = registry.map((el, i) => {
    const input = el as HTMLInputElement
    const inputType = el.tagName === 'INPUT' ? input.type : undefined
    return {
      id: i + 1,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      text: labelOf(el),
      name: input.name || undefined,
      href: (el as HTMLAnchorElement).getAttribute?.('href') || undefined,
      inputType,
      isSecret: inputType === 'password'
    }
  })
  return {
    url: location.href,
    title: document.title,
    text: (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim(),
    elements
  }
}

function get(id: number): HTMLElement | null {
  return registry[id - 1] ?? null
}

export function performClick(id: number): string {
  const el = get(id)
  if (!el) return `element ${id} not found (call get_page again)`
  el.scrollIntoView({ block: 'center' })
  el.click()
  return 'ok'
}

export function performType(id: number, text: string, submit: boolean): string {
  const el = get(id)
  if (!el) return `element ${id} not found (call get_page again)`
  const input = el as HTMLInputElement
  if (input.type === 'password') return 'refused: SECRET field. Ask the user to type it.'
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  if (setter) setter.call(el, text)
  else input.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    ;(el as HTMLInputElement).form?.requestSubmit?.()
  }
  return 'ok'
}

export function performSelect(id: number, value: string): string {
  const el = get(id) as HTMLSelectElement | null
  if (!el) return `element ${id} not found`
  if (el.tagName !== 'SELECT') return 'refused: not a select'
  const opt = Array.from(el.options).find((o) => o.value === value || o.text.trim() === value)
  if (!opt) return `option "${value}" not found`
  el.value = opt.value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
}

export function performScroll(dir: 'up' | 'down'): string {
  window.scrollBy({ top: dir === 'down' ? window.innerHeight * 0.8 : -window.innerHeight * 0.8 })
  return 'ok'
}
```
`src/preload/page.ts` (웹페이지에 주입, contextIsolation 하에서 `contextBridge` 사용):
```ts
import { contextBridge } from 'electron'
import { buildSnapshot, performClick, performType, performSelect, performScroll } from './page-core'

// AI 실행기. 메인 프로세스가 executeJavaScript('window.__samba.snapshot()')로 호출
contextBridge.exposeInMainWorld('__samba', {
  snapshot: () => buildSnapshot(),
  click: (id: number) => performClick(id),
  type: (id: number, text: string, submit: boolean) => performType(id, text, submit),
  select: (id: number, value: string) => performSelect(id, value),
  scroll: (dir: 'up' | 'down') => performScroll(dir)
})
```
`electron.vite.config.ts` preload 섹션에 진입점 2개 등록:
```ts
preload: { build: { rollupOptions: { input: { renderer: resolve('src/preload/renderer.ts'), page: resolve('src/preload/page.ts') } } } }
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm test` → Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "preload: 페이지 스냅샷 생성기와 클릭/입력 실행기

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 탭 관리자 (WebContentsView + 프로필 파티션) + 창 레이아웃

**Files:**
- Create: `src/main/window.ts`, `src/main/browser/tab-manager.ts`, `src/main/browser/page-bridge.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces `TabManager`:
  - `create(opts: { url?: string; profile?: string; mobile?: boolean }): TabInfo`
  - `close(id: string): void`, `activate(id: string): void`, `list(): TabInfo[]`, `active(): Tab | null`
  - `navigate(id: string, url: string): Promise<void>`, `back/forward/reload(id)`
  - `setLayout(l: Layout): void`
  - `onChange(cb: (tabs: TabInfo[]) => void)`
- Produces `PageBridge`: `snapshot(tab): Promise<PageSnapshot>`, `click(tab, id)`, `type(tab, id, text, submit)`, `select(tab, id, value)`, `scroll(tab, dir)` — 모두 `Promise<string>`(snapshot 제외)

- [ ] **Step 1: window.ts**

```ts
import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

// 메인 창 생성. 렌더러(React UI)가 전체를 덮고, 웹뷰는 그 위에 겹쳐 배치
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 38 },
    backgroundColor: '#f5f5f7',
    webPreferences: { preload: join(__dirname, '../preload/renderer.js'), sandbox: false }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
```

- [ ] **Step 2: tab-manager.ts**

```ts
import { BrowserWindow, WebContentsView, session } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Layout, TabInfo } from '../../shared/ipc'
import { applyMobileEmulation, clearMobileEmulation } from './emulation'

export interface Tab {
  id: string
  view: WebContentsView
  profile: string
  mobile: boolean
}

// 탭 = WebContentsView 1개. 프로필은 persist: 파티션으로 쿠키 분리
export class TabManager {
  private tabs: Tab[] = []
  private activeId: string | null = null
  private layout: Layout = { x: 0, y: 0, width: 800, height: 600 }
  private listeners: Array<(tabs: TabInfo[]) => void> = []

  constructor(private win: BrowserWindow) {}

  onChange(cb: (tabs: TabInfo[]) => void): void {
    this.listeners.push(cb)
  }

  private emit(): void {
    const list = this.list()
    for (const cb of this.listeners) cb(list)
  }

  list(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      url: t.view.webContents.getURL(),
      title: t.view.webContents.getTitle(),
      profile: t.profile,
      mobile: t.mobile,
      loading: t.view.webContents.isLoading(),
      active: t.id === this.activeId
    }))
  }

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  get(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  create(opts: { url?: string; profile?: string; mobile?: boolean } = {}): TabInfo {
    const profile = opts.profile ?? 'default'
    const ses = session.fromPartition(`persist:${profile}`)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: join(__dirname, '../preload/page.js'),
        sandbox: true,
        contextIsolation: true
      }
    })
    const tab: Tab = { id: randomUUID(), view, profile, mobile: opts.mobile ?? false }
    this.tabs.push(tab)
    const wc = view.webContents
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) {
      wc.on(ev, () => this.emit())
    }
    wc.setWindowOpenHandler(({ url }) => {
      this.create({ url, profile, mobile: tab.mobile })
      return { action: 'deny' }
    })
    if (tab.mobile) applyMobileEmulation(wc)
    void wc.loadURL(opts.url ?? 'https://www.google.com')
    this.activate(tab.id)
    return this.list().find((t) => t.id === tab.id)!
  }

  activate(id: string): void {
    const tab = this.get(id)
    if (!tab) return
    for (const t of this.tabs) {
      if (t.view.getBounds().width !== 0 && t.id !== id) this.win.contentView.removeChildView(t.view)
    }
    this.win.contentView.addChildView(tab.view)
    tab.view.setBounds(this.layout)
    this.activeId = id
    this.emit()
  }

  close(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const [tab] = this.tabs.splice(idx, 1)
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1]
      if (next) this.activate(next.id)
      else this.activeId = null
    }
    this.emit()
  }

  async navigate(id: string, input: string): Promise<void> {
    const tab = this.get(id)
    if (!tab) throw new Error('tab not found')
    await tab.view.webContents.loadURL(toUrl(input))
  }

  back(id: string): void { this.get(id)?.view.webContents.navigationHistory.goBack() }
  forward(id: string): void { this.get(id)?.view.webContents.navigationHistory.goForward() }
  reload(id: string): void { this.get(id)?.view.webContents.reload() }

  setMobile(id: string, mobile: boolean): void {
    const tab = this.get(id)
    if (!tab) return
    tab.mobile = mobile
    if (mobile) applyMobileEmulation(tab.view.webContents)
    else clearMobileEmulation(tab.view.webContents)
    tab.view.webContents.reload()
    this.emit()
  }

  setLayout(l: Layout): void {
    this.layout = l
    this.active()?.view.setBounds(l)
  }
}

// 주소창 입력 → URL. 도메인 형태면 https 붙이고, 아니면 구글 검색
export function toUrl(input: string): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
```

- [ ] **Step 3: page-bridge.ts**

```ts
import type { WebContents } from 'electron'
import type { PageSnapshot } from '../../shared/snapshot'
import type { Tab } from './tab-manager'

// 탭 안 preload(window.__samba)를 executeJavaScript로 호출. 값은 JSON으로 왕복
async function call<T>(wc: WebContents, expr: string): Promise<T> {
  return (await wc.executeJavaScript(expr, true)) as T
}

export const pageBridge = {
  snapshot: (tab: Tab) => call<PageSnapshot>(tab.view.webContents, 'window.__samba.snapshot()'),
  click: (tab: Tab, id: number) => call<string>(tab.view.webContents, `window.__samba.click(${id})`),
  type: (tab: Tab, id: number, text: string, submit: boolean) =>
    call<string>(tab.view.webContents, `window.__samba.type(${id}, ${JSON.stringify(text)}, ${submit})`),
  select: (tab: Tab, id: number, value: string) =>
    call<string>(tab.view.webContents, `window.__samba.select(${id}, ${JSON.stringify(value)})`),
  scroll: (tab: Tab, dir: 'up' | 'down') => call<string>(tab.view.webContents, `window.__samba.scroll(${JSON.stringify(dir)})`),
  waitForLoad: (tab: Tab, timeoutMs = 10000) =>
    new Promise<void>((resolve) => {
      const wc = tab.view.webContents
      if (!wc.isLoading()) return resolve()
      const t = setTimeout(done, timeoutMs)
      function done(): void { clearTimeout(t); wc.off('did-stop-loading', done); resolve() }
      wc.on('did-stop-loading', done)
    })
}
```

- [ ] **Step 4: toUrl 단위 테스트** — `tests/to-url.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { toUrl } from '../src/main/browser/tab-manager'

describe('toUrl', () => {
  it('http 그대로', () => expect(toUrl('https://a.com/x')).toBe('https://a.com/x'))
  it('도메인은 https 부여', () => expect(toUrl('naver.com')).toBe('https://naver.com'))
  it('검색어는 구글', () => expect(toUrl('삼바웨이브')).toContain('google.com/search?q='))
})
```
`vitest.config.ts`에 `alias`로 `electron` 모듈을 스텁: `resolve.alias.electron = resolve(__dirname, 'tests/stubs/electron.ts')`, 스텁 파일은 `export const session = {}; export class WebContentsView {}; export const BrowserWindow = class {}` 내보내기.
Run: `pnpm test` → PASS

- [ ] **Step 5: index.ts에서 연결 + 첫 탭 생성**

```ts
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { TabManager } from './browser/tab-manager'
import { registerIpc } from './ipc/handlers'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.samba.browser')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  const win = createMainWindow()
  const tabs = new TabManager(win)
  registerIpc(win, tabs)
  tabs.create({ url: 'https://www.google.com' })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```
`registerIpc`는 Task 7에서 구현. 지금은 빈 함수 파일 생성:
```ts
// src/main/ipc/handlers.ts
import type { BrowserWindow } from 'electron'
import type { TabManager } from '../browser/tab-manager'
export function registerIpc(_win: BrowserWindow, _tabs: TabManager): void {}
```
Run: `pnpm dev` → Expected: 창 뜨고 구글이 좌상단 800×600에 표시(레이아웃은 Task 7에서 맞춤).

- [ ] **Step 6: 커밋**

```bash
git add -A && git commit -m "메인: WebContentsView 탭 관리자, 프로필 파티션, 페이지 브리지

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 모바일 에뮬레이션 (CDP)

**Files:**
- Create: `src/main/browser/emulation.ts`

**Interfaces:**
- Produces: `applyMobileEmulation(wc: WebContents): void`, `clearMobileEmulation(wc: WebContents): void`

- [ ] **Step 1: 구현**

```ts
import type { WebContents } from 'electron'

// 갤럭시 기준 모바일 흉내: UA + 뷰포트 + 터치
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-F711N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

function attach(wc: WebContents): boolean {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    return true
  } catch (e) {
    console.error('디버거 연결 실패', e)
    return false
  }
}

export function applyMobileEmulation(wc: WebContents): void {
  if (!attach(wc)) return
  wc.setUserAgent(MOBILE_UA)
  void wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true
  })
  void wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  void wc.debugger.sendCommand('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'Android' })
}

export function clearMobileEmulation(wc: WebContents): void {
  if (!wc.debugger.isAttached()) return
  void wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
  void wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
  wc.setUserAgent('')
  wc.debugger.detach()
}
```

- [ ] **Step 2: 수동 확인** — `tabs.create({ url: 'https://m.naver.com', mobile: true })`를 index.ts에 임시 추가 후 `pnpm dev` → 모바일 레이아웃 확인 → 임시 코드 제거.

- [ ] **Step 3: 커밋**

```bash
git add -A && git commit -m "브라우저: CDP 기반 모바일 에뮬레이션

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: IPC 핸들러 + 렌더러 브리지 + 설정 저장소

**Files:**
- Create: `src/main/ipc/handlers.ts`(교체), `src/main/settings/store.ts`, `src/preload/renderer.ts`, `src/renderer/types/samba.d.ts`

**Interfaces:**
- Produces `window.samba`:
  - `tabs.list/create/close/activate/navigate/back/forward/reload/setMobile`
  - `tabs.onUpdated(cb: (tabs: TabInfo[]) => void): () => void`
  - `layout.set(l: Layout)`
  - `agent.run(prompt: string)`, `agent.stop()`, `agent.onEvent(cb)`, `agent.confirmReply(requestId, approved)`
  - `settings.get(): Promise<Settings>`, `settings.set(patch: Partial<Settings>)`
- Produces `SettingsStore.get()/set(patch)`

- [ ] **Step 1: settings/store.ts**

```ts
import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { Settings } from '../../shared/ipc'
import { DEFAULT_DANGER_WORDS } from '../../shared/danger'

const DEFAULTS: Settings = {
  model: 'sonnet', language: 'ko', panelWidth: 380, lastUrl: 'https://www.google.com',
  dangerWords: DEFAULT_DANGER_WORDS, maxToolCalls: 40
}

// %APPDATA%/samba-browser/config.json
export class SettingsStore {
  private file = join(app.getPath('userData'), 'config.json')
  private cache: Settings

  constructor() {
    this.cache = this.load()
  }

  private load(): Settings {
    try {
      if (existsSync(this.file)) return { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, 'utf8')) }
    } catch (e) {
      console.error('설정 읽기 실패, 기본값 사용', e)
    }
    return { ...DEFAULTS }
  }

  get(): Settings { return this.cache }

  set(patch: Partial<Settings>): Settings {
    this.cache = { ...this.cache, ...patch }
    mkdirSync(join(this.file, '..'), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2))
    return this.cache
  }
}
```

- [ ] **Step 2: ipc/handlers.ts**

```ts
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, type IpcResult, type Layout, type Settings } from '../../shared/ipc'
import type { TabManager } from '../browser/tab-manager'
import { SettingsStore } from '../settings/store'
import { AgentRunner } from '../agent/runner'

// 모든 핸들러는 {ok,data}|{ok:false,error}로 응답
function wrap<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ({ ok: true as const, data }))
    .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
}

export function registerIpc(win: BrowserWindow, tabs: TabManager): { settings: SettingsStore; agent: AgentRunner } {
  const settings = new SettingsStore()
  const agent = new AgentRunner(tabs, settings, (ev) => win.webContents.send(IPC.agentEvent, ev))

  tabs.onChange((list) => win.webContents.send(IPC.tabUpdated, list))

  ipcMain.handle(IPC.tabList, () => wrap(() => tabs.list()))
  ipcMain.handle(IPC.tabCreate, (_, o: { url?: string; profile?: string; mobile?: boolean }) => wrap(() => tabs.create(o)))
  ipcMain.handle(IPC.tabClose, (_, id: string) => wrap(() => tabs.close(id)))
  ipcMain.handle(IPC.tabActivate, (_, id: string) => wrap(() => tabs.activate(id)))
  ipcMain.handle(IPC.tabNavigate, (_, id: string, url: string) => wrap(() => tabs.navigate(id, url)))
  ipcMain.handle(IPC.tabBack, (_, id: string) => wrap(() => tabs.back(id)))
  ipcMain.handle(IPC.tabForward, (_, id: string) => wrap(() => tabs.forward(id)))
  ipcMain.handle(IPC.tabReload, (_, id: string) => wrap(() => tabs.reload(id)))
  ipcMain.handle(IPC.tabSetMobile, (_, id: string, mobile: boolean) => wrap(() => tabs.setMobile(id, mobile)))
  ipcMain.handle(IPC.layoutSet, (_, l: Layout) => wrap(() => tabs.setLayout(l)))

  ipcMain.handle(IPC.agentRun, (_, prompt: string) => wrap(() => agent.run(prompt)))
  ipcMain.handle(IPC.agentStop, () => wrap(() => agent.stop()))
  ipcMain.on(IPC.agentConfirmReply, (_, requestId: string, approved: boolean) => agent.resolveConfirm(requestId, approved))

  ipcMain.handle(IPC.settingsGet, () => wrap(() => settings.get()))
  ipcMain.handle(IPC.settingsSet, (_, patch: Partial<Settings>) => wrap(() => settings.set(patch)))

  return { settings, agent }
}
```
`AgentRunner`는 Task 8에서 구현. 이 태스크를 먼저 컴파일하려면 `src/main/agent/runner.ts`에 아래 스텁을 두고 Task 8에서 교체:
```ts
import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent } from '../../shared/ipc'
export class AgentRunner {
  constructor(_tabs: TabManager, _settings: SettingsStore, _emit: (e: AgentEvent) => void) {}
  async run(_prompt: string): Promise<void> {}
  stop(): void {}
  resolveConfirm(_id: string, _approved: boolean): void {}
}
```

- [ ] **Step 3: preload/renderer.ts**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AgentEvent, type Layout, type Settings, type TabInfo } from '../shared/ipc'

// React UI가 쓰는 API. 반환은 전부 IpcResult
const api = {
  tabs: {
    list: () => ipcRenderer.invoke(IPC.tabList),
    create: (o: { url?: string; profile?: string; mobile?: boolean }) => ipcRenderer.invoke(IPC.tabCreate, o),
    close: (id: string) => ipcRenderer.invoke(IPC.tabClose, id),
    activate: (id: string) => ipcRenderer.invoke(IPC.tabActivate, id),
    navigate: (id: string, url: string) => ipcRenderer.invoke(IPC.tabNavigate, id, url),
    back: (id: string) => ipcRenderer.invoke(IPC.tabBack, id),
    forward: (id: string) => ipcRenderer.invoke(IPC.tabForward, id),
    reload: (id: string) => ipcRenderer.invoke(IPC.tabReload, id),
    setMobile: (id: string, mobile: boolean) => ipcRenderer.invoke(IPC.tabSetMobile, id, mobile),
    onUpdated: (cb: (tabs: TabInfo[]) => void) => {
      const h = (_: unknown, tabs: TabInfo[]): void => cb(tabs)
      ipcRenderer.on(IPC.tabUpdated, h)
      return () => ipcRenderer.off(IPC.tabUpdated, h)
    }
  },
  layout: { set: (l: Layout) => ipcRenderer.invoke(IPC.layoutSet, l) },
  agent: {
    run: (prompt: string) => ipcRenderer.invoke(IPC.agentRun, prompt),
    stop: () => ipcRenderer.invoke(IPC.agentStop),
    confirmReply: (requestId: string, approved: boolean) => ipcRenderer.send(IPC.agentConfirmReply, requestId, approved),
    onEvent: (cb: (e: AgentEvent) => void) => {
      const h = (_: unknown, e: AgentEvent): void => cb(e)
      ipcRenderer.on(IPC.agentEvent, h)
      return () => ipcRenderer.off(IPC.agentEvent, h)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.settingsSet, patch)
  }
}

export type SambaApi = typeof api
contextBridge.exposeInMainWorld('samba', api)
```
`src/renderer/types/samba.d.ts`:
```ts
import type { SambaApi } from '../../preload/renderer'
declare global {
  interface Window { samba: SambaApi }
}
export {}
```

- [ ] **Step 4: 빌드 확인** — Run: `pnpm build` (electron-vite build) → Expected: 오류 0. Run: `pnpm lint` → 오류 0.

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "IPC: 탭/에이전트/설정 핸들러와 렌더러 브리지, 설정 저장소

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Agent 모듈 — Claude Agent SDK + MCP 도구 + 실행 루프

**Files:**
- Create: `src/main/agent/prompt.ts`, `src/main/agent/tools.ts`, `src/main/agent/provider.ts`
- Modify: `src/main/agent/runner.ts`(스텁 교체)
- Test: `tests/agent-runner.test.ts`(호출 상한·위험 확인 로직은 순수 함수로 분리해 테스트)

**Interfaces:**
- Consumes: `TabManager`, `pageBridge`, `SettingsStore`, `AgentEvent`
- Produces: `AgentRunner.run(prompt): Promise<void>`, `stop()`, `resolveConfirm(id, approved)`
- MCP 도구 이름(서버명 `samba`): `mcp__samba__get_page`, `navigate`, `click`, `type`, `select`, `scroll`, `wait`, `new_tab`, `switch_tab`, `done`

- [ ] **Step 1: 설치**

```bash
pnpm add @anthropic-ai/claude-agent-sdk zod
```

- [ ] **Step 2: prompt.ts**

```ts
// AI 시스템 프롬프트. 안전 규칙 포함
export function buildSystemPrompt(language: 'ko' | 'en'): string {
  const lang = language === 'ko' ? '한국어' : 'English'
  return `You are the agent inside Samba Browser, a desktop web browser. You complete web tasks for the user by calling tools.

RULES
- Always call get_page first to see the current page. Elements are numbered [n]. Use those numbers for click/type/select.
- After navigate/click/type, the page may change: call get_page again before the next action.
- Never type into fields marked (SECRET). Tell the user to enter it themselves.
- Do not guess: if you cannot find an element, scroll or call get_page again.
- Prefer the fewest tool calls. Stop and call done(summary) when the task is complete or impossible.
- Some actions require user confirmation; if a tool returns "denied by user", stop and call done.
- Reply to the user in ${lang}. Keep messages short.`
}
```

- [ ] **Step 3: tools.ts**

```ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TabManager } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import { serializeSnapshot } from '../../shared/snapshot'
import { isDangerous } from '../../shared/danger'

export interface ToolContext {
  tabs: TabManager
  dangerWords: string[]
  // 위험 행동 확인. 승인이면 true
  confirm: (action: string) => Promise<boolean>
  // 호출 카운터. 상한 넘으면 문자열 반환
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

// 현재 탭이 없으면 오류 문자열
function activeOr(ctx: ToolContext): ReturnType<TabManager['active']> {
  return ctx.tabs.active()
}

export function createSambaTools(ctx: ToolContext) {
  const guard = async <T>(label: string, fn: () => Promise<T>): Promise<ReturnType<typeof text>> => {
    const over = ctx.tick()
    if (over) return text(over)
    try {
      const r = await fn()
      const s = typeof r === 'string' ? r : JSON.stringify(r)
      ctx.onStep(label, !/not found|refused|denied|error/i.test(s))
      return text(s)
    } catch (e) {
      ctx.onStep(label, false)
      return text(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const getPage = tool('get_page', 'Read the current page: URL, title, numbered interactive elements, visible text.', {}, () =>
    guard('페이지 읽기', async () => {
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      await pageBridge.waitForLoad(tab)
      return serializeSnapshot(await pageBridge.snapshot(tab))
    })
  )

  const navigate = tool('navigate', 'Open a URL or search query in the active tab.', { url: z.string() }, ({ url }) =>
    guard(`이동: ${url}`, async () => {
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      await ctx.tabs.navigate(tab.id, url)
      await pageBridge.waitForLoad(tab)
      return `ok: ${tab.view.webContents.getURL()}`
    })
  )

  const click = tool('click', 'Click element [n] from get_page.', { id: z.number().int(), label: z.string().describe('element text, for logging') }, ({ id, label }) =>
    guard(`클릭: ${label} (#${id})`, async () => {
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      if (isDangerous(label, ctx.dangerWords)) {
        const ok = await ctx.confirm(`클릭: ${label}`)
        if (!ok) return 'denied by user'
      }
      const r = await pageBridge.click(tab, id)
      await pageBridge.waitForLoad(tab)
      return r
    })
  )

  const typeTool = tool('type', 'Type text into input [n]. submit=true presses Enter.', { id: z.number().int(), text: z.string(), submit: z.boolean().default(false) }, ({ id, text: t, submit }) =>
    guard(`입력: "${t.slice(0, 30)}" (#${id})`, async () => {
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      if (isDangerous(t, ctx.dangerWords)) {
        const ok = await ctx.confirm(`입력: ${t}`)
        if (!ok) return 'denied by user'
      }
      const r = await pageBridge.type(tab, id, t, submit)
      if (submit) await pageBridge.waitForLoad(tab)
      return r
    })
  )

  const select = tool('select', 'Choose an option in <select> [n] by value or visible text.', { id: z.number().int(), value: z.string() }, ({ id, value }) =>
    guard(`선택: ${value} (#${id})`, async () => {
      const tab = activeOr(ctx)
      return tab ? pageBridge.select(tab, id, value) : 'no active tab'
    })
  )

  const scroll = tool('scroll', 'Scroll the page up or down.', { direction: z.enum(['up', 'down']) }, ({ direction }) =>
    guard(`스크롤 ${direction}`, async () => {
      const tab = activeOr(ctx)
      return tab ? pageBridge.scroll(tab, direction) : 'no active tab'
    })
  )

  const wait = tool('wait', 'Wait up to 5000 ms for the page to settle.', { ms: z.number().int().min(100).max(5000) }, ({ ms }) =>
    guard(`대기 ${ms}ms`, async () => {
      await new Promise((r) => setTimeout(r, ms))
      return 'ok'
    })
  )

  const newTab = tool('new_tab', 'Open a new tab (optionally with profile name and mobile mode) and make it active.', { url: z.string().optional(), profile: z.string().optional(), mobile: z.boolean().optional() }, (o) =>
    guard(`새 탭 ${o.profile ?? ''}`, async () => {
      const t = ctx.tabs.create(o)
      return `ok: tab ${t.id}`
    })
  )

  const switchTab = tool('switch_tab', 'Activate a tab by id (see list in results).', { id: z.string() }, ({ id }) =>
    guard('탭 전환', async () => {
      ctx.tabs.activate(id)
      return `ok. tabs: ${JSON.stringify(ctx.tabs.list().map((t) => ({ id: t.id, title: t.title, profile: t.profile })))}`
    })
  )

  const done = tool('done', 'Finish the task with a short summary for the user.', { summary: z.string() }, ({ summary }) => {
    ctx.onStep(`완료: ${summary.slice(0, 60)}`, true)
    return Promise.resolve(text(`DONE: ${summary}`))
  })

  return createSdkMcpServer({
    name: 'samba',
    version: '0.1.0',
    tools: [getPage, navigate, click, typeTool, select, scroll, wait, newTab, switchTab, done]
  })
}

export const SAMBA_TOOL_NAMES = ['get_page', 'navigate', 'click', 'type', 'select', 'scroll', 'wait', 'new_tab', 'switch_tab', 'done'].map((n) => `mcp__samba__${n}`)
```

- [ ] **Step 4: provider.ts**

```ts
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'

export interface ProviderInput {
  prompt: string
  systemPrompt: string
  model: string
  mcpServers: Options['mcpServers']
  allowedTools: string[]
  abort: AbortController
}

// Claude Agent SDK 호출. Claude Code 로그인 또는 ANTHROPIC_API_KEY 자동 사용
export function runQuery(input: ProviderInput) {
  return query({
    prompt: input.prompt,
    options: {
      systemPrompt: input.systemPrompt,
      model: input.model,
      mcpServers: input.mcpServers,
      allowedTools: input.allowedTools,
      disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep'],
      permissionMode: 'default',
      maxTurns: 60,
      abortController: input.abort
    }
  })
}

// 인증 오류 문구 판별 → UI 안내 키
export function classifyAuthError(message: string): 'missing' | 'limit' | null {
  const m = message.toLowerCase()
  if (m.includes('not logged in') || m.includes('authentication') || m.includes('api key') || m.includes('unauthorized')) return 'missing'
  if (m.includes('rate limit') || m.includes('usage limit') || m.includes('429')) return 'limit'
  return null
}
```

- [ ] **Step 5: runner 순수 로직 테스트** — `tests/agent-runner.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeCounter } from '../src/main/agent/counter'
import { classifyAuthError } from '../src/main/agent/provider'

describe('호출 카운터', () => {
  it('상한 도달 시 메시지 반환', () => {
    const c = makeCounter(2)
    expect(c.tick()).toBeNull()
    expect(c.tick()).toBeNull()
    expect(c.tick()).toMatch(/limit/)
    expect(c.count()).toBe(3)
  })
})

describe('classifyAuthError', () => {
  it('로그인 없음', () => expect(classifyAuthError('Error: Not logged in')).toBe('missing'))
  it('한도', () => expect(classifyAuthError('rate limit exceeded')).toBe('limit'))
  it('기타', () => expect(classifyAuthError('boom')).toBeNull())
})
```
`src/main/agent/counter.ts`:
```ts
// 작업당 도구 호출 상한 카운터
export function makeCounter(max: number): { tick: () => string | null; count: () => number } {
  let n = 0
  return {
    tick: () => {
      n += 1
      return n > max ? `tool call limit (${max}) reached. Call done with what you have.` : null
    },
    count: () => n
  }
}
```
Run: `pnpm test` → 실패 확인 → 파일 생성 후 PASS.

- [ ] **Step 6: runner.ts (스텁 교체)**

```ts
import { randomUUID } from 'crypto'
import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent } from '../../shared/ipc'
import { createSambaTools, SAMBA_TOOL_NAMES } from './tools'
import { buildSystemPrompt } from './prompt'
import { runQuery, classifyAuthError } from './provider'
import { makeCounter } from './counter'

// 작업 1건 실행: SDK 스트림을 읽어 UI 이벤트로 변환
export class AgentRunner {
  private abort: AbortController | null = null
  private pending = new Map<string, (ok: boolean) => void>()

  constructor(
    private tabs: TabManager,
    private settings: SettingsStore,
    private emit: (e: AgentEvent) => void
  ) {}

  resolveConfirm(id: string, approved: boolean): void {
    this.pending.get(id)?.(approved)
    this.pending.delete(id)
  }

  stop(): void {
    this.abort?.abort()
    this.emit({ type: 'status', state: 'stopped' })
  }

  async run(prompt: string): Promise<void> {
    if (this.abort) throw new Error('이미 실행 중')
    const s = this.settings.get()
    const abort = new AbortController()
    this.abort = abort
    const counter = makeCounter(s.maxToolCalls)
    const server = createSambaTools({
      tabs: this.tabs,
      dangerWords: s.dangerWords,
      tick: counter.tick,
      onStep: (label, ok) => this.emit({ type: 'step', label, ok }),
      confirm: (action) =>
        new Promise<boolean>((resolve) => {
          const id = randomUUID()
          this.pending.set(id, resolve)
          this.emit({ type: 'confirm', requestId: id, action })
          setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve(false) } }, 30 * 60 * 1000)
        })
    })
    this.emit({ type: 'status', state: 'running', toolCalls: 0 })
    try {
      const stream = runQuery({
        prompt,
        systemPrompt: buildSystemPrompt(s.language),
        model: s.model,
        mcpServers: { samba: server },
        allowedTools: SAMBA_TOOL_NAMES,
        abort
      })
      for await (const msg of stream) {
        if (msg.type === 'assistant') {
          // SDKAssistantMessage.message = Anthropic API 메시지
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) this.emit({ type: 'text', text: block.text })
          }
        } else if (msg.type === 'result') {
          const failed = msg.subtype !== 'success'
          this.emit({ type: 'status', state: failed ? 'failed' : 'done', toolCalls: counter.count(), message: failed ? msg.subtype : undefined })
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const kind = classifyAuthError(message)
      this.emit({ type: 'status', state: abort.signal.aborted ? 'stopped' : 'failed', message: kind ? `auth:${kind}` : message, toolCalls: counter.count() })
    } finally {
      this.abort = null
    }
  }
}
```
SDK 타입에서 `msg.message.content` 경로가 다르면 `pnpm exec tsc --noEmit -p tsconfig.node.json` 오류 메시지에 맞춰 수정(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`에서 `SDKAssistantMessage` 확인).

- [ ] **Step 7: 타입·린트·테스트**

Run: `pnpm build && pnpm lint && pnpm test` → Expected: 전부 통과

- [ ] **Step 8: 커밋**

```bash
git add -A && git commit -m "에이전트: Claude Agent SDK 연결, MCP 브라우저 도구, 실행 루프·확인·상한

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: React 화면 — 레이아웃·탭바·주소창·진행 띠 (목업 01-main 기준)

**Files:**
- Create: `src/renderer/stores/browserStore.ts`, `src/renderer/stores/uiStore.ts`, `src/renderer/components/layout/Sidebar.tsx`, `src/renderer/components/layout/RightPanel.tsx`, `src/renderer/components/browser/TabBar.tsx`, `src/renderer/components/browser/AddressBar.tsx`, `src/renderer/components/browser/ProgressBar.tsx`, `src/renderer/components/browser/WebArea.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `window.samba.tabs.*`, `window.samba.layout.set`
- Produces: `useBrowserStore` `{ tabs, activeTab, refresh(), create(), close(id), activate(id), navigate(url), back(), forward(), reload(), setMobile(bool) }`, `useUiStore` `{ panelWidth, sidebarWidth, setPanelWidth }`

- [ ] **Step 1: 스토어**

`src/renderer/stores/browserStore.ts`:
```ts
import { create } from 'zustand'
import type { TabInfo } from '@shared/ipc'

interface BrowserState {
  tabs: TabInfo[]
  activeTab: TabInfo | null
  setTabs: (tabs: TabInfo[]) => void
  refresh: () => Promise<void>
  createTab: (url?: string) => Promise<void>
  closeTab: (id: string) => Promise<void>
  activateTab: (id: string) => Promise<void>
  navigate: (url: string) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  setMobile: (mobile: boolean) => Promise<void>
}

// 탭 상태는 메인이 진실. 렌더러는 이벤트로 복사본만 유지
export const useBrowserStore = create<BrowserState>((set, get) => ({
  tabs: [],
  activeTab: null,
  setTabs: (tabs) => set({ tabs, activeTab: tabs.find((t) => t.active) ?? null }),
  refresh: async () => {
    const r = await window.samba.tabs.list()
    if (r.ok) get().setTabs(r.data)
  },
  createTab: async (url) => { await window.samba.tabs.create({ url }) },
  closeTab: async (id) => { await window.samba.tabs.close(id) },
  activateTab: async (id) => { await window.samba.tabs.activate(id) },
  navigate: async (url) => { const t = get().activeTab; if (t) await window.samba.tabs.navigate(t.id, url) },
  back: async () => { const t = get().activeTab; if (t) await window.samba.tabs.back(t.id) },
  forward: async () => { const t = get().activeTab; if (t) await window.samba.tabs.forward(t.id) },
  reload: async () => { const t = get().activeTab; if (t) await window.samba.tabs.reload(t.id) },
  setMobile: async (mobile) => { const t = get().activeTab; if (t) await window.samba.tabs.setMobile(t.id, mobile) }
}))
```
`src/renderer/stores/uiStore.ts`:
```ts
import { create } from 'zustand'

interface UiState {
  sidebarWidth: number
  panelWidth: number
  setPanelWidth: (w: number) => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarWidth: 232,
  panelWidth: 380,
  setPanelWidth: (w) => set({ panelWidth: Math.max(280, Math.min(600, w)) })
}))
```

- [ ] **Step 2: WebArea — 웹뷰 자리 측정 → 메인에 레이아웃 전달**

```tsx
import { useEffect, useRef } from 'react'

// 실제 웹페이지(WebContentsView)는 메인이 그림. 이 컴포넌트는 빈 자리를 만들고 좌표만 보고
export function WebArea(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const send = (): void => {
      const r = el.getBoundingClientRect()
      void window.samba.layout.set({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    return () => { ro.disconnect(); window.removeEventListener('resize', send) }
  }, [])
  return <div ref={ref} className="flex-1 bg-white" />
}
```

- [ ] **Step 3: TabBar / AddressBar / ProgressBar**

`TabBar.tsx`:
```tsx
import { useTranslation } from 'react-i18next'
import { X, Plus } from 'lucide-react'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'

export function TabBar(): JSX.Element {
  const { t } = useTranslation()
  const { tabs, activateTab, closeTab, createTab } = useBrowserStore()
  return (
    <div className="flex items-end gap-1 px-2.5 pt-2" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => activateTab(tab.id)}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className={cn('flex max-w-[200px] items-center gap-2 rounded-t-lg px-2.5 pb-2 pt-1.5 text-[12.5px] text-[var(--text2)] cursor-default',
            tab.active && 'bg-[var(--bg)] font-medium text-[var(--text)]')}
        >
          <span className="truncate">{tab.title || tab.url}</span>
          {tab.profile !== 'default' && <Badge variant="secondary" className="h-4 px-1.5 text-[10.5px]">{tab.profile}</Badge>}
          <X className="h-3.5 w-3.5 shrink-0 text-[var(--text3)] hover:text-[var(--text)]" onClick={(e) => { e.stopPropagation(); void closeTab(tab.id) }} />
        </div>
      ))}
      <button title={t('tab.new')} onClick={() => createTab()} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} className="px-2 pb-2 pt-1.5 text-[var(--text3)]">
        <Plus className="h-4 w-4" />
      </button>
    </div>
  )
}
```
`AddressBar.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, RotateCw, Lock, Monitor, Smartphone } from 'lucide-react'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { cn } from '@renderer/lib/utils'

export function AddressBar(): JSX.Element {
  const { t } = useTranslation()
  const { activeTab, navigate, back, forward, reload, setMobile } = useBrowserStore()
  const [value, setValue] = useState('')
  useEffect(() => { setValue(activeTab?.url ?? '') }, [activeTab?.url])

  const Btn = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }): JSX.Element => (
    <button onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5">{children}</button>
  )

  return (
    <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--bg)] px-3 py-2">
      <Btn onClick={back}><ArrowLeft className="h-4 w-4" /></Btn>
      <Btn onClick={forward}><ArrowRight className="h-4 w-4" /></Btn>
      <Btn onClick={reload}><RotateCw className="h-4 w-4" /></Btn>
      <form className="flex h-8 flex-1 items-center gap-2 rounded-[10px] border border-[var(--line)] bg-white px-3" onSubmit={(e) => { e.preventDefault(); void navigate(value) }}>
        <Lock className="h-3.5 w-3.5 text-[var(--text3)]" />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('address.placeholder')} className="flex-1 bg-transparent text-[12.5px] outline-none" />
      </form>
      <div className="flex rounded-[9px] bg-black/5 p-0.5">
        {[{ m: false, icon: Monitor, label: t('address.pc') }, { m: true, icon: Smartphone, label: t('address.mobile') }].map(({ m, icon: Icon, label }) => (
          <button key={label} onClick={() => setMobile(m)} className={cn('flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] text-[var(--text2)]', (activeTab?.mobile ?? false) === m && 'bg-white font-medium text-[var(--text)] shadow-sm')}>
            <Icon className="h-3.5 w-3.5" />{label}
          </button>
        ))}
      </div>
      <div className="flex h-8 items-center gap-2 rounded-[10px] border border-[var(--line)] bg-white px-2.5 text-[12.5px]">{activeTab?.profile ?? 'default'}</div>
    </div>
  )
}
```
`ProgressBar.tsx` (Task 10의 chatStore 상태를 씀. 지금은 props로):
```tsx
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'

interface Props { running: boolean; label: string; toolCalls: number; max: number; onStop: () => void }

export function ProgressBar({ running, label, toolCalls, max, onStop }: Props): JSX.Element | null {
  const { t } = useTranslation()
  if (!running) return null
  return (
    <div className="flex items-center gap-3 border-b border-[var(--line)] bg-white px-3.5 py-2 text-[12.5px]">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)]/20 border-t-[var(--accent)]" />
      <b className="font-semibold">{label}</b>
      <span className="text-[var(--text3)]">{t('chat.toolCalls', { n: toolCalls, max })}</span>
      <span className="flex-1" />
      <button onClick={onStop} className="flex h-7 items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 font-medium text-[var(--danger)]">
        <Square className="h-2.5 w-2.5 fill-current" />{t('chat.stop')}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Sidebar / RightPanel(자리) / App**

`Sidebar.tsx`:
```tsx
import { useTranslation } from 'react-i18next'
import { Globe, ListChecks, Repeat, KeyRound, Smartphone, ScrollText, Settings } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

const ITEMS = [
  { key: 'browser', icon: Globe }, { key: 'tasks', icon: ListChecks }, { key: 'automation', icon: Repeat },
  { key: 'accounts', icon: KeyRound }, { key: 'phones', icon: Smartphone }, { key: 'logs', icon: ScrollText }
] as const

export function Sidebar({ width }: { width: number }): JSX.Element {
  const { t } = useTranslation()
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col border-r border-[var(--line)] bg-[#f6f6f8]/90 p-2.5 pt-10 backdrop-blur">
      <div className="flex items-center gap-2 px-2 pb-3 text-[14px] font-semibold"><span className="h-[22px] w-[22px] rounded-[7px] bg-[var(--text)]" />{t('app.name')}</div>
      {ITEMS.map(({ key, icon: Icon }) => (
        <div key={key} className={cn('flex items-center gap-2 rounded-[9px] px-2 py-1.5', key === 'browser' && 'bg-black/5 font-medium')}>
          <Icon className="h-4 w-4 text-[var(--text2)]" />{t(`sidebar.${key}`)}
        </div>
      ))}
      <div className="px-2 pb-1.5 pt-3 text-[11px] font-semibold text-[var(--text3)]">{t('sidebar.chats')}</div>
      <div className="mt-auto flex items-center gap-2 border-t border-black/5 px-2 pt-2 text-[var(--text2)]"><Settings className="h-4 w-4" />{t('sidebar.settings')}</div>
    </aside>
  )
}
```
`App.tsx`:
```tsx
import { useEffect } from 'react'
import { Sidebar } from '@renderer/components/layout/Sidebar'
import { RightPanel } from '@renderer/components/layout/RightPanel'
import { TabBar } from '@renderer/components/browser/TabBar'
import { AddressBar } from '@renderer/components/browser/AddressBar'
import { WebArea } from '@renderer/components/browser/WebArea'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'

export default function App(): JSX.Element {
  const { refresh, setTabs } = useBrowserStore()
  const { sidebarWidth, panelWidth } = useUiStore()
  useEffect(() => {
    void refresh()
    return window.samba.tabs.onUpdated(setTabs)
  }, [refresh, setTabs])
  return (
    <div className="flex h-full bg-[var(--bg)]">
      <Sidebar width={sidebarWidth} />
      <main className="flex min-w-0 flex-1 flex-col py-2.5 pr-2.5">
        <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
          <TabBar />
          <AddressBar />
          <WebArea />
        </div>
      </main>
      <RightPanel width={panelWidth} />
    </div>
  )
}
```
`RightPanel.tsx`(Task 10에서 채팅 삽입, 지금은 껍데기):
```tsx
export function RightPanel({ width }: { width: number }): JSX.Element {
  return <aside style={{ width }} className="flex shrink-0 flex-col gap-2.5 py-2.5 pr-2.5 pt-10">{/* ChatPanel은 Task 10 */}</aside>
}
```

- [ ] **Step 5: 수동 검수**

Run: `pnpm dev` → 확인 항목: ① 구글이 가운데 흰 카드 안에 정확히 맞춰 표시 ② 새 탭 + / 닫기 × ③ 주소창에 `naver.com` 입력 → 이동 ④ 뒤로/앞으로/새로고침 ⑤ 모바일 토글 → 모바일 레이아웃 ⑥ 창 크기 바꿔도 웹뷰가 카드에 맞음.

- [ ] **Step 6: 커밋**

```bash
git add -A && git commit -m "UI: 사이드바·탭바·주소창·웹뷰 영역 레이아웃 (애플 스타일)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: AI 채팅 패널 (메시지·진행 로그·입력·확인 팝업·인증 안내)

**Files:**
- Create: `src/renderer/stores/chatStore.ts`, `src/renderer/components/chat/{ChatPanel,MessageList,StepLog,ChatInput,ConfirmDialog,AuthBanner}.tsx`
- Modify: `src/renderer/components/layout/RightPanel.tsx`, `src/renderer/App.tsx`(ProgressBar 연결)

**Interfaces:**
- Consumes: `window.samba.agent.*`, `AgentEvent`
- Produces: `useChatStore` `{ messages, steps, status, toolCalls, confirm, authError, send(text), stop(), reply(id, ok), handleEvent(e) }`

- [ ] **Step 1: chatStore**

```ts
import { create } from 'zustand'
import type { AgentEvent } from '@shared/ipc'

export interface ChatMessage { id: string; role: 'user' | 'ai'; text: string; steps?: Step[] }
export interface Step { label: string; ok: boolean }

interface ChatState {
  messages: ChatMessage[]
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  toolCalls: number
  currentLabel: string
  confirm: { requestId: string; action: string } | null
  authError: 'missing' | 'limit' | null
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  reply: (requestId: string, approved: boolean) => void
  handleEvent: (e: AgentEvent) => void
}

let seq = 0
const nid = (): string => String(++seq)

// 진행 로그(step)는 마지막 AI 메시지에 붙인다
export const useChatStore = create<ChatState>((set, get) => ({
  messages: [], status: 'idle', toolCalls: 0, currentLabel: '', confirm: null, authError: null,
  send: async (text) => {
    if (get().status === 'running') return
    set((s) => ({ messages: [...s.messages, { id: nid(), role: 'user', text }, { id: nid(), role: 'ai', text: '', steps: [] }], status: 'running', toolCalls: 0, authError: null }))
    const r = await window.samba.agent.run(text)
    if (!r.ok) set({ status: 'failed', currentLabel: r.error })
  },
  stop: async () => { await window.samba.agent.stop() },
  reply: (requestId, approved) => { window.samba.agent.confirmReply(requestId, approved); set({ confirm: null }) },
  handleEvent: (e) => {
    const msgs = get().messages
    const last = msgs[msgs.length - 1]
    const patchLast = (p: Partial<ChatMessage>): void => set({ messages: [...msgs.slice(0, -1), { ...last, ...p }] })
    if (e.type === 'text' && last?.role === 'ai') patchLast({ text: last.text ? `${last.text}\n${e.text}` : e.text })
    if (e.type === 'step' && last?.role === 'ai') {
      patchLast({ steps: [...(last.steps ?? []), { label: e.label, ok: e.ok }] })
      set((s) => ({ toolCalls: s.toolCalls + 1, currentLabel: e.label }))
    }
    if (e.type === 'confirm') set({ confirm: { requestId: e.requestId, action: e.action } })
    if (e.type === 'status') {
      const auth = e.message?.startsWith('auth:') ? (e.message.slice(5) as 'missing' | 'limit') : null
      set({ status: e.state, authError: auth, toolCalls: e.toolCalls ?? get().toolCalls })
    }
  }
}))
```

- [ ] **Step 2: 컴포넌트**

`StepLog.tsx`:
```tsx
import { Check, X } from 'lucide-react'
import type { Step } from '@renderer/stores/chatStore'

export function StepLog({ steps, running }: { steps: Step[]; running: boolean }): JSX.Element | null {
  if (!steps.length) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-[12.5px] text-[var(--text2)]">
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1
        return (
          <div key={i} className="flex items-center gap-2">
            {running && isLast ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)]/20 border-t-[var(--accent)]" />
            ) : s.ok ? (
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--ok)]"><Check className="h-2.5 w-2.5 stroke-[3] text-white" /></span>
            ) : (
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--danger)]"><X className="h-2.5 w-2.5 stroke-[3] text-white" /></span>
            )}
            <span>{s.label}</span>
          </div>
        )
      })}
    </div>
  )
}
```
`MessageList.tsx`:
```tsx
import { useEffect, useRef } from 'react'
import { useChatStore } from '@renderer/stores/chatStore'
import { StepLog } from './StepLog'

export function MessageList(): JSX.Element {
  const { messages, status } = useChatStore()
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-3.5">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={m.id} className="max-w-[88%] self-end rounded-2xl rounded-br-[4px] bg-[var(--text)] px-3 py-2 leading-relaxed text-white">{m.text}</div>
        ) : (
          <div key={m.id} className="max-w-[94%] self-start leading-relaxed">
            <div className="whitespace-pre-wrap">{m.text}</div>
            <StepLog steps={m.steps ?? []} running={status === 'running' && i === messages.length - 1} />
          </div>
        )
      )}
      <div ref={end} />
    </div>
  )
}
```
`ChatInput.tsx`:
```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp } from 'lucide-react'
import { useChatStore } from '@renderer/stores/chatStore'

export function ChatInput(): JSX.Element {
  const { t } = useTranslation()
  const { send, status } = useChatStore()
  const [text, setText] = useState('')
  const submit = (): void => { const v = text.trim(); if (!v) return; setText(''); void send(v) }
  return (
    <div className="border-t border-black/5 p-3">
      <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
          placeholder={t('chat.placeholder')} disabled={status === 'running'} className="flex-1 bg-transparent outline-none" />
        <button onClick={submit} disabled={status === 'running'} className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-[var(--text)] text-white disabled:opacity-40"><ArrowUp className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  )
}
```
`ConfirmDialog.tsx`:
```tsx
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chatStore'

export function ConfirmDialog(): JSX.Element {
  const { t } = useTranslation()
  const { confirm, reply } = useChatStore()
  return (
    <Dialog open={!!confirm}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('confirm.title')}</DialogTitle></DialogHeader>
        <p className="text-[var(--text2)]">{t('confirm.body', { action: confirm?.action ?? '' })}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => confirm && reply(confirm.requestId, false)}>{t('confirm.deny')}</Button>
          <Button onClick={() => confirm && reply(confirm.requestId, true)}>{t('confirm.approve')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```
`AuthBanner.tsx`:
```tsx
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chatStore'

export function AuthBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const { authError } = useChatStore()
  if (!authError) return null
  return <div className="mx-3 mt-3 rounded-xl border border-[var(--warn)]/40 bg-[var(--warn)]/10 px-3 py-2 text-[12.5px]">{t(`auth.${authError}`)}</div>
}
```
`ChatPanel.tsx`:
```tsx
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chatStore'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { ConfirmDialog } from './ConfirmDialog'
import { AuthBanner } from './AuthBanner'

export function ChatPanel(): JSX.Element {
  const { t } = useTranslation()
  const handleEvent = useChatStore((s) => s.handleEvent)
  useEffect(() => window.samba.agent.onEvent(handleEvent), [handleEvent])
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]">
      <div className="flex items-center justify-between border-b border-black/5 px-3.5 py-3 font-semibold">
        {t('chat.title')}
        <span className="flex items-center gap-1.5 text-[12px] font-normal text-[var(--text2)]"><span className="h-[7px] w-[7px] rounded-full bg-[var(--ok)]" />Claude</span>
      </div>
      <AuthBanner />
      <MessageList />
      <ChatInput />
      <ConfirmDialog />
    </div>
  )
}
```
`RightPanel.tsx` 교체:
```tsx
import { ChatPanel } from '@renderer/components/chat/ChatPanel'
export function RightPanel({ width }: { width: number }): JSX.Element {
  return <aside style={{ width }} className="flex shrink-0 flex-col gap-2.5 py-2.5 pr-2.5 pt-10"><ChatPanel /></aside>
}
```
`App.tsx`에 ProgressBar 연결: `<AddressBar />` 아래에
```tsx
const chat = useChatStore()
// …
<ProgressBar running={chat.status === 'running'} label={chat.currentLabel || t('chat.thinking')} toolCalls={chat.toolCalls} max={40} onStop={() => void chat.stop()} />
```
(`useTranslation` import 추가.)

- [ ] **Step 3: 완료 기준 수동 검수 (강의 규칙: 15회 이상)**

Run: `pnpm dev`, 채팅에 입력:
1. `구글 열어서 '삼바웨이브' 검색해` → AI가 navigate → get_page → type(submit) → done. 로그에 단계 표시, 결과 페이지 표시.
2. `네이버 열어서 로그인 페이지로 가` → 로그인 페이지 도착 후 done. 비밀번호 칸 입력 시도 안 함.
3. `쿠팡에서 콜라 검색해서 첫 상품 열어` → 상품 페이지.
4. 실행 중 [중단] → 즉시 멈추고 status stopped.
5. `이 페이지에서 결제하기 눌러`(위험 단어) → 확인 팝업 → 거부 → AI가 중단 보고.
6. 도구 호출 40회 초과 유도(`계속 스크롤해`) → 상한 메시지 후 done.
7. `claude logout` 상태에서 실행 → 노란 인증 안내 띠.
8~15. 위 1~3을 다른 사이트(다나와, 무신사, 11번가 등)로 반복, 실패 케이스 기록.

체크리스트 결과를 `docs/검수/2026-09-18-1단계.md`에 표로 기록(사이트 · 지시 · 성공/실패 · 원인).

- [ ] **Step 4: 커밋**

```bash
git add -A && git commit -m "UI: AI 채팅 패널, 진행 로그, 확인 팝업, 인증 안내

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 초보자용 실행 문서 + 정리

**Files:**
- Create: `docs/실행방법.md`, `README.md`
- Modify: `.gitignore`(out/, dist/, node_modules/, *.log, .env)

- [ ] **Step 1: docs/실행방법.md**

```markdown
# 삼바브라우저 실행 방법 (초보자용)

## 1. 준비물 (한 번만)
1. Node.js 20 이상 — 이미 설치됨 (터미널에서 `node -v` 로 확인)
2. pnpm — 터미널에서 `corepack enable` 한 번 실행
3. Claude Code 로그인 — 터미널에서 `claude` 실행 후 로그인돼 있으면 끝. 안 돼 있으면 `claude login`

## 2. 처음 실행
1. 터미널 열기 (Windows 키 → "터미널")
2. `cd C:\Users\canno\workspace\samba_browser`
3. `pnpm install` (부품 내려받기, 1~3분)
4. `pnpm dev` → 브라우저 창이 뜸

## 3. 매일 실행
터미널에서 `cd C:\Users\canno\workspace\samba_browser` → `pnpm dev`

## 4. 써보기
- 오른쪽 채팅에 "구글 열어서 삼바웨이브 검색해" 입력 → AI가 진행 로그를 보여주며 수행
- 진행 띠의 [중단]으로 멈춤
- 주소창 옆 PC / 모바일 로 화면 전환

## 5. 문제가 생기면
| 증상 | 해결 |
|---|---|
| 채팅에 노란 띠 "AI 연결이 안 됐어요" | 터미널에서 `claude login` |
| "사용 한도" 띠 | 몇 시간 뒤 재시도 또는 설정에서 API 키 |
| 창은 뜨는데 웹페이지가 안 보임 | 창 크기 한 번 바꿔보기, 그래도 안 되면 `pnpm dev` 재실행 |
| `pnpm` 없다고 나옴 | `corepack enable` 후 터미널 다시 열기 |

## 6. 코드 검사
- `pnpm test` — 자동 테스트
- `pnpm lint` — 코드 규칙 검사
```

- [ ] **Step 2: README.md** — 한 줄 소개 + 문서 링크(PRD, 기술스택, 실행방법, 계획).

- [ ] **Step 3: 최종 확인 및 커밋**

Run: `pnpm test && pnpm lint && pnpm build` → 전부 통과
```bash
git add -A && git commit -m "문서: 실행방법·README, MVP 1단계 완료

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 자체 점검 결과

- **스펙 커버리지**: 창·탭·프로필(T5) / PC↔모바일(T6,T9) / AI 채팅·도구 루프(T8,T10) / 스냅샷·실행기·SECRET 차단(T4) / 위험 단어 확인·40회 상한·중단(T8,T10) / 인증 실패 안내(T8,T10) / 설정 파일(T7) / i18n(T2) / 초보자 문서(T11). 스펙의 "패널 폭 드래그 조절"과 "채팅 목록 사이드바"는 2단계로 이월(폭은 uiStore에 준비됨).
- **플레이스홀더**: 없음. 모든 코드 단계에 코드 포함.
- **타입 일관성**: `TabInfo/Layout/AgentEvent/Settings`(T3) ↔ T5·T7·T9·T10 동일. `pageBridge` 메서드명(T5) ↔ T8 동일. `SAMBA_TOOL_NAMES` 접두사 `mcp__samba__` ↔ 서버명 `samba` 일치.
- **위험 지점**: Agent SDK 메시지 타입 경로(`msg.message.content`)와 `WebContentsView` 가시성 판정(`getBounds`)은 실제 버전에서 컴파일 오류 시 SDK d.ts / Electron 문서 기준으로 수정.
