// 키마스터에 저장된 모든 사이트를 대상으로 자동 로그인을 1회씩 시도하는 결정적 E2E 하네스.
// AI(에이전트)를 전혀 쓰지 않고 tools.ts 의 login 도구와 같은 순서(폼 탐지 → 채움 → 제출 →
// 결과 판정)를 코드로 재현한다.
//
// 보안 규칙
// - 비밀번호·사용자명 평문은 결과 파일·로그 어디에도 남기지 않는다(오류 메시지도 치환한다)
// - 결과표의 사용자명은 앞 2글자만 남기고 마스킹한다
// - 스크린샷은 비밀 입력칸이 점(•)으로 렌더링되므로 값이 노출되지 않는다
//
// SAMBA_E2E_LOGIN 환경변수가 있을 때만 index.ts 에서 호출된다(평소 동작에는 영향이 없다).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { session } from 'electron'
import type { TabManager, Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { VaultService } from '../vault/service'
import type { AccountDto, SiteDto } from '../../shared/vault'
import { normalizeHost, registrableDomain } from '../../shared/host'
import { isHttpUrl } from '../../shared/url'

/** 자동 로그인 시도 1건의 판정 결과 */
export type LoginOutcome =
  | 'success'
  | 'captcha'
  | '2fa'
  | 'wrong_password'
  | 'sso_redirect'
  | 'no_form'
  | 'blocked'
  | 'error'
  | 'unknown'

export interface LoginHarnessDeps {
  tabs: TabManager
  vault: VaultService
}

export interface LoginHarnessOptions {
  // 'all' 이면 저장된 모든 사이트, 아니면 검사할 호스트 목록
  hosts: 'all' | string[]
  // 결과 Markdown 파일 경로
  outFile: string
  // 최대 사이트 수(0 이면 제한 없음)
  limit: number
  // 결과 파일에 이미 기록된 호스트를 건너뛸지 여부
  resume: boolean
}

// --- 판정용 정규식 ---------------------------------------------------------

// 로그인 페이지로 보이는 URL 인지 — "로그인 페이지를 벗어났는가" 판정에 쓴다
const LOGIN_URL_RE = /login|signin|sign-in|logon|nidlogin|\/auth/i
// 차단(WAF·봇 감지·권한 없음)
const BLOCKED_RE = /403\b|차단|접근이 거부|access denied|forbidden|cloudflare|잠시 후 다시/i
// 자동입력 방지 문자(캡차)
const CAPTCHA_RE = /captcha|보안문자|자동입력 방지|recaptcha|hcaptcha/i
// 2단계 인증·본인 확인
const TWO_FACTOR_RE = /인증번호|otp|2단계|verification code|본인 확인|본인확인/i
// 아이디·비밀번호 불일치
const WRONG_PASSWORD_RE =
  /비밀번호가 일치|틀렸|틀린|incorrect|invalid (password|id|login)|잘못|등록되지 않은/i
// 로그인 성공 뒤에만 보이는 문구
const SUCCESS_RE = /로그아웃|logout|마이페이지|my page|장바구니|내 정보|회원정보/i
// 아직 로그인 폼이 남아 있음을 시사하는 문구
const LOGIN_FORM_RE = /비밀번호|password|passwd/i
// 외부 SSO 제공자 호스트
const SSO_HOSTS = ['accounts.google.com', 'kakao.com', 'naver.com', 'apple.com']

/** URL 이 외부 SSO 제공자로 넘어갔는지 — 원래 사이트와 등록 도메인이 다를 때만 SSO 로 본다 */
function isSsoRedirect(prevUrl: string, url: string): boolean {
  const from = normalizeHost(prevUrl)
  const to = normalizeHost(url)
  if (!to || !from) return false
  if (registrableDomain(from) === registrableDomain(to)) return false
  return SSO_HOSTS.some((h) => {
    const sso = normalizeHost(h)
    return to === sso || registrableDomain(to) === registrableDomain(sso)
  })
}

/**
 * 제출 직후의 URL·본문 텍스트만으로 로그인 결과를 판정하는 순수 함수.
 * 우선순위: 차단 > 캡차 > 2단계 인증 > 비밀번호 오류 > SSO 이동 > 성공 > 알 수 없음.
 */
export function classifyLoginOutcome(prevUrl: string, url: string, text: string): LoginOutcome {
  if (BLOCKED_RE.test(text)) return 'blocked'
  if (CAPTCHA_RE.test(text)) return 'captcha'
  if (TWO_FACTOR_RE.test(text)) return '2fa'
  if (WRONG_PASSWORD_RE.test(text)) return 'wrong_password'
  if (isSsoRedirect(prevUrl, url)) return 'sso_redirect'
  // 로그인 페이지를 벗어났고, 성공 문구가 보이거나 로그인 폼 흔적이 사라졌으면 성공으로 본다
  const leftLoginPage = url !== prevUrl && !LOGIN_URL_RE.test(url)
  if (leftLoginPage && (SUCCESS_RE.test(text) || !LOGIN_FORM_RE.test(text))) return 'success'
  // URL 이 그대로여도(SPA) 성공 문구만 남고 로그인 폼이 사라졌으면 성공으로 본다
  if (SUCCESS_RE.test(text) && !LOGIN_FORM_RE.test(text)) return 'success'
  return 'unknown'
}

/** 사용자명 마스킹 — 앞 2글자만 남기고 `***` 를 붙인다 */
export function maskUsername(username: string): string {
  return `${username.slice(0, 2)}***`
}

/**
 * 결과표 비고에 들어갈 문자열에서 비밀값(사용자명·비밀번호)을 지우고, 표를 깨뜨리는
 * 개행·파이프 문자를 정리한다. 3글자 미만 값은 오탐이 커서 치환하지 않는다.
 */
export function sanitizeNote(note: string, secrets: string[]): string {
  let out = note
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join('***')
  }
  return out.replace(/\r?\n/g, ' ').replace(/\|/g, '/').trim().slice(0, 200)
}

