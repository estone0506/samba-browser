// 캡차·2FA 사용자 넘김(handoff) 감시 루프.
//
// 사이트가 사람의 추가 확인을 요구하면 작업을 멈추고 사용자에게 화면을 넘긴다.
// 여기서는 "사용자가 처리했는가"만 지켜본다 — 캡차를 대신 푸는 일은 하지 않는다.
// electron 의존이 없도록 URL 조회·징후 재확인은 호출부가 함수로 넘긴다(테스트 가능).

// 넘김 결과. resumed 는 사용자가 처리해 자동 재개, skipped/aborted 는 카드 버튼,
// timeout 은 상한 시간까지 아무 변화가 없던 경우
export type HandoffOutcome = 'resumed' | 'skipped' | 'aborted' | 'timeout'

export interface HandoffResult {
  outcome: HandoffOutcome
  url: string
}

// 페이지 변화 확인 주기 3초
export const HANDOFF_POLL_MS = 3000
// 사용자 확인 대기 상한 10분
export const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000

export interface HandoffWatchDeps {
  // 현재 탭 URL(달라지면 사용자가 진행한 것으로 본다)
  currentUrl: () => string
  // 캡차·2FA 징후가 아직 남아 있는가(사라지면 사용자가 처리한 것으로 본다)
  stillBlocked: () => Promise<boolean>
  // 테스트에서 가짜 시계를 넣기 위한 대기 함수
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  timeoutMs?: number
  // 감시를 그만두라는 신호(사용자가 카드 버튼을 눌렀거나 작업이 중단됨)
  cancelled?: () => boolean
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    // 대기 타이머가 앱 종료를 막지 않게 한다
    t.unref?.()
  })

/**
 * 사용자가 추가 확인을 끝냈는지 주기적으로 살핀다.
 * URL 이 바뀌었거나 징후가 사라지면 'resumed', 상한 시간을 넘기면 'timeout',
 * 취소 신호가 오면 'cancelled' 를 돌려준다
 */
export async function watchHandoff(
  deps: HandoffWatchDeps
): Promise<{ outcome: 'resumed' | 'timeout' | 'cancelled'; url: string }> {
  const sleep = deps.sleep ?? defaultSleep
  const pollMs = deps.pollMs ?? HANDOFF_POLL_MS
  const timeoutMs = deps.timeoutMs ?? HANDOFF_TIMEOUT_MS
  const startUrl = deps.currentUrl()
  let waited = 0
  while (waited < timeoutMs) {
    await sleep(pollMs)
    waited += pollMs
    if (deps.cancelled?.()) return { outcome: 'cancelled', url: deps.currentUrl() }
    const url = deps.currentUrl()
    // 페이지가 옮겨 갔으면 사용자가 확인을 통과한 것으로 본다
    if (url !== startUrl) return { outcome: 'resumed', url }
    let blocked = true
    try {
      blocked = await deps.stillBlocked()
    } catch {
      // 페이지를 읽지 못하면(이동 중·탭 종료) 다음 주기에 다시 본다
      blocked = true
    }
    if (deps.cancelled?.()) return { outcome: 'cancelled', url: deps.currentUrl() }
    if (!blocked) return { outcome: 'resumed', url: deps.currentUrl() }
  }
  return { outcome: 'timeout', url: deps.currentUrl() }
}

/** 넘김 결과를 모델이 읽을 도구 응답 문자열로 바꾼다 */
export function handoffToolResult(r: HandoffResult): string {
  if (r.outcome === 'resumed') return `user completed the check; page changed to ${r.url}`
  if (r.outcome === 'skipped') return `user skipped the check; continue from ${r.url}`
  if (r.outcome === 'aborted') return 'stopped by user'
  return `needs_user: captcha — no response from the user; current page ${r.url}`
}
