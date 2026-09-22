// 설정(harnessApiUrl) → 하네스 클라이언트. handlers 가 IPC 4개를 여기에 건다.
// 주소는 호출마다 설정에서 다시 읽는다 — 설정을 고치면 앱을 다시 켜지 않아도 된다
import { HarnessClient, type HarnessResult } from './client'
import type { Settings } from '../../shared/settings'
import type {
  HarnessGraph,
  HarnessJobs,
  HarnessReleases,
  HarnessRules,
  HarnessRulesSaved
} from '../../shared/harness'

export interface HarnessApi {
  graph(): Promise<HarnessResult<HarnessGraph>>
  jobs(): Promise<HarnessResult<HarnessJobs>>
  releases(): Promise<HarnessResult<HarnessReleases>>
  // 규칙 파일 원문 조회(편집 모달을 채우는 용도). 브리프에는 없지만 저장 전 원문을 보여주려면 필요해 추가했다
  getRules(agent: string): Promise<HarnessResult<HarnessRules>>
  putRules(agent: string, text: string): Promise<HarnessResult<HarnessRulesSaved>>
}

export function createHarnessApi(
  settings: () => Settings,
  fetchImpl?: typeof globalThis.fetch
): HarnessApi {
  const client = new HarnessClient({
    url: () => settings().harnessApiUrl,
    ...(fetchImpl === undefined ? {} : { fetchImpl })
  })
  return {
    graph: () => client.graph(),
    jobs: () => client.jobs(),
    releases: () => client.releases(),
    getRules: (agent) => client.getRules(agent),
    putRules: async (agent, text) => {
      // 빈 규칙은 파일을 날리는 것과 같다 — 하네스에 가기 전에 막는다
      if (text.trim() === '') {
        return { status: 'bad-response', data: null, error: 'empty rules' }
      }
      return client.putRules(agent, text)
    }
  }
}
