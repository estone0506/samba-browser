// 사용자 조작(상세 화면의 '자동 채우기' 버튼, 페이지 내 피커)으로 시작하는 자동 채움.
// AI 도구를 거치지 않고 메인이 직접 활성 탭에 값을 넣는다 — 값은 IPC 로 나가지 않는다.

import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { VaultService } from './service'
import { isSecurePageUrl } from '../agent/tools'
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
}

/**
 * 계정 하나를 현재 탭의 로그인 폼에 채운다(아이디 + 비밀번호).
 * 계정이 속한 호스트와 현재 탭의 호스트가 다르면 채우지 않는다(다른 사이트로 새는 것 방지).
 */
export async function autofillAccount(
  deps: AutofillDeps,
  accountId: number
): Promise<AutofillResult> {
  const tab = deps.activeTab()
  if (!tab) return 'no-active-tab'
  const url = tab.view.webContents.getURL()
  if (!isSecurePageUrl(url)) return 'insecure-page'
  const host = normalizeHost(url)
  if (!host) return 'host-mismatch'
  if (deps.excludedHosts().some((h) => (normalizeHost(h) || h) === host)) return 'excluded'
  if (deps.vault.state() !== 'unlocked') return 'locked'

  const account = deps.vault.getAccount(accountId)
  if (!account) return 'account-not-found'
  if (account.host !== host) return 'host-mismatch'

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

  let usernameFilled = true
  if (fields.username !== undefined && account.username) {
    usernameFilled = (await pageBridge.fillValue(tab, fields.username, account.username)) === 'ok'
  }
  const filled = await pageBridge.fillValue(tab, fields.password, password)
  if (filled !== 'ok') return 'fill-failed'
  return usernameFilled ? 'ok' : 'filled-password-only'
}
