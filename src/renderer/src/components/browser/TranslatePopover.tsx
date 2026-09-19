import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Languages, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { addAutoDomain, removeAutoDomain, TRANSLATE_LANGS } from '@shared/translate'
import type { TranslateLang, TranslateProgressDto } from '@shared/translate'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { cn } from '@renderer/lib/utils'

// 이미지 번역 결과 토스트가 저절로 사라지기까지
const TOAST_MS = 6000

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
  // 메인이 밀어 주는 진행률(화면 번역 · 이미지 번역 각각)
  const [pageProgress, setPageProgress] = useState<TranslateProgressDto | null>(null)
  const [imageProgress, setImageProgress] = useState<TranslateProgressDto | null>(null)
  const host = hostOf(activeTab?.url)
  const auto = domains.includes(host.replace(/^www\./, ''))

  // 진행률 문구로 바꾼다. 실패면 사유 문장, 아니면 "번역 중 12/398"
  const progressText = useCallback(
    (p: TranslateProgressDto | null): string => {
      if (!p) return ''
      if (p.phase === 'error') return t(`translate.fail.${p.reason ?? 'failed'}`)
      if (p.kind === 'image') return p.phase === 'running' ? t('translate.imageWorking') : ''
      if (p.total === 0) return ''
      const key = p.phase === 'running' ? 'translate.progress' : 'translate.progressDone'
      return t(key, { done: p.done, total: p.total })
    },
    [t]
  )

  useEffect(() => {
    return window.samba.translate.onProgress((dto) => {
      if (dto.kind === 'image') setImageProgress(dto)
      else setPageProgress(dto)
    })
  }, [])

  // 이미지 번역 결과(완료·실패)는 잠시 띄웠다가 지운다
  useEffect(() => {
    if (!imageProgress || imageProgress.phase === 'running') return
    const timer = window.setTimeout(() => setImageProgress(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [imageProgress])

  // 탭이 바뀌면 이전 탭의 진행률은 의미가 없다(렌더 중 상태 조정 — 리액트 권장 방식)
  const [shownTabId, setShownTabId] = useState(activeTab?.id)
  if (activeTab?.id !== shownTabId) {
    setShownTabId(activeTab?.id)
    setPageProgress(null)
    setNote('')
  }

  const running = pageProgress?.phase === 'running'
  const finished = pageProgress?.phase === 'done' && pageProgress.done > 0
  const imageToast = imageProgress ? progressText(imageProgress) : ''

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
    setPageProgress(null)
    // 팝오버는 닫지 않는다 — 진행률("번역 중 12/398")을 여기에서 보여 준다
    void window.samba.translate.run(lang).then((r) => {
      setNote(r.ok ? '' : t('translate.needsAi'))
    })
  }

  const restore = (): void => {
    setNote('')
    setPageProgress(null)
    void window.samba.translate.restore().then(() => setOpen(false))
  }

  const toggleAuto = (): void => {
    const next = auto ? removeAutoDomain(domains, host) : addAutoDomain(domains, host)
    setDomains(next)
    void window.samba.settings.set({ translateAutoDomains: next })
  }

  return (
    <>
      {imageToast && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white/95 px-3.5 py-2.5 text-[12px] text-[var(--text)] shadow-[0_8px_28px_rgba(0,0,0,.16)] backdrop-blur">
            {imageProgress?.phase === 'running' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text2)]" />
            ) : (
              <Languages className="h-3.5 w-3.5 text-[var(--text2)]" />
            )}
            {imageToast}
          </div>
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          title={t('translate.title')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Languages className={cn('h-4 w-4', finished && 'text-[var(--text)]')} />
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[268px] p-3">
          <div className="text-[12.5px] font-semibold text-[var(--text)]">
            {t('translate.title')}
          </div>

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
              disabled={running}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[9px] bg-[var(--text)] text-[12px] font-medium text-white disabled:opacity-70"
            >
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {finished && !running && <Check className="h-3.5 w-3.5" />}
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

          {/* 진행률·실패 사유가 있으면 그것을 먼저 보여 준다(없을 때만 기존 안내 문구) */}
          {progressText(pageProgress) ? (
            <p
              className={cn(
                'mt-2 text-[11px]',
                pageProgress?.phase === 'error'
                  ? 'text-[var(--danger,#c0392b)]'
                  : 'text-[var(--text2)]'
              )}
            >
              {progressText(pageProgress)}
            </p>
          ) : (
            note && <p className="mt-2 text-[11px] text-[var(--text2)]">{note}</p>
          )}

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
    </>
  )
}