// --- 유틸 -------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 주어진 시간 안에 끝나지 않으면 거부한다(고아가 된 작업의 거부는 여기서 흡수된다) */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${label} 하드 타임아웃 ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        res(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        rej(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** 사이트 한 곳의 결과 한 줄 */
interface SiteResult {
  index: number
  host: string
  account: string
  formDetected: boolean
  filled: boolean
  submitted: boolean
  result: LoginOutcome
  note: string
}

function toRow(r: SiteResult): string {
  const yn = (b: boolean): string => (b ? 'O' : 'X')
  return `| ${r.index} | ${r.host} | ${r.account} | ${yn(r.formDetected)} | ${yn(r.filled)} | ${yn(
    r.submitted
  )} | ${r.result} | ${r.note} |`
}

/** 결과 파일에서 이미 기록된 호스트와 마지막 번호를 읽는다(중단 후 이어하기용) */
function readProgress(outPath: string): { hosts: Set<string>; lastIndex: number } {
  const hosts = new Set<string>()
  let lastIndex = 0
  if (!existsSync(outPath)) return { hosts, lastIndex }
  for (const line of readFileSync(outPath, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/.exec(line)
    if (!m) continue
    lastIndex = Math.max(lastIndex, Number(m[1]))
    hosts.add(m[2])
  }
  return { hosts, lastIndex }
}

/** 자바스크립트 대화상자를 자동 수락하고 메시지를 모은다. 해제 함수를 돌려준다 */
function attachDialogHandler(tab: Tab, onMessage: (message: string) => void): () => void {
  const wc = tab.view.webContents
  const listener = (_e: Electron.Event, method: string, params: unknown): void => {
    if (method !== 'Page.javascriptDialogOpening') return
    const message =
      typeof params === 'object' && params !== null && 'message' in params
        ? String((params as { message: unknown }).message)
        : ''
    onMessage(message)
    wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
  }
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    wc.debugger.on('message', listener)
    void wc.debugger.sendCommand('Page.enable').catch(() => {})
  } catch {
    // 디버거를 붙이지 못해도 나머지 검증은 계속한다
    return () => {}
  }
  return () => {
    try {
      wc.debugger.off('message', listener)
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // 이미 파괴된 탭이면 무시한다
    }
  }
}

/** 로그인 링크·버튼을 텍스트로 찾아 한 번 눌러 본다. 눌렀으면 true */
async function clickLoginLink(tab: Tab): Promise<boolean> {
  const snapshot = await pageBridge.snapshot(tab)
  const target = snapshot.elements.find((el) =>
    /^(로그인|로그인하기|login|sign\s?in)$/i.test(el.text.trim())
  )
  if (!target) return false
  await pageBridge.click(tab, target.id)
  await pageBridge.waitForLoad(tab, 15_000)
  await sleep(1500)
  return true
}

