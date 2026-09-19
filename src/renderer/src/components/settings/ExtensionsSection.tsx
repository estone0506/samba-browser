import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FolderOpen, Puzzle, Store, Trash2 } from 'lucide-react'
import type { ExtensionDto, ExtensionError, ExtensionSource } from '@shared/extensions'
import { ExtensionWebstoreDialog } from './ExtensionWebstoreDialog'
import { ExtensionImportDialog } from './ExtensionImportDialog'

/**
 * 설정 페이지의 확장 섹션 — 설치 경로가 셋이다.
 * 웹스토어에서 설치 · 다른 브라우저에서 가져오기 · 압축 해제된 폴더 불러오기.
 * 앞의 둘은 앱 데이터(userData/extensions/<id>)로 복사한 사본을 로드한다.
 * 제한 사항 안내는 어느 경로로 깔았든 항상 고정으로 보인다
 */
export function ExtensionsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [items, setItems] = useState<ExtensionDto[]>([])
  const [loadErrors, setLoadErrors] = useState<ExtensionError[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [storeOpen, setStoreOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const r = await window.samba.extensions.list()
    if (!r.ok) {
      setMessage(r.error)
      return
    }
    setItems(r.data.items)
    setLoadErrors(r.data.errors)
  }, [])

  // 첫 렌더에서 메인이 이미 로드해 둔 목록(앱 시작 시 loadSaved 결과)을 받아 온다
  useEffect(() => {
    void window.samba.extensions.list().then((r) => {
      if (!r.ok) return
      setItems(r.data.items)
      setLoadErrors(r.data.errors)
    })
  }, [])

  // 폴더 선택창은 메인이 연다(취소하면 data 가 null 이다)
  const add = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const r = await window.samba.extensions.load()
      if (!r.ok) {
        setMessage(r.error)
        return
      }
      if (r.data) await refresh()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    const r = await window.samba.extensions.remove(id)
    if (!r.ok) {
      setMessage(r.error)
      return
    }
    await refresh()
  }

  const sourceLabel = (source: ExtensionSource): string =>
    source === 'store'
      ? t('settingsPage.extensions.sourceStore')
      : source === 'imported'
        ? t('settingsPage.extensions.sourceImported')
        : t('settingsPage.extensions.sourceFolder')

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <h2 className="mb-3 text-[13px] font-semibold text-[var(--text)]">
        {t('settingsPage.extensions.title')}
      </h2>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div>
            <div className="text-[12.5px] font-medium text-[var(--text)]">
              {t('settingsPage.extensions.add')}
            </div>
            <div className="text-[11px] leading-snug text-[var(--text2)]">
              {t('settingsPage.extensions.addDesc')}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setStoreOpen(true)}
              className="flex h-9 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] bg-[var(--text)] px-3 text-[12.5px] font-medium text-white"
            >
              <Store className="h-3.5 w-3.5" />
              {t('settingsPage.extensions.storeButton')}
            </button>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="flex h-9 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-[var(--text)] hover:bg-black/5"
            >
              <Download className="h-3.5 w-3.5" />
              {t('settingsPage.extensions.importButton')}
            </button>
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy}
              className="flex h-9 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-[var(--text)] hover:bg-black/5 disabled:opacity-50"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {busy ? t('settingsPage.extensions.adding') : t('settingsPage.extensions.addButton')}
            </button>
          </div>
          {message && <p className="text-[11px] text-red-500">{message}</p>}
        </div>

        {/* 로드된 확장 목록 */}
        {items.length === 0 ? (
          <p className="text-[11.5px] text-[var(--text2)]">{t('settingsPage.extensions.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {items.map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-2 rounded-[9px] border border-[var(--line)] px-2.5 py-2"
              >
                <Puzzle className="h-5 w-5 shrink-0 text-[var(--text2)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--text)]">
                    {e.name}
                    <span className="ml-1.5 font-normal text-[var(--text2)]">{e.version}</span>
                  </span>
                  <span
                    className="block truncate text-[11px] text-[var(--text2)]"
                    title={e.path}
                    dir="rtl"
                  >
                    {e.path}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[10.5px] text-[var(--text2)]">
                  {sourceLabel(e.source)}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(e.id)}
                  title={t('settingsPage.extensions.remove')}
                  aria-label={t('settingsPage.extensions.remove')}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--text2)] hover:bg-black/5"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 시작할 때 실패한 확장 — 앱은 그대로 뜨고 여기에만 남는다 */}
        {loadErrors.length > 0 && (
          <div className="flex flex-col gap-1 rounded-[9px] border border-red-200 bg-red-50 px-2.5 py-2">
            <span className="text-[11.5px] font-medium text-red-600">
              {t('settingsPage.extensions.failedTitle')}
            </span>
            {loadErrors.map((e) => (
              <span key={e.path} className="text-[11px] leading-snug break-all text-red-500">
                {e.path} — {e.error}
              </span>
            ))}
          </div>
        )}

        {/* 제한 사항 — 항상 고정 노출 */}
        <div className="flex flex-col gap-1 rounded-[9px] bg-black/[0.03] px-2.5 py-2">
          <span className="text-[11.5px] font-medium text-[var(--text)]">
            {t('settingsPage.extensions.limitsTitle')}
          </span>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-snug text-[var(--text2)]">
            <li>{t('settingsPage.extensions.limitMv3')}</li>
            <li>{t('settingsPage.extensions.limitServiceWorker')}</li>
            <li>{t('settingsPage.extensions.limitNoAutoUpdate')}</li>
            <li>{t('settingsPage.extensions.limitMv2')}</li>
            <li>{t('settingsPage.extensions.limitPartition')}</li>
          </ul>
        </div>
      </div>

      <ExtensionWebstoreDialog
        open={storeOpen}
        onOpenChange={setStoreOpen}
        onInstalled={() => refresh()}
      />
      <ExtensionImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => refresh()}
      />
    </section>
  )
}
