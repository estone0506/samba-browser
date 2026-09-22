// 하네스(밖에서 도는 주문처리 하네스)의 읽기 API 를 담아 두는 스토어.
//
// 하네스가 꺼져 있는 것은 정상이다 — 그때는 status 만 바꾸고 앞서 읽은 값은 그대로 둔다
// (화면이 깜빡이며 비지 않게). 밖을 바꾸는 것은 putRules 하나뿐이고, 확인은 화면이 받는다.
// getRules 는 브리프에는 없지만, 규칙 편집 모달이 "전체 교체" 전에 원문을 보여 주려면
// 있어야 해서 여기 같이 둔다(엔드포인트 자체는 Task 4 에서 이미 배선됨)
import { create } from 'zustand'
import type { HarnessGraph, HarnessJob, HarnessReleases, HarnessRules } from '@shared/harness'
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
  /** 그래프까지 전부 다시 읽는다(진입·수동 새로고침) */
  refresh: () => Promise<void>
  /** 5초 폴링 시작. 돌려주는 함수를 부르면 멈춘다(두 번 시작해도 타이머는 하나) */
  start: () => () => void
  /** 규칙 파일 전체 교체. 성공하면 그래프를 다시 읽는다 */
  putRules: (agent: string, text: string) => Promise<boolean>
  /** 규칙 원문 읽기(편집 모달이 빈 채로 열리지 않도록). 실패하면 null */
  getRules: (agent: string) => Promise<HarnessRules | null>
}

let timer: ReturnType<typeof setInterval> | null = null
// 폴링이 겹치지 않게(하네스가 느려 5초 안에 응답이 안 오면 다음 틱을 건너뛴다)와
// 응답이 보낸 순서와 반대로 돌아와도(느린 요청이 나중에 끝나는 경우) 낡은 값으로
// 덮어쓰지 않게 하는 두 가지 장치(리뷰 지적 — Minor 6)
let polling = false
let pollSeq = 0

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
    try {
      const [graph, jobs, releases] = await Promise.all([api.graph(), api.jobs(), api.releases()])
      // 세 응답 중 아무거나 하나라도 실패하면 그 사유를 연결 상태로 보인다(원인은 대개 하나다)
      const failed = [graph, jobs, releases].find((r) => !r.ok || r.data.status !== 'ok')
      if (failed !== undefined) {
        const reason = failed.ok
          ? failed.data
          : { status: 'offline' as HarnessStatus, error: 'ipc' }
        set({ status: reason.status, error: reason.error })
      } else {
        set({ status: 'ok', error: '' })
      }
      if (graph.ok && graph.data.data !== null) set({ graph: graph.data.data })
      if (jobs.ok && jobs.data.data !== null) set({ jobs: jobs.data.data.jobs })
      if (releases.ok && releases.data.data !== null) set({ releases: releases.data.data })
    } catch {
      // IPC 채널 자체가 던지는 경우(프리로드 오류 등) — 여기서 삼켜 화면이 죽지 않게 한다
      set({ status: 'offline', error: 'ipc' })
    }
  },

  start: () => {
    void get().refresh()
    if (timer === null) {
      // 등록부(그래프)는 자주 바뀌지 않는다 — 폴링은 작업·판정만 다시 읽는다
      timer = setInterval(() => {
        // 이전 폴링이 5초 안에 안 끝났으면 겹쳐 쏘지 않고 이번 틱은 건너뛴다
        if (polling) return
        polling = true
        const mySeq = ++pollSeq
        const api = window.samba.harness
        Promise.all([api.jobs(), api.releases()])
          .then(([jobs, releases]) => {
            // 그사이 더 최근 폴링이 시작됐으면(이례적으로 응답이 역전되면) 낡은 결과는 버린다
            if (mySeq !== pollSeq) return
            const failed = [jobs, releases].find((r) => !r.ok || r.data.status !== 'ok')
            if (failed !== undefined) {
              const reason = failed.ok
                ? failed.data
                : { status: 'offline' as HarnessStatus, error: 'ipc' }
              set({ status: reason.status, error: reason.error })
            } else {
              set({ status: 'ok', error: '' })
            }
            if (jobs.ok && jobs.data.data !== null) set({ jobs: jobs.data.data.jobs })
            if (releases.ok && releases.data.data !== null) set({ releases: releases.data.data })
          })
          .catch(() => {
            if (mySeq !== pollSeq) return
            set({ status: 'offline', error: 'ipc' })
          })
          .finally(() => {
            polling = false
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
  },

  getRules: async (agent) => {
    const r = await window.samba.harness.getRules(agent)
    if (!r.ok || r.data.status !== 'ok' || r.data.data === null) return null
    return r.data.data
  }
}))
