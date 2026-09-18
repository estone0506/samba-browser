import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useAiStore } from '@renderer/stores/aiStore'
import { ProviderCard } from '@renderer/components/ai/ProviderCard'
import { TaskModelTable } from '@renderer/components/ai/TaskModelTable'
import { API_KEY_VENDORS, type AiProviderId, type ApiKeyVendor } from '@shared/ai'
import { SecondaryButton, TextInput } from './shared'

const VENDOR_LABEL_KEYS: Record<ApiKeyVendor, string> = {
  anthropic: 'ai.vendor.anthropic',
  openai: 'ai.vendor.openai',
  gemini: 'ai.vendor.gemini'
}

// AI 연결 — 제공자 카드 3장(스펙 순서) + 작업별 모델 표
export function AiSection(): React.JSX.Element {
  const { t } = useTranslation()
  const ai = useAiStore()

  useEffect(() => {
    void ai.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusOf = (id: AiProviderId): (typeof ai.providers)[number] | undefined =>
    ai.providers.find((p) => p.id === id)

  const subscription = statusOf('claude_subscription')
  const apiKey = statusOf('api_key')

  return (
    <div className="flex flex-col gap-4">
      {ai.error && <p className="text-[12px] text-[#b91c1c]">{ai.error}</p>}

      {/* ① Claude 구독 */}
      <ProviderCard
        title={t('settings.ai.claudeSubscription')}
        description={t('ai.claudeSubscriptionDesc')}
        state={subscription?.state ?? 'unset'}
        selected={ai.provider === 'claude_subscription'}
        onSelect={() => void ai.setProvider('claude_subscription')}
      >
        {subscription?.state === 'not_installed' && (
          <p className="text-[11.5px] text-[var(--text2)]">{t('ai.claudeInstallHint')}</p>
        )}
        {subscription?.state === 'needs_login' && (
          <p className="text-[11.5px] text-[var(--text2)]">{t('ai.claudeLoginHint')}</p>
        )}
      </ProviderCard>

      {/* ② 내 API 키 */}
      <ProviderCard
        title={t('settings.ai.apiKey')}
        description={t('settings.ai.keyKept')}
        state={apiKey?.state ?? 'unset'}
        selected={ai.provider === 'api_key'}
        onSelect={() => void ai.setProvider('api_key')}
      >
        {API_KEY_VENDORS.map((vendor) => (
          <ApiKeyRow key={vendor} vendor={vendor} masked={apiKey?.maskedKeys?.[vendor]} />
        ))}
      </ProviderCard>

      {/* ③ 서비스 크레딧 — 카드는 보이되 비활성 */}
      <ProviderCard
        title={t('settings.ai.serviceCredit')}
        description={t('settings.ai.serviceCreditSoon')}
        state="disabled"
        selected={false}
        disabled
      />

      {ai.taskModels && (
        <TaskModelTable
          taskModels={ai.taskModels}
          choices={ai.choices}
          changed={ai.remapped}
          onChange={(key, model) => void ai.setTaskModel(key, model)}
          onDismissChanged={() => ai.dismissRemapped()}
        />
      )}
    </div>
  )
}

// API 키 한 칸. 입력한 평문은 메인으로만 흐르고, 화면에는 마스킹 문자열만 남는다
function ApiKeyRow({
  vendor,
  masked
}: {
  vendor: ApiKeyVendor
  masked?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const ai = useAiStore()
  const [draft, setDraft] = useState('')
  const result = ai.testResults[vendor]

  const save = (): void => {
    if (!draft.trim()) return
    void ai.setApiKey(vendor, draft.trim())
    // 평문은 저장 직후 화면 상태에서 지운다
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-[var(--text)]">
          {t(VENDOR_LABEL_KEYS[vendor])}
        </span>
        <span className="font-mono text-[11.5px] text-[var(--text2)]">
          {masked ?? t('ai.noKey')}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <TextInput
          value={draft}
          onChange={setDraft}
          onBlur={save}
          type="password"
          autoComplete="off"
          placeholder={t('ai.keyPlaceholder')}
        />
        <SecondaryButton
          disabled={!draft.trim() || result === 'testing'}
          onClick={() => void ai.testKey(vendor, draft.trim())}
        >
          {t('settings.ai.testKey')}
        </SecondaryButton>
      </div>
      {result === 'ok' && <p className="text-[11.5px] text-[var(--text2)]">{t('ai.testOk')}</p>}
      {result === 'fail' && <p className="text-[11.5px] text-[#b91c1c]">{t('ai.testFail')}</p>}
    </div>
  )
}
