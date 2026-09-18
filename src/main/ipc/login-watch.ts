// 저장된 값과 다른 값으로 로그인 폼이 제출됐을 때(vault-capture.ts 의 'pending-update'),
// 해당 탭의 navigation 을 최대 20초 지켜보고 로그인 성공을 감지하면 조용히 비밀번호를 갱신한다.
// electron 의존이 있어(WebContents 이벤트·isolated world 호출) 단위 테스트 대상은 아니다 —
// 판정 로직 자체(isLoginSuccess)는 login-success.ts 에 분리해 순수 함수로 테스트한다.

import type { WebContents } from 'electron'
import { isLoginSuccess } from './login-success'
import type { VaultService } from '../vault/service'
import { ISOLATED_WORLD_ID } from '../browser/page-bridge'
import type { PendingUpdatePayload } from './vault-capture'

// 로그인 성공 판정 대기 최대 시간(스펙: 20초)
export const LOGIN_WATCH_TIMEOUT_MS = 20_000

export interface PasswordUpdatedResult {
  host: string
  username: string
  undoToken: string
}

// 페이지 스냅샷에서 text 필드만 최소한으로 신뢰한다(나머지 필드는 쓰지 않으므로 검증하지 않는다)
async function readSnapshotText(wc: WebContents): Promise<string> {
  try {
    const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
      { code: '__samba.snapshot()' }
    ])
    if (raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string') {
      return (raw as { text: string }).text
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 탭의 navigation 을 지켜보다가 로그인 성공을 감지하면 vault.applyAutoPasswordUpdate() 를 호출하고
 * onUpdated 로 결과를 알린다. 실패 판정이거나 타임아웃이면 아무 통지 없이 조용히 폐기한다.
 */
export function watchLoginSuccess(
  wc: WebContents,
  prevUrl: string,
  payload: PendingUpdatePayload,
  vault: VaultService,
  onUpdated: (result: PasswordUpdatedResult) => void
): void {
  if (wc.isDestroyed()) return

  let settled = false
  const cleanup = (): void => {
    wc.off('did-navigate', onNavigate)
    wc.off('did-navigate-in-page', onNavigate)
    clearTimeout(timer)
  }

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    cleanup()
    // 타임아웃 → 폐기(알림 없음)
  }, LOGIN_WATCH_TIMEOUT_MS)
  timer.unref?.()

  const onNavigate = (): void => {
    if (settled || wc.isDestroyed()) return
    const newUrl = wc.getURL()
    void readSnapshotText(wc).then((text) => {
      if (settled) return
      const success = isLoginSuccess(prevUrl, newUrl, text)
      settled = true
      cleanup()
      if (!success) return
      try {
        const { undoToken } = vault.applyAutoPasswordUpdate({
          accountId: payload.accountId,
          username: payload.username,
          value: payload.password
        })
        onUpdated({ host: payload.host, username: payload.username, undoToken })
      } catch (e: unknown) {
        console.error('비밀번호 자동 갱신 실패', e instanceof Error ? e.message : String(e))
      }
    })
  }

  wc.on('did-navigate', onNavigate)
  wc.on('did-navigate-in-page', onNavigate)
}
