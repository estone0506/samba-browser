import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle, Trash2 } from 'lucide-react'
import type { ExtensionDto } from '@shared/extensions'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { permissionSummary, sourceLabelKey } from './extension-list'

interface Props {
  item: ExtensionDto
  onToggle: (enabled: boolean) => void | Promise<void>
  onRemove: () => void | Promise<void>
}

// 확장 카드 한 장 — 아이콘·이름·설명·버전 + [세부정보][삭제] + 활성 토글.
// 세부정보는 다른 화면으로 넘어가지 않고 카드가 그 자리에서 펼쳐진다
export function ExtensionCard({ item, onToggle, onRemove }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const permissions = permissionSummary(item.permissions)

  return (
    <article
      className={cn(
        'flex flex-col rounded-2xl border border-[var(--line)] bg-white p-4 transition-opacity',
        !item.enabled && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-black/[0.04]">
          {item.icon ? (
            <img src={item.icon} alt="" draggable={false} className="h-7 w-7 object-contain" />
          ) : (
            <Puzzle className="h-5 w-5 text-[var(--text2)]" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold text-[var(--text)]">
            {item.name}
            <span className="ml-1.5 font-normal text-[var(--text2)]">{item.version}</span>
          </h3>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-[var(--text2)]">
            {item.description || t(sourceLabelKey(item.source))}
          </p>
        </div>
      </div>

      {/* 아래쪽 줄 — 왼쪽 버튼 두 개, 오른쪽 활성 토글 */}
      <div className="mt-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="h-[28px] rounded-[8px] border border-[var(--line)] px-2.5 text-[12px] text-[var(--text)] hover:bg-black/5"
        >
          {open ? t('extensions.detailsHide') : t('extensions.details')}
        </button>
        <button
          type="button"
          onClick={() => void onRemove()}
          title={t('extensions.remove')}
          aria-label={t('extensions.remove')}
          className="flex h-[28px] items-center gap-1.5 rounded-[8px] border border-[var(--line)] px-2.5 text-[12px] text-[var(--text2)] hover:bg-black/5"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('extensions.remove')}
        </button>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[11.5px] text-[var(--text2)]">
            {item.enabled ? t('extensions.enabledLabel') : t('extensions.disabled')}
          </span>
          <Switch
            checked={item.enabled}
            onCheckedChange={(v) => void onToggle(v)}
            aria-label={item.enabled ? t('extensions.disable') : t('extensions.enable')}
          />
        </span>
      </div>

      {open && (
        <dl className="mt-3 flex flex-col gap-2 border-t border-[var(--line)] pt-3 text-[11.5px]">
          <div>
            <dt className="font-medium text-[var(--text)]">{t('extensions.detailsPermissions')}</dt>
            <dd className="mt-0.5 text-[var(--text2)]">
              {permissions.length === 0 ? (
                t('extensions.detailsNoPermissions')
              ) : (
                <span className="flex flex-wrap gap-1">
                  {permissions.map((p) => (
                    <span key={p} className="rounded-full bg-black/[0.05] px-2 py-0.5 break-all">
                      {p}
                    </span>
                  ))}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--text)]">{t('extensions.detailsPath')}</dt>
            <dd className="mt-0.5 break-all text-[var(--text2)]">{item.path}</dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--text)]">{t('extensions.detailsSource')}</dt>
            <dd className="mt-0.5 text-[var(--text2)]">{t(sourceLabelKey(item.source))}</dd>
          </div>
        </dl>
      )}
    </article>
  )
}
