import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useAiStore } from '@renderer/stores/aiStore'
import { ProviderCard } from '@renderer/components/ai/ProviderCard'
import { TaskModelTable } from '@renderer/components/ai/TaskModelTable'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import {
  API_KEY_VENDORS,
  type AiProviderId,
  type ApiKeyVendor,
  type SubscriptionProviderId
} from '@shared/ai'
import { PrimaryButton, SecondaryButton, TextInput } from './shared'

const VENDOR_LABEL_KEYS: Record<ApiKeyVendor, string> = {
  anthropic: 'ai.vendor.anthropic',
  openai: 'ai.vendor.openai',
  gemini: 'ai.vendor.gemini'
}

// 구독 카드별 문구 키(제목·설명·로그인 명령 안내)
const SUBSCRIPTION_TEXT: Record<
  SubscriptionProviderId,
  { title: string; desc: string; loginHint: string; installHint: string }
> = {
  claude_subscription: {
    title: 'settings.ai.claudeSubscription',
    desc: 'ai.claudeSubscriptionDesc',
    loginHint: 'ai.claudeLoginHint',
    installHint: 'ai.claudeInstallHint'
  },
  codex_subscription: {
    title: 'settings.ai.codexSubscription',
    desc: 'ai.codexSubscriptionDesc',
    loginHint: 'ai.codexLoginHint',
    installHint: 'ai.codexInstallHint'
  }
}

// AI 연결 — 제공자 카드 4장(Claude 구독 · Codex 구독 · 내 API 키 · 서비스 크레딧) + 작업별 모델 표
export function AiSection(): React.JSX.Element {
  const { t } = useTranslation()
  const ai = useAiStore()
  // 해지 확인을 기다리는 카드
  const [confirmOff, setConfirmOff] = useState<SubscriptionProviderId | null>(null)

  useEffect(() => {
    void ai.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusOf = (id: AiProviderId): (typeof ai.providers)[number] | undefined =>
    ai.providers.find((p) => p.id === id)

  const apiKey = statusOf('api_key')

  const subscriptionCard = (provider: SubscriptionProviderId): React.JSX.Element => {
    const status = statusOf(provider)
    const text = SUBSCRIPTION_TEXT[provider]
    return (
      <ProviderCard
        title={t(text.title)}
        description={t(text.desc)}
        state={status?.state ?? 'needs_login'}
        account={status?.account}
        connectable
        busy={ai.busy === provider}
        selected={ai.provider === provider}
        onSelect={() => void ai.setProvider(provider)}
        onConnect={() => void ai.connect(provider)}
        onDisconnect={() => setConfirmOff(provider)}
      >
        {status?.state === 'not_installed' && (
          <p className="text-[11.5px] text-[var(--text2)]">{t(text.installHint)}</p>
        )}
        {status?.state === 'needs_login' && (
          <p className="text-[11.5px] text-[var(--text2)]">{t(text.loginHint)}</p>
        )}
        {status?.state === 'available' && (
          <p className="text-[11.5px] text-[var(--text2)]">{t('ai.availableHint')}</p>
        )}
      </ProviderCard>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {ai.error && <p className="text-[12px] text-[#b91c1c]">{ai.error}</p>}

      {/* ① Claude 구독 ② Codex 구독 */}
      {subscriptionCard('claude_subscription')}
      {subscriptionCard('codex_subscription')}

      {/* ③ 내 API 키 */}
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

      {/* ④ 서비스 크레딧 — 카드는 보이되 비활성 */}
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

      <LoginHintDialog />
      <DisconnectDialog provider={confirmOff} onClose={() => setConfirmOff(null)} />
    </div>
  )
}

// 자격이 없을 때의 안내. 로그인은 사용자가 터미널에서 직접 한다 — 앱이 대신 하지 않는다
function LoginHintDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const ai = useAiStore()
  const hint = ai.loginHint
  const provider = hint?.provider ?? 'claude_subscription'
  const text = SUBSCRIPTION_TEXT[provider]
  return (
    <Dialog open={Boolean(hint)} onOpenChange={(v) => !v && ai.dismissLoginHint()}>
      <DialogContent className="rounded-2xl border border-[var(--line)] bg-white sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('ai.loginNeededTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-[var(--text)]">
            {t(hint?.reason === 'not_installed' ? text.installHint : text.loginHint)}
          </p>
          <p className="text-[11.5px] text-[var(--text2)]">{t('ai.loginNeededDetail')}</p>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton onClick={() => void ai.connect(provider, true)}>
              {t('ai.openTerminal')}
            </PrimaryButton>
            <SecondaryButton onClick={() => void ai.connect(provider)}>
              {t('ai.retryConnect')}
            </SecondaryButton>
            <SecondaryButton onClick={() => ai.dismissLoginHint()}>{t('ai.close')}</SecondaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// 해지 확인. 해지해도 PC 의 CLI 로그인 파일은 그대로 남는다는 점을 분명히 적는다
function DisconnectDialog({
  provider,
  onClose
}: {
  provider: SubscriptionProviderId | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const ai = useAiStore()
  return (
    <Dialog open={Boolean(provider)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-2xl border border-[var(--line)] bg-white sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('ai.disconnectTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-[var(--text)]">{t('ai.disconnectBody')}</p>
          <p className="text-[11.5px] text-[var(--text2)]">{t('ai.disconnectKeepsCli')}</p>
          <div className="flex gap-2">
            <PrimaryButton
              disabled={!provider || ai.busy !== null}
              onClick={() => {
                if (provider) void ai.disconnect(provider)
                onClose()
              }}
            >
              {t('settings.ai.disconnect')}
            </PrimaryButton>
            <SecondaryButton onClick={onClose}>{t('ai.close')}</SecondaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
