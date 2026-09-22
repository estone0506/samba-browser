import { create } from 'zustand'
import type {
  AiProviderId,
  AiProviderStatus,
  AiUsage,
  ApiKeyVendor,
  SubscriptionProviderId,
  TaskModelKey,
  TaskModels
} from '@shared/ai'
import { SUBSCRIPTION_PROVIDERS } from '@shared/ai'

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
  /** 연결/해지 요청이 도는 중인 구독 카드 */
  busy: SubscriptionProviderId | null
  /** 자격이 없어 안내 다이얼로그를 띄워야 하는 구독 카드와 사유 */
  loginHint: { provider: SubscriptionProviderId; reason: 'not_installed' | 'needs_login' } | null
  /** 구독 사용량(Claude · Codex). 조회 실패·미연결이면 그 칸이 null */
  usage: Partial<Record<SubscriptionProviderId, AiUsage | null>>
  load: () => Promise<void>
  loadUsage: () => Promise<void>
  /** 다른 계정으로: 로그아웃 + 로그인 터미널. 로그인 뒤 [연결]로 다시 붙인다 */
  switchAccount: (provider: SubscriptionProviderId) => Promise<void>
  connect: (provider: SubscriptionProviderId, openTerminal?: boolean) => Promise<void>
  disconnect: (provider: SubscriptionProviderId) => Promise<void>
  dismissLoginHint: () => void
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
  busy: null,
  loginHint: null,
  usage: {},

  loadUsage: async () => {
    // 구독 카드마다 따로 조회한다(한쪽이 실패해도 다른 쪽은 보인다)
    const entries = await Promise.all(
      SUBSCRIPTION_PROVIDERS.map(async (p) => {
        const r = await window.samba.ai.usage?.(p)
        return [p, r?.ok ? r.data : null] as const
      })
    )
    set({ usage: Object.fromEntries(entries) })
  },

  switchAccount: async (provider) => {
    set({ busy: provider, error: null })
    const r = await window.samba.ai.switchAccount(provider)
    set({ busy: null })
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    // 터미널에서 로그인하는 동안 안내를 띄워 둔다(끝나면 [다시 확인])
    set({ usage: {}, loginHint: { provider, reason: 'needs_login' } })
    await get().load()
  },

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

  // 연결: 성공하면 카드 상태를 다시 읽고, 자격이 없으면 안내 다이얼로그를 띄운다
  connect: async (provider, openTerminal = false) => {
    set({ busy: provider, error: null })
    const r = await window.samba.ai.connect(provider, openTerminal)
    set({ busy: null })
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    if (r.data.ok) {
      set({ loginHint: null })
      await get().load()
      return
    }
    // 터미널을 여는 호출은 안내를 그대로 띄워 둔 채 기다린다
    if (!openTerminal) set({ loginHint: { provider, reason: r.data.reason ?? 'needs_login' } })
  },

  // 해지: 진행 중 작업이 있으면 메인이 거절한다(오류 문구를 그대로 보여 준다)
  disconnect: async (provider) => {
    set({ busy: provider, error: null })
    const r = await window.samba.ai.disconnect(provider)
    set({ busy: null })
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    await get().load()
  },

  dismissLoginHint: () => set({ loginHint: null }),

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
