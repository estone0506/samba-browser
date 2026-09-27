// 로그인 폼 제출 뒤 그 탭을 잠깐 지켜보다가 "로그인 성공"으로 보이면 콜백을 부른다.
// 저장 제안 확인 바(vault-capture)는 성공한 로그인만 묻는다 — 틀린 비밀번호를 저장하자고 하지 않게.
// electron 의존이 있어(WebContents 이벤트·격리 월드 호출) 단위 테스트 대상은 아니다 —
// 판정 로직 자체(judgeLoginOutcome)는 login-success.ts 의 순수 함수로 테스트한다.
//
// 값(비밀번호)은 이 모듈을 지나지 않는다. 호출부가 콜백 클로저 안에 들고 있다가 성공일 때만 쓰고,
// 실패·시간 초과·탭 닫힘이면 onSettled(false) 로 알려 호출부가 버리게 한다.

import type { WebContents } from 'electron'
import { judgeLoginOutcome } from './login-success'
import { ISOLATED_WORLD_ID } from '../browser/page-bridge'

// 로그인 성공 판정 대기 최대 시간
export const LOGIN_WATCH_TIMEOUT_MS = 20_000
// 화면을 다시 들여다보는 간격. 첫 확인도 이만큼 뒤다(제출 직후 화면은 아직 그대로다)
const LOGIN_WATCH_POLL_MS = 1_200

// 탭마다 지켜보는 건 하나뿐이다 — 같은 탭에서 다시 제출하면 앞의 것은 버린다
const watchers = new WeakMap<WebContents, () => void>()

// 격리 월드의 __samba 로 페이지 텍스트와 비밀번호 칸 유무를 읽는다. 값은 읽지 않는다
async function observe(wc: WebContents): Promise<{ text: string; passwordVisible?: boolean }> {
  const run = async (code: string): Promise<unknown> => {
    try {
      return await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }])
    } catch {
      return undefined
    }
  }
  const snap = await run('__samba.snapshot()')
  const fields = await run('__samba.findLoginFields()')
  const text =
    snap && typeof snap === 'object' && typeof (snap as { text?: unknown }).text === 'string'
      ? (snap as { text: string }).text
      : ''
  let passwordVisible: boolean | undefined
  if (fields && typeof fields === 'object') {
    passwordVisible = typeof (fields as { password?: unknown }).password === 'number'
  }
  return { text, passwordVisible }
}

/**
 * 탭을 지켜보다가 로그인 성공이면 onSettled(true), 실패·시간 초과·탭 닫힘·새 제출로 대체되면 onSettled(false).
 * onSettled 는 정확히 한 번 불린다
 */
export function watchLoginOutcome(
  wc: WebContents,
  prevUrl: string,
  onSettled: (success: boolean) => void
): void {
  // 같은 탭의 이전 감시는 버린다(그 제출의 값도 호출부가 버린다)
  watchers.get(wc)?.()
  if (wc.isDestroyed()) {
    onSettled(false)
    return
  }

  let settled = false
  let checking = false
  const startedAt = Date.now()

  const finish = (success: boolean): void => {
    if (settled) return
    settled = true
    clearInterval(timer)
    // 감시마다 붙인 리스너를 떼어 낸다(한 탭에서 여러 번 로그인해도 리스너가 쌓이지 않게)
    if (!wc.isDestroyed()) wc.removeListener('destroyed', cancel)
    if (watchers.get(wc) === cancel) watchers.delete(wc)
    onSettled(success)
  }
  const cancel = (): void => finish(false)

  const tick = async (): Promise<void> => {
    if (settled || checking) return
    if (wc.isDestroyed() || Date.now() - startedAt > LOGIN_WATCH_TIMEOUT_MS) {
      finish(false)
      return
    }
    // 새 문서를 싣는 중에는 보지 않는다 — 빈 화면을 "비밀번호 칸이 사라짐"으로 오판한다
    if (wc.isLoading()) return
    checking = true
    try {
      const { text, passwordVisible } = await observe(wc)
      if (settled || wc.isDestroyed()) return
      const outcome = judgeLoginOutcome({ prevUrl, url: wc.getURL(), text, passwordVisible })
      if (outcome === 'success') finish(true)
      else if (outcome === 'failure') finish(false)
    } finally {
      checking = false
    }
  }

  const timer = setInterval(() => void tick(), LOGIN_WATCH_POLL_MS)
  timer.unref?.()
  watchers.set(wc, cancel)
  wc.once('destroyed', cancel)
}
