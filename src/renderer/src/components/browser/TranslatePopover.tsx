import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { addAutoDomain, removeAutoDomain, TRANSLATE_LANGS } from '@shared/translate'
import type { TranslateLang } from '@shared/translate'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { cn } from '@renderer/lib/utils'
import { useOverlayStore } from '@renderer/stores/overlayStore'

// 현재 탭 주소의 호스트(자동 번역 목록에 넣고 뺄 대상)
function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// 주소창 오른쪽 번역 아이콘 → 대상 언어 · 번역/원문 · 자동 번역 도메인 팝오버
export function TranslatePopover(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useBrowserStore((s) => s.activeTab)
  const [open, setOpen] = useState(false)
  const [lang, setLang] = useState<TranslateLang>('ko')
  const [domains, setDomains] = useState<string[]>([])
  const [note, setNote] = useState('')
  const host = hostOf(activeTab?.url)
  const auto = domains.includes(host.replace(/^www\./, ''))

  // 열려 있는 동안에는 네이티브 웹뷰를 접는다 — 접지 않으면 팝오버가 그 아래로 가려져 안 보인다
  const setWebviewHidden = useOverlayStore((s) => s.setWebviewHidden)
  useEffect(() => {
    setWebviewHidden(open)
    return () => setWebviewHidden(false)
  }, [open, setWebviewHidden])

  // 팝오버를 열 때마다 최신 설정을 읽는다(다른 화면에서 바뀌었을 수 있다)
  useEffect(() => {
    if (!open) return
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setLang(r.data.translateTargetLang)
      setDomains(r.data.translateAutoDomains)
    })
  }, [open])

  const chooseLang = (value: TranslateLang): void => {
    setLang(value)
    void window.samba.settings.set({ translateTargetLang: value })
  }

  const runTranslate = (): void => {
    setNote(t('translate.working'))
    void window.samba.translate.run(lang).then((r) => {
      setNote(r.ok ? '' : t('translate.needsAi'))
      if (r.ok) setOpen(false)
    })
  }

  const restore = (): void => {
    void window.samba.translate.restore().then(() => setOpen(false))
  }

  const toggleAuto = (): void => {
    const next = auto ? removeAutoDomain(domains, host) : addAutoDomain(domains, host)
    setDomains(next)
    void window.samba.settings.set({ translateAutoDomains: next })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title={t('translate.title')}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5"
      >
        <Languages className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[268px] p-3">
        <div className="text-[12.5px] font-semibold text-[var(--text)]">{t('translate.title')}</div>

        <div className="mt-2.5 text-[11px] text-[var(--text2)]">{t('translate.targetLang')}</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {TRANSLATE_LANGS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => chooseLang(value)}
              className={cn(
                'h-[26px] rounded-[8px] border px-2.5 text-[11.5px]',
                lang === value
                  ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
                  : 'border-[var(--line)] text-[var(--text2)]'
              )}
            >
              {t(`translate.lang.${value}`)}
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-1.5">
          <button
            type="button"
            onClick={runTranslate}
            className="h-8 flex-1 rounded-[9px] bg-[var(--text)] text-[12px] font-medium text-white"
          >
            {t('translate.run')}
          </button>
          <button
            type="button"
            onClick={restore}
            className="h-8 flex-1 rounded-[9px] border border-[var(--line)] text-[12px] font-medium text-[var(--text)] hover:bg-black/5"
          >
            {t('translate.restore')}
          </button>
        </div>

        {note && <p className="mt-2 text-[11px] text-[var(--text2)]">{note}</p>}

        {host && (
          <button
            type="button"
            onClick={toggleAuto}
            className="mt-3 w-full rounded-[9px] border border-[var(--line)] px-2.5 py-2 text-left text-[11.5px] text-[var(--text2)] hover:bg-black/5"
          >
            {auto ? t('translate.autoOff', { host }) : t('translate.autoOn', { host })}
          </button>
        )}

        {domains.length > 0 && (
          <p className="mt-2 text-[11px] leading-snug text-[var(--text3)]">
            {t('translate.autoList', { list: domains.join(', ') })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
