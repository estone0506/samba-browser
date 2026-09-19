import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { GeneralSection } from '@renderer/components/settings/GeneralSection'
import { AppearanceSection } from '@renderer/components/settings/AppearanceSection'
import { AccountSection } from '@renderer/components/settings/AccountSection'
import { SecuritySection } from '@renderer/components/settings/SecuritySection'
import { AgentSection } from '@renderer/components/settings/AgentSection'
import { AiSection } from '@renderer/components/settings/AiSection'
import { KeymasterSection } from '@renderer/components/settings/KeymasterSection'
import { PlaceholderSection } from '@renderer/components/settings/PlaceholderSection'
import { ExtensionsSection } from '@renderer/components/settings/ExtensionsSection'
import {
  DEFAULT_SECTION_KEY,
  SECTIONS,
  SETTINGS_GROUPS,
  groupLabelKey,
  resolveSectionKey,
  sectionsOfGroup,
  type SettingsSectionDef
} from '@renderer/components/settings/sections'
import type { Settings } from '@shared/settings'

// 설정 페이지 — 좌측 240px 섹션 목록 + 우측 패널.
// 모든 변경은 저장 버튼 없이 즉시 window.samba.settings.set 으로 반영한다
export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [active, setActive] = useState<string>(DEFAULT_SECTION_KEY)

  useEffect(() => {
    void window.samba.settings.get().then((r) => {
      if (r.ok) setSettings(r.data)
    })
  }, [])

  // 낙관적 반영 후 메인이 정규화한 값으로 덮어쓴다(범위를 벗어난 값이 화면에 남지 않게)
  const update = useCallback((patch: Partial<Settings>): void => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    void window.samba.settings.set(patch).then((r) => {
      if (r.ok) setSettings(r.data)
    })
  }, [])

  const select = (key: string): void => setActive(resolveSectionKey(key))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)] min-[769px]:flex-row">
      {/* 모바일 폭(≤768px) — 상단 가로 스크롤 탭 */}
      <nav className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--line)] px-3 py-2 min-[769px]:hidden">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => select(s.key)}
            className={cn(
              'h-[28px] shrink-0 rounded-[8px] border px-2.5 text-[12px]',
              active === s.key
                ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
                : 'border-[var(--line)] text-[var(--text2)]'
            )}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </nav>

      {/* 데스크톱 폭 — 좌측 240px 섹션 목록 */}
      <aside className="hidden w-[240px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--line)] p-4 min-[769px]:flex">
        <h1 className="text-[15px] font-semibold text-[var(--text)]">{t('settingsPage.title')}</h1>
        {SETTINGS_GROUPS.map((group) => (
          <div key={group} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-[11px] font-medium text-[var(--text2)]">
              {t(groupLabelKey(group))}
            </div>
            {sectionsOfGroup(group).map((s: SettingsSectionDef) => (
              <button
                key={s.key}
                type="button"
                onClick={() => select(s.key)}
                className={cn(
                  'h-8 rounded-[8px] px-2 text-left text-[12.5px]',
                  active === s.key
                    ? 'bg-black/[.06] font-medium text-[var(--text)]'
                    : 'text-[var(--text2)] hover:bg-black/[.03]'
                )}
              >
                {t(s.labelKey)}
              </button>
            ))}
          </div>
        ))}
      </aside>

      {/* 우측 패널 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 p-6">
          {settings && <SectionBody active={active} settings={settings} update={update} />}
        </div>
      </div>
    </div>
  )
}

// 섹션 키 → 컴포넌트. 자리만 잡아 둔 섹션은 PlaceholderSection 하나로 처리한다
function SectionBody({
  active,
  settings,
  update
}: {
  active: string
  settings: Settings
  update: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const labelKey =
    SECTIONS.find((s) => s.key === active)?.labelKey ?? 'settingsPage.sections.general'
  switch (active) {
    case 'general':
      return <GeneralSection settings={settings} update={update} />
    case 'appearance':
      return <AppearanceSection settings={settings} update={update} />
    case 'account':
      return <AccountSection />
    case 'security':
      return <SecuritySection settings={settings} update={update} />
    case 'agent':
      return <AgentSection settings={settings} update={update} />
    case 'ai':
      return <AiSection />
    case 'keymaster':
      return <KeymasterSection />
    // 개발자 섹션: 압축 해제된 크롬 확장 폴더 관리(Task 15)
    case 'developer':
      return <ExtensionsSection />
    default:
      return <PlaceholderSection titleKey={labelKey} />
  }
}