/** 세션 파티션의 저장 데이터를 비운다(디스크 사용량 억제) */
async function clearPartition(profile: string): Promise<void> {
  try {
    await session.fromPartition(`persist:${profile}`).clearStorageData()
  } catch {
    // 파티션이 없거나 이미 정리됐으면 무시한다
  }
}

/** 화면을 640px 폭 JPEG 로 저장한다(용량 절감). 실패해도 검증은 계속한다 */
async function capture(tab: Tab, shotDir: string, host: string): Promise<boolean> {
  try {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return false
    const image = await wc.capturePage()
    const { width } = image.getSize()
    const resized = width > 640 ? image.resize({ width: 640 }) : image
    writeFileSync(join(shotDir, `${host}.png`), resized.toJPEG(70))
    return true
  } catch {
    return false
  }
}

// --- 사이트 1곳 검증 ---------------------------------------------------------

/** 탭을 만들고 로그인 절차를 진행한다. 결과 필드를 result 에 채워 넣는다 */
async function driveLogin(
  deps: LoginHarnessDeps,
  tab: Tab,
  account: AccountDto,
  result: SiteResult,
  shotDir: string
): Promise<void> {
  await pageBridge.waitForLoad(tab, 15_000)
  let fields = await pageBridge.findLoginFields(tab)

  // 비밀번호 칸이 안 보이면 로그인 링크를 한 번 눌러 보고 다시 탐지한다
  if (fields.password === undefined && (await clickLoginLink(tab))) {
    fields = await pageBridge.findLoginFields(tab)
  }
  if (fields.password === undefined) {
    result.result = 'no_form'
    result.note = '로그인 폼을 찾지 못함'
    await capture(tab, shotDir, result.host)
    return
  }
  result.formDetected = true

  const password = deps.vault.getSecretForFill(account.id, 'login_password', 'e2e')
  if (password === null) {
    result.result = 'error'
    result.note = '저장된 로그인 비밀번호 없음'
    return
  }

  // 사용자명은 비밀값이 아니라 평문으로, 비밀번호는 값이 로그에 남지 않는 fillValue 로만 채운다
  if (fields.username !== undefined) {
    const filledUser = await pageBridge.fillValue(tab, fields.username, account.username)
    if (filledUser !== 'ok') {
      result.result = 'error'
      result.note = '아이디 입력 실패'
      return
    }
  }
  const filledPassword = await pageBridge.fillValue(tab, fields.password, password)
  if (filledPassword !== 'ok') {
    result.result = 'error'
    result.note = '비밀번호 입력 실패'
    return
  }
  result.filled = true

  const prevUrl = tab.view.webContents.getURL()
  const submitted = await pageBridge.submitForm(tab, fields.submit ?? fields.password)
  if (submitted !== 'ok') {
    result.result = 'error'
    result.note = '제출 실패'
    return
  }
  result.submitted = true

  await pageBridge.waitForLoad(tab, 15_000)
  // SPA 는 로딩 종료 이후에도 결과 렌더링이 남아 있어 잠깐 더 기다린다
  await sleep(2500)

  const snapshot = await pageBridge.snapshot(tab)
  result.result = classifyLoginOutcome(prevUrl, snapshot.url, `${snapshot.title} ${snapshot.text}`)
  if (!(await capture(tab, shotDir, result.host))) result.note = '스크린샷 실패'
}

/** 사이트 한 곳을 검증한다. 탭 생성·정리·대화상자 처리는 모두 여기서 책임진다 */
async function runSite(
  deps: LoginHarnessDeps,
  site: SiteDto,
  index: number,
  shotDir: string
): Promise<SiteResult> {
  const host = normalizeHost(site.host) || site.host
  const result: SiteResult = {
    index,
    host,
    account: '-',
    formDetected: false,
    filled: false,
    submitted: false,
    result: 'error',
    note: ''
  }

  const accounts = deps.vault.listAccounts(host)
  const account = accounts.find((a) => a.isDefault) ?? accounts[0]
  if (!account) {
    result.note = '저장된 계정 없음'
    return result
  }
  result.account = `${account.label} (${maskUsername(account.username)})`

  const profile = `e2e-${host}`
  const startUrl = site.loginUrl && isHttpUrl(site.loginUrl) ? site.loginUrl : `https://${host}/`
  const dialogs: string[] = []
  let tabId: string | undefined
  try {
    const info = deps.tabs.create({ url: startUrl, profile })
    tabId = info.id
    const tab = deps.tabs.get(info.id)
    if (!tab) throw new Error('탭 생성 실패')
    const detach = attachDialogHandler(tab, (m) => dialogs.push(m))
    try {
      await withTimeout(driveLogin(deps, tab, account, result, shotDir), 45_000, host)
    } finally {
      detach()
    }
  } catch (e: unknown) {
    result.result = 'error'
    result.note = e instanceof Error ? e.message : String(e)
  } finally {
    if (tabId) deps.tabs.close(tabId)
    await clearPartition(profile)
  }

  if (dialogs.length > 0) {
    const joined = dialogs.join(' / ')
    result.note = result.note ? `${result.note} / 대화상자: ${joined}` : `대화상자: ${joined}`
  }
  return result
}

