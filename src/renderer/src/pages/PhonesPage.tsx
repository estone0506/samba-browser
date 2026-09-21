import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'
import type { Settings } from '@shared/settings'
import { PhoneCard } from '@renderer/components/phone/PhoneCard'
import { ToolsInstallCard } from '@renderer/components/phone/ToolsInstallCard'
import { PhoneSettingsPanel } from '@renderer/components/phone/PhoneSettingsPanel'
import { SecondaryButton, TextInput } from '@renderer/components/settings/shared'
import { cn } from '@renderer/lib/utils'
import { usePhoneStore } from '@renderer/stores/phoneStore'

// 폰 화면 — 카드 3장 그리드 + 상단 도구줄(지금 찾기 · 와이파이 주소로 연결 · 설정 열기)
export function PhonesPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    list,
    loading,
    warning,
    error,
    authWaiting,
    expandedIds,
    screenModes,
    load,
    refresh,
    subscribe,
    connectWifi,
    pairWifi,
    toggleExpand,
    clearWarning,
    clearError
  } = usePhoneStore()
  const [address, setAddress] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [pairAddress, setPairAddress] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [pairing, setPairing] = useState(false)
  // 도구 설치 여부(카드가 알려 준다). null 은 아직 확인 전이다
  const [toolsInstalled, setToolsInstalled] = useState<boolean | null>(null)
  const onToolsStatus = useCallback(
    (s: { installed: boolean }) => setToolsInstalled(s.installed),
    []
  )
  // 폰 설정은 이 화면 안에서 톱니로 여닫는다(설정 페이지에는 더 이상 폰 섹션이 없다)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)

  // 패널을 처음 열 때만 설정을 읽어 온다
  useEffect(() => {
    if (!settingsOpen || settings) return
    void window.samba.settings.get().then((r) => {
      if (r.ok) setSettings(r.data)
    })
  }, [settingsOpen, settings])

  // 낙관적으로 먼저 반영하고, 메인이 정규화한 값으로 덮어쓴다
  const updateSettings = useCallback((patch: Partial<Settings>): void => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    void window.samba.settings.set(patch).then((r) => {
      if (r.ok) setSettings(r.data)
    })
  }, [])

  useEffect(() => {
    void load()
    return subscribe()
  }, [load, subscribe])

  // 폰이 하나도 안 잡히고 도구도 없을 때만 설치 카드를 맨 위로 올린다
  const needsTools = list.length === 0 && toolsInstalled === false

  const onPair = async (): Promise<void> => {
    setPairing(true)
    const r = await pairWifi(pairAddress.trim(), pairCode.trim())
    setPairing(false)
    // 코드는 1회용이다 — 성공하든 실패하든 칸에 남기지 않는다
    setPairCode('')
    if (r === null) return
    if (r.ok) setPairAddress('')
    setNotice(r.ok ? t('phone.pairDone') : t('phone.pairFailed', { message: r.message }))
  }

  const onConnect = async (): Promise<void> => {
    const value = address.trim()
    if (!value) return
    const message = await connectWifi(value)
    if (message !== null) {
      setAddress('')
      setNotice(message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-[18px] font-semibold tracking-tight text-[var(--text)]">
            {t('phone.title')}
          </h1>
          <p className="text-[12px] text-[var(--text2)]">
            {t('phone.subtitle')}
          </p>
        </header>

        {/* 폰도 안 잡히고 도구도 없으면 이 카드가 첫 화면이다 */}
        {needsTools && <ToolsInstallCard onStatus={onToolsStatus} />}

        {/* 상단 도구줄 */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--line)] bg-white p-3">
          <SecondaryButton className="h-[30px]" disabled={loading} onClick={() => void refresh()}>
            {t('phone.findNow')}
          </SecondaryButton>
          <div className="flex min-w-[220px] flex-1 items-center gap-2">
            <TextInput
              value={address}
              onChange={setAddress}
              placeholder={t('phone.wifiPlaceholder')}
              className="h-[30px]"
            />
            <SecondaryButton
              className="h-[30px]"
              disabled={!address.trim()}
              onClick={() => void onConnect()}
            >
              {t('phone.wifiConnect')}
            </SecondaryButton>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            title={
              settingsOpen ? t('phone.settings.settingsClose') : t('phone.settings.settingsOpen')
            }
            aria-expanded={settingsOpen}
            className={cn(
              'flex h-[30px] shrink-0 items-center gap-1.5 rounded-[9px] border px-2.5 text-[12.5px]',
              settingsOpen
                ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
                : 'border-[var(--line)] text-[var(--text)] hover:bg-black/5'
            )}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('phone.settings.settingsOpen')}
          </button>
        </div>

        {/* USB 를 한 번도 꽂지 않은 폰은 페어링 코드로 이 PC 를 등록한다(안드로이드 11+ 무선 디버깅) */}
        <details className="rounded-2xl border border-[var(--line)] bg-white p-3">
          <summary className="cursor-pointer text-[12.5px] font-medium text-[var(--text)]">
            {t('phone.pairTitle')}
          </summary>
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text2)]">
            {t('phone.pairHelp')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <TextInput
              value={pairAddress}
              onChange={setPairAddress}
              placeholder={t('phone.pairAddressPlaceholder')}
              className="h-[30px] min-w-[220px] flex-1"
            />
            <TextInput
              value={pairCode}
              onChange={setPairCode}
              placeholder={t('phone.pairCodePlaceholder')}
              className="h-[30px] w-[120px]"
            />
            <SecondaryButton
              className="h-[30px]"
              disabled={pairing || !pairAddress.trim() || !pairCode.trim()}
              onClick={() => void onPair()}
            >
              {t('phone.pairButton')}
            </SecondaryButton>
          </div>
        </details>

        {/* 폰 설정 — 열었을 때만 그린다 */}
        {settingsOpen && settings && (
          <div className="flex flex-col gap-4">
            <PhoneSettingsPanel settings={settings} update={updateSettings} />
          </div>
        )}

        {warning && (
          <Notice text={warning} onClose={clearWarning} closeLabel={t('phone.dismiss')} />
        )}
        {error && <Notice text={error} onClose={clearError} closeLabel={t('phone.dismiss')} />}
        {notice && (
          <Notice text={notice} onClose={() => setNotice(null)} closeLabel={t('phone.dismiss')} />
        )}

        {list.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--text2)]">
            {t('phone.empty')}
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((phone) => (
              <PhoneCard
                key={phone.id}
                phone={phone}
                expanded={expandedIds.includes(phone.id)}
                highlighted={
                  authWaiting?.waiting === true &&
                  (authWaiting.phoneId === null || authWaiting.phoneId === phone.id)
                }
                screenMode={screenModes[phone.serial] ?? null}
                onToggle={() => toggleExpand(phone.id)}
              />
            ))}
          </div>
        )}

        {!needsTools && <ToolsInstallCard onStatus={onToolsStatus} />}
      </div>
    </div>
  )
}

// 안내 줄 — 메인이 보낸 경고·오류·연결 결과를 같은 모양으로 보여 준다
function Notice({
  text,
  onClose,
  closeLabel
}: {
  text: string
  onClose: () => void
  closeLabel: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-[10px] border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-[var(--text2)]">
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={onClose} className="shrink-0 underline">
        {closeLabel}
      </button>
    </div>
  )
}
