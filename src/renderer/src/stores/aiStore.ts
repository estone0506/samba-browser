import { create } from 'zustand'
import type {
  AiProviderId,
  AiProviderStatus,
  ApiKeyVendor,
  TaskModelKey,
  TaskModels
} from '@shared/ai'

// AI 연결 화면 상태.
// 평문 API 키는 setApiKey 로 메인에 넘어가기만 하고 되돌아오지 않는다 —
// 여기 남는 것은 마스킹 문자열(maskedKeys)과 boolean 뿐이다
interface AiStoreState {
  providers: AiProviderStatus[]
  provider: AiProviderId
  taskModels: TaskModels | null
  choices: string[]
  loading: boolean
  error: string | null
  /** 제공자를 바꾸면서 자동 대체된 작업 등급(알림 띠에 쓴다) */
  remapped: TaskModelKey[]
  /** '연결 확인' 결과 — 제공자별 성공/실패 */
  testResults: Partial<Record<ApiKeyVendor, 'ok' | 'fail' | 'testing'>>
  load: () => Promise<void>
  setProvider: (id: AiProviderId) => Promise<void>
  setApiKey: (vendor: ApiKeyVendor, key: string) => Promise<void>
  testKey: (vendor: ApiKeyVendor, key: string) => Promise<void>
  setTaskModel: (key: TaskModelKey, model: string) => Promise<void>
  dismissRemapped: () => void
}

export const useAiStore = create<AiStoreState>((set, get) => ({
  providers: [],
  provider: 'claude_subscription',
  taskModels: null,
  choices: [],
  loading: false,
  error: null,
  remapped: [],
  testResults: {},

  load: async () => {
    set({ loading: true, error: null })
    const [providers, models] = await Promise.all([
      window.samba.ai.providers(),
      window.samba.ai.taskModels()
    ])
    if (!providers.ok) {
      set({ loading: false, error: providers.error })
      return
    }
    if (!models.ok) {
      set({ loading: false, error: models.error, providers: providers.data })
      return
    }
    set({
      providers: providers.data,
      provider: models.data.provider,
      taskModels: models.data.taskModels,
      choices: models.data.choices,
      loading: false
    })
  },

  setProvider: async (id) => {
    const r = await window.samba.ai.setProvider(id)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    set({ provider: r.data.provider, taskModels: r.data.taskModels, remapped: r.data.changed })
    // 제공자가 바뀌면 고를 수 있는 모델 목록도 달라진다
    const models = await window.samba.ai.taskModels()
    if (models.ok) set({ choices: models.data.choices })
  },

  setApiKey: async (vendor, key) => {
    const r = await window.samba.ai.setApiKey(vendor, key)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    // 마스킹 결과를 '내 API 키' 카드에 반영한다
    set({
      providers: get().providers.map((p) =>
        p.id === 'api_key' ? { ...p, maskedKeys: r.data } : p
      ),
      testResults: { ...get().testResults, [vendor]: undefined }
    })
  },

  testKey: async (vendor, key) => {
    set({ testResults: { ...get().testResults, [vendor]: 'testing' } })
    const r = await window.samba.ai.testKey(vendor, key)
    const result = r.ok && r.data.ok ? 'ok' : 'fail'
    set({ testResults: { ...get().testResults, [vendor]: result } })
  },

  setTaskModel: async (key, model) => {
    const r = await window.samba.ai.setTaskModel(key, model)
    if (r.ok) set({ taskModels: r.data, error: null })
    else set({ error: r.error })
  },

  dismissRemapped: () => set({ remapped: [] })
}))