// --- 전체 실행 --------------------------------------------------------------

const HEADER_COLUMNS =
  '| # | 사이트 | 계정 | 폼 인식 | 채움 | 제출 | 결과 | 비고 |\n|---|---|---|---|---|---|---|---|'

/** 결과 파일 전체를 다시 읽어 결과별 건수를 집계한 요약 블록을 덧붙인다 */
function appendSummary(outPath: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of readFileSync(outPath, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*\d+\s*\|(?:[^|]*\|){5}\s*([a-z_0-9]+)\s*\|/.exec(line)
    if (!m) continue
    counts[m[1]] = (counts[m[1]] ?? 0) + 1
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const lines = [
    '',
    `## 요약 (${new Date().toISOString()})`,
    '',
    `- 총 ${total}건`,
    ...Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- ${k}: ${v}건`),
    ''
  ]
  appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
  return counts
}

/** 금고가 잠겨 검증을 시작조차 못했을 때 결과 파일에 사유만 남긴다 */
export function writeVaultLocked(outFile: string): void {
  const outPath = resolve(process.cwd(), outFile)
  mkdirSync(dirname(outPath), { recursive: true })
  appendFileSync(outPath, `\nvault locked (${new Date().toISOString()})\n`, 'utf8')
}

/**
 * 키마스터에 저장된 사이트를 호스트 순으로 순회하며 자동 로그인을 1회씩 시도하고,
 * 결과를 한 줄씩 즉시 Markdown 파일에 덧붙인다(도중에 죽어도 진행분이 남는다).
 */
export async function runLoginHarness(
  deps: LoginHarnessDeps,
  options: LoginHarnessOptions
): Promise<void> {
  const outPath = resolve(process.cwd(), options.outFile)
  const shotDir = resolve(process.cwd(), 'docs/검수/e2e-login')
  mkdirSync(dirname(outPath), { recursive: true })
  mkdirSync(shotDir, { recursive: true })

  const wanted =
    options.hosts === 'all' ? null : new Set(options.hosts.map((h) => normalizeHost(h)))
  let sites = deps.vault
    .listSites()
    .map((s) => ({ ...s, host: normalizeHost(s.host) || s.host }))
    .filter((s) => wanted === null || wanted.has(s.host))
    .sort((a, b) => a.host.localeCompare(b.host))

  const progress = options.resume
    ? readProgress(outPath)
    : { hosts: new Set<string>(), lastIndex: 0 }
  if (!existsSync(outPath) || !options.resume) {
    writeFileSync(
      outPath,
      `# 전체 사이트 자동 로그인 E2E 결과 (${new Date().toISOString()})\n\n${HEADER_COLUMNS}\n`,
      'utf8'
    )
  }
  sites = sites.filter((s) => !progress.hosts.has(s.host))
  if (options.limit > 0) sites = sites.slice(0, options.limit)

  console.log(`[e2e] 대상 사이트 ${sites.length}곳 (건너뜀 ${progress.hosts.size}곳)`)

  let index = progress.lastIndex
  for (const site of sites) {
    index += 1
    // 오류 메시지에 섞일 수 있는 비밀값 후보(해당 호스트 계정의 사용자명)를 미리 모아 둔다
    const secrets = deps.vault.listAccounts(site.host).map((a) => a.username)
    const row = await runSite(deps, site, index, shotDir)
    row.note = sanitizeNote(row.note, secrets)
    appendFileSync(outPath, `${toRow(row)}\n`, 'utf8')
    console.log(`[e2e] ${index} ${row.host} → ${row.result}`)
    await sleep(2000)
  }

  const counts = appendSummary(outPath)
  console.log(`[e2e] 완료: ${JSON.stringify(counts)}`)
}
