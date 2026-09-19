// 활동 기록기 — 이미 있는 두 길목을 엿보기만 한다(새 경로를 만들지 않는다).
//
//  - 지시·결과: 러너가 내보내는 AgentEvent 스트림(알림·예약이 이미 듣는 자리).
//  - 사이트: 탭 활성·이동 때 tab-manager 가 알려 주는 **호스트 한 조각**.
//
// 적지 않는 것: 전체 URL, 검색어, 페이지 제목·본문, 폼 입력, 비밀값.
// 지시문은 저장 직전에 sanitizePrompt(마스킹 → 자르기)를 반드시 거친다.

import { sanitizePrompt, toMinutes, type ActivityRecord } from '../../shared/activity'
import type { AgentEvent } from '../../shared/ipc'

export interface ActivityStoreAccess {
  append(record: ActivityRecord): void
}

export interface ActivityRecorderDeps {
  store: ActivityStoreAccess
  /** 설정의 activityRecording. 매번 새로 읽어 끄면 곧바로 멈춘다 */
  enabled: () => boolean
  now?: () => number
}

/** 지금 돌고 있는 작업 한 건 */
interface OpenRun {
  prompt: string
  startedAt: number
  playbook?: string
}

/** 지금 보고 있는 사이트 한 건 */
interface OpenVisit {
  host: string
  startedAt: number
}

export class ActivityRecorder {
  private run: OpenRun | null = null
  /** 다음 실행에 적용된 플레이북 이름(playbook 이벤트가 status 보다 먼저 올 수 있다) */
  private pendingPlaybook: string | undefined
  private prompt = ''
  private visit: OpenVisit | null = null
  private readonly now: () => number

  constructor(private readonly deps: ActivityRecorderDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** agent:run 핸들러가 부른다. 이 시점의 지시를 기억해 둔다(마스킹은 저장할 때) */
  notePrompt(prompt: string): void {
    this.prompt = prompt
    this.pendingPlaybook = undefined
  }

  /**
   * 러너 이벤트 한 건. 어떤 경우에도 예외를 던지지 않는다 —
   * 기록이 실패한다고 작업이 멈추면 안 된다
   */
  observeAgent(event: AgentEvent): void {
    try {
      if (!this.deps.enabled()) {
        this.run = null
        return
      }
      if (event.type === 'playbook') {
        this.pendingPlaybook = event.names[0]
        // 이미 시작한 실행이면 지금 붙인다(playbook 이벤트는 status 뒤에 올 수도 있다)
        if (this.run) this.run.playbook = event.names[0]
        return
      }
      if (event.type !== 'status') return
      if (event.state === 'running') {
        this.run = {
          prompt: this.prompt,
          startedAt: this.now(),
          ...(this.pendingPlaybook === undefined ? {} : { playbook: this.pendingPlaybook })
        }
        return
      }
      const open = this.run
      this.run = null
      // 사용자가 직접 멈춘 것(stopped)은 "한 일" 이 아니라 되풀이로 세지 않는다
      if (!open || event.state === 'stopped') return
      const at = this.now()
      const prompt = sanitizePrompt(open.prompt)
      if (prompt === '') return
      this.deps.store.append({
        t: 'run',
        at,
        prompt,
        ok: event.state === 'done',
        ms: Math.max(0, at - open.startedAt),
        ...(open.playbook === undefined ? {} : { playbook: open.playbook })
      })
    } catch (e) {
      console.warn('활동 기록(지시) 실패', e instanceof Error ? e.message : '')
    }
  }

  /**
   * 탭이 활성화되거나 다른 사이트로 옮겨 갔다. 호스트만 받는다.
   * 같은 호스트면 머문 시간이 이어지도록 아무것도 하지 않는다
   */
  noteVisit(host: string): void {
    try {
      if (!this.deps.enabled()) {
        this.visit = null
        return
      }
      if (host === '') return
      if (this.visit?.host === host) return
      this.closeVisit()
      this.visit = { host, startedAt: this.now() }
    } catch (e) {
      console.warn('활동 기록(방문) 실패', e instanceof Error ? e.message : '')
    }
  }

  /** 창이 닫힐 때 열려 있던 방문을 마무리한다 */
  flush(): void {
    try {
      this.closeVisit()
    } catch (e) {
      console.warn('활동 기록 마무리 실패', e instanceof Error ? e.message : '')
    }
  }

  private closeVisit(): void {
    const open = this.visit
    this.visit = null
    if (!open) return
    this.deps.store.append({
      t: 'visit',
      at: open.startedAt,
      host: open.host,
      minutes: toMinutes(this.now() - open.startedAt)
    })
  }
}
