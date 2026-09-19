import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import {
  GESTURE_ACTIONS,
  GESTURE_SEQUENCES,
  defaultMouseGestures,
  gestureArrows,
  resolveGestureAction,
  type GestureAction
} from '@shared/gestures'
import { SecondaryButton, SettingsSection, SettingsToggleRow, type SectionProps } from './shared'

// 마우스 제스처 — 켜기/끄기 · 제스처별 동작 표 · 기본값 복원.
// 웨일 설정 화면과 같은 배치(화살표 아이콘 + 동작 드롭다운)를 2열 표로 그린다
export function MouseGestureCard({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const enabled = settings.mouseGesturesEnabled
  const mapping = settings.mouseGestures

  const setAction = (sequence: string, action: GestureAction): void => {
    // 기본값 위에 얹어 저장한다 — 예전 버전에서 넘어온 부분 매핑이어도 표가 비지 않는다
    update({ mouseGestures: { ...defaultMouseGestures(), ...mapping, [sequence]: action } })
  }

  return (
    <SettingsSection
      title={t('settingsPage.gestures.title')}
      description={t('settingsPage.gestures.desc')}
    >
      <SettingsToggleRow
        label={t('settingsPage.gestures.enable')}
        description={t('settingsPage.gestures.enableDesc')}
      >
        <Switch
          checked={enabled}
          onCheckedChange={(v) => update({ mouseGesturesEnabled: v })}
          aria-label={t('settingsPage.gestures.enable')}
        />
      </SettingsToggleRow>

      <div
        className={
          enabled
            ? 'grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2'
            : 'pointer-events-none grid grid-cols-1 gap-x-4 gap-y-2 opacity-40 sm:grid-cols-2'
        }
      >
        {GESTURE_SEQUENCES.map((sequence) => (
          <div
            key={sequence}
            className="flex items-center gap-2 rounded-[9px] border border-[var(--line)] px-2.5 py-1.5"
          >
            <span
              className="w-12 shrink-0 text-[13px] font-semibold tracking-tight text-[var(--text)]"
              aria-label={sequence}
            >
              {gestureArrows(sequence)}
            </span>
            <select
              value={resolveGestureAction(sequence, mapping)}
              disabled={!enabled}
              onChange={(e) => setAction(sequence, e.target.value as GestureAction)}
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-[var(--line)] bg-[var(--bg)] px-2 text-[12.5px] text-[var(--text)] outline-none"
            >
              {GESTURE_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {t(`settingsPage.gestures.actions.${action}`)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div>
        <SecondaryButton onClick={() => update({ mouseGestures: defaultMouseGestures() })}>
          {t('settingsPage.gestures.restore')}
        </SecondaryButton>
      </div>
    </SettingsSection>
  )
}
