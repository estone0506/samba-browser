// 에이전트 규칙 파일 편집 — 밖(하네스)을 바꾸는 이 화면의 유일한 동작.
//
// 브리프 작성 시점에는 하네스에 규칙을 읽어 오는 통로가 없어 빈 칸에서 시작할 계획이었지만,
// 이후 GET /graph/rules/{agent} 가 배선되어(harnessStore.getRules) 열 때 원문을 불러와 채운다.
// 그래도 저장은 여전히 "전체 교체"라서 저장 전에 한 번 더 확인을 받고(2단계),
// 새 버전이 된다는 사실을 함께 알린다(스펙 §10-1)
//
// 내부 폼(RulesForm)을 agent 이름 + 다시시도 횟수로 key 를 주어, 열 때·다시 시도할 때마다
// 새로 마운트되게 한다 — 이펙트 안에서 곧바로 setState 하지 않고도(react-hooks 규칙 위반 없이)
// loading·loadFailed·text 가 매번 깨끗하게 새로 시작된다
import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { PrimaryButton, SecondaryButton } from '@renderer/components/settings/shared'
import type { HarnessAgent } from '@shared/harness'
import { useHarnessStore } from '@renderer/stores/harnessStore'

export function RulesDialog({
  agent,
  open,
  saving,
  error,
  onOpenChange,
  onSave
}: {
  agent: HarnessAgent | null
  open: boolean
  saving: boolean
  /** 저장 실패 사유(없으면 빈 문자열) */
  error: string
  onOpenChange: (open: boolean) => void
  onSave: (text: string) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation()
  // "다시 시도" 를 누르면 늘려서 RulesForm 의 key 를 바꾼다 — 새로 마운트되어 원문을 다시 읽는다
  const [retryTick, setRetryTick] = useState(0)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('automation.harness.rules.title', { agent: agent?.name ?? '' })}
          </DialogTitle>
        </DialogHeader>
        {open && agent !== null && (
          <RulesForm
            key={`${agent.name}-${retryTick}`}
            agent={agent}
            saving={saving}
            error={error}
            t={t}
            onCancel={() => onOpenChange(false)}
            onSave={onSave}
            onSaved={() => onOpenChange(false)}
            onRetry={() => setRetryTick((n) => n + 1)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function RulesForm({
  agent,
  saving,
  error,
  t,
  onCancel,
  onSave,
  onSaved,
  onRetry
}: {
  agent: HarnessAgent
  saving: boolean
  error: string
  t: ReturnType<typeof useTranslation>['t']
  onCancel: () => void
  onSave: (text: string) => Promise<boolean>
  onSaved: () => void
  /** 원문을 못 불러왔을 때 "다시 시도" — 부모가 key 를 바꿔 이 폼을 통째로 다시 마운트한다 */
  onRetry: () => void
}): React.JSX.Element {
  const getRules = useHarnessStore((s) => s.getRules)
  // 마운트 시점의 초기값이므로 여기서 정해도 이펙트 안에서 다시 setState 하지 않는다
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getRules(agent.name).then((rules) => {
      if (cancelled) return
      if (rules === null) {
        setLoadFailed(true)
      } else {
        setText(rules.text)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [agent, getRules])

  const save = async (): Promise<void> => {
    const ok = await onSave(text)
    if (ok) onSaved()
    else setConfirming(false)
  }

  return (
    <>
      <p className="text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.rules.path', { path: agent.rules })}
      </p>
      {loading && (
        <p className="text-[11.5px] text-[var(--text2)]">{t('automation.harness.rules.loading')}</p>
      )}
      {loadFailed ? (
        // 원문을 못 불러왔으면 "저장하면 전체가 바뀐다" 경고는 오히려 헷갈린다 —
        // 무엇을 덮어쓸지 모르는 채로 저장을 유도하지 않도록 이 경고 자체를 뺀다(리뷰 지적 — Important 2)
        <div className="flex items-center justify-between gap-2 rounded-[9px] border border-[#b91c1c] px-2.5 py-2">
          <p className="text-[11.5px] text-[#b91c1c]">{t('automation.harness.rules.loadFailed')}</p>
          <SecondaryButton onClick={onRetry}>{t('automation.harness.rules.retry')}</SecondaryButton>
        </div>
      ) : (
        <p className="rounded-[9px] border border-[#b45309] px-2.5 py-2 text-[11.5px] text-[#b45309]">
          {t('automation.harness.rules.warn')}
        </p>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('automation.harness.rules.placeholder')}
        disabled={loading || loadFailed}
        className="min-h-[220px] w-full rounded-[9px] border border-[var(--line)] bg-white p-2 font-mono text-[12px] text-[var(--text)] disabled:opacity-60"
      />
      <p className="text-[11.5px] text-[var(--text2)]">
        {t('automation.harness.rules.newVersion')}
      </p>
      {error !== '' && (
        <p className="text-[11.5px] text-[#b91c1c]">
          {t('automation.harness.rules.failed', { error })}
        </p>
      )}
      {confirming && (
        <p className="text-[11.5px] font-semibold text-[var(--text)]">
          {t('automation.harness.rules.confirmDesc')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <SecondaryButton onClick={onCancel}>{t('automation.harness.rules.cancel')}</SecondaryButton>
        {confirming ? (
          <PrimaryButton disabled={saving} onClick={() => void save()}>
            {t('automation.harness.rules.confirm')}
          </PrimaryButton>
        ) : (
          <PrimaryButton
            disabled={text.trim() === '' || saving || loading || loadFailed}
            onClick={() => setConfirming(true)}
          >
            {t('automation.harness.rules.save')}
          </PrimaryButton>
        )}
      </div>
    </>
  )
}
