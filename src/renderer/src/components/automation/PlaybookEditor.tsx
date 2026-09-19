import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { PlaybookDto, PlaybookInput } from '@shared/playbook'
import { PLAYBOOK_INSTRUCTIONS_MAX, PLAYBOOK_NAME_MAX } from '@shared/playbook'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsRow,
  TextInput
} from '@renderer/components/settings/shared'
import { parseTriggers } from './playbook-view'

/**
 * 플레이북 편집 폼. 새로 만들기(playbook 없음)와 수정에 같은 폼을 쓴다.
 * 저장 버튼은 이름이 비어 있으면 눌리지 않는다
 */
export function PlaybookEditor({
  playbook,
  onSave,
  onCancel
}: {
  playbook?: PlaybookDto
  onSave: (input: PlaybookInput) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(playbook?.name ?? '')
  const [triggerText, setTriggerText] = useState((playbook?.triggers ?? []).join(', '))
  const [instructions, setInstructions] = useState(playbook?.instructions ?? '')

  const submit = (): void => {
    const input: PlaybookInput = {
      name: name.trim(),
      triggers: parseTriggers(triggerText),
      instructions,
      enabled: playbook?.enabled ?? true
    }
    onSave(playbook ? { ...input, id: playbook.id } : input)
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsRow label={t('automation.field.name')}>
        <TextInput
          value={name}
          onChange={(v) => setName(v.slice(0, PLAYBOOK_NAME_MAX))}
          placeholder={t('automation.field.namePlaceholder')}
        />
      </SettingsRow>

      <SettingsRow
        label={t('automation.field.triggers')}
        description={t('automation.field.triggersDesc')}
      >
        <TextInput
          value={triggerText}
          onChange={setTriggerText}
          placeholder={t('automation.field.triggersPlaceholder')}
        />
      </SettingsRow>

      <SettingsRow
        label={t('automation.field.instructions')}
        description={t('automation.field.instructionsDesc')}
      >
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value.slice(0, PLAYBOOK_INSTRUCTIONS_MAX))}
          spellCheck={false}
          className="min-h-[240px] w-full resize-y rounded-[9px] border border-[var(--line)] bg-[var(--bg)] p-2.5 font-mono text-[12px] leading-relaxed text-[var(--text)] outline-none"
        />
        <div className="text-right text-[11px] text-[var(--text3)]">
          {t('automation.field.length', {
            n: instructions.length,
            max: PLAYBOOK_INSTRUCTIONS_MAX
          })}
        </div>
      </SettingsRow>

      <div className="flex flex-wrap gap-2">
        <PrimaryButton onClick={submit} disabled={name.trim() === ''}>
          {t('automation.action.save')}
        </PrimaryButton>
        <SecondaryButton onClick={onCancel}>{t('automation.action.cancel')}</SecondaryButton>
      </div>
    </div>
  )
}
