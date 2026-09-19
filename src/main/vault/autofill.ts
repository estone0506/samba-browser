// 사용자 조작(상세 화면의 '자동 채우기' 버튼, 페이지 내 피커)으로 시작하는 자동 채움.
// AI 도구를 거치지 않고 메인이 직접 탭에 값을 넣는다 — 값은 IPC 로 나가지 않는다.

import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { VaultService } from './service'
import { checkVaultGate, isSecurePageUrl, sameRegistrableDomain } from './access-gate'
import { normalizeHost } from '../../shared/host'
import { DEFAULT_FIELD_KEY } from './fields'

// 결과 문자열. 값(평문)은 어떤 경우에도 담기지 않는다
export type AutofillResult =
  | 'ok'
  | 'filled-password-only'
  | 'no-active-tab'
  | 'locked'
  | 'insecure-page'
  | 'excluded'
  | 'host-mismatch'
  | 'account-not-found'
  | 'fields-not-found'
  | 'secret-not-found'
  | 'fill-failed'

export interface AutofillDeps {
  vault: VaultService
  activeTab: () => Tab | null
  excludedHosts: () => string[]
  /** 채운 뒤 로그인 폼을 바로 제출할지(계정 고르면 곧바로 로그인) */
  autoSubmit?: () => boolean
}

// 채울 대상을 호출부가 지정할 때 쓰는 값(피커 경로).
// 활성 탭이 아니라 요청을 보낸 탭에, 게이트가 검증한 호스트로만 채운다
export interface AutofillTarget {
  tab: Tab
  host: string
}

/**
 * 계정 하나를 로그인 폼에 채운다(아이디 + 비밀번호).
 * 대상 탭은 target 이 있으면 그 탭, 없으면 활성 탭이다.
 * 계정이 속한 호스트와 페이지 호스트의 등록 도메인(eTLD+1)이 다르면 채우지 않는다 —
 * nid.naver.com 계정을 www.naver.com 에 채우는 것은 허용하되(금고 목록과 같은 기준),
 * 전혀 다른 사이트로 새는 것은 막는다.
 */
export async function autofillAccount(
  deps: AutofillDeps,
  accountId: number,
  target?: AutofillTarget
): Promise<AutofillResult> {
  const tab = target?.tab ?? deps.activeTab()
  if (!tab) return 'no-active-tab'
  const url = tab.view.webContents.getURL()
  // 평문 페이지 판정을 먼저 본다(about: 등 호스트가 없는 주소도 'insecure-page' 로 알린다)
  if (!isSecurePageUrl(url)) return 'insecure-page'
  const gate = checkVaultGate({ url, excludedHosts: deps.excludedHosts() })
  if (gate === 'excluded') return 'excluded'
  if (gate !== null) return 'host-mismatch'
  const host = normalizeHost(url)
  // 피커 게이트가 검증한 발신 프레임 호스트와 탭의 현재 호스트가 어긋나면(그 사이 이동)
  // 채우지 않는다
  if (target && target.host !== host) return 'host-mismatch'
  if (deps.vault.state() !== 'unlocked') return 'locked'

  const account = deps.vault.getAccount(accountId)
  if (!account) return 'account-not-found'
  if (!sameRegistrableDomain(account.host, host)) return 'host-mismatch'

  const fields = await pageBridge.findLoginFields(tab)
  if (fields.password === undefined) return 'fields-not-found'

  // 사용자가 직접 누른 채움이므로 감사 로그의 주체는 'user' 다
  const password = deps.vault.getSecretForFill(
    account.id,
    'login',
    DEFAULT_FIELD_KEY,
    undefined,
    'user'
  )
  if (password === null) return 'secret-not-found'

  // 아이디 칸이 아예 없는 화면(2단계 로그인의 비밀번호 단계)은 채울 아이디가 없는 게 정상이다.
  // 반대로 칸이 있는데 금고 아이디가 비어 있으면 "채우지 못함"으로 본다 —
  // 빈 아이디로 폼을 제출하면 로그인 실패·계정 잠금으로 이어진다
  let usernameFilled = fields.username === undefined
  if (fields.username !== undefined && account.username) {
    usernameFilled = (await pageBridge.fillValue(tab, fields.username, account.username)) === 'ok'
  }
  const filled = await pageBridge.fillValue(tab, fields.password, password)
  if (filled !== 'ok') return 'fill-failed'
  // 계정을 고르면 로그인 버튼까지 눌러 준다(아이디까지 채운 경우만 — 비밀번호만 채웠으면 사용자가 확인)
  if (usernameFilled && deps.autoSubmit?.()) {
    try {
      await pageBridge.submitForm(tab, fields.password)
    } catch {
      // 제출 실패는 채우기 성공을 뒤집지 않는다 — 사용자가 버튼을 누르면 된다
    }
  }
  return usernameFilled ? 'ok' : 'filled-password-only'
}
