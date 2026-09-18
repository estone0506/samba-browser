import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, RotateCw, Home, Lock, Monitor, Smartphone } from 'lucide-react'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { cn } from '@renderer/lib/utils'

// 이펙트에서 setState 하면 리렌더가 겹치므로, 렌더 도중 활성 탭 URL 변화를 감지해 상태를 맞춤
function AddressBarButton({
  onClick,
  title,
  children
}: {
  onClick: () => void
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5"
    >
      {children}
    </button>
  )
}

export function AddressBar(): React.JSX.Element {
  const { t } = useTranslation()
  const { activeTab, navigate, back, forward, reload, setMobile } = useBrowserStore()
  const [value, setValue] = useState(activeTab?.url ?? '')
  const [syncedUrl, setSyncedUrl] = useState(activeTab?.url)
  if (activeTab?.url !== syncedUrl) {
    setSyncedUrl(activeTab?.url)
    setValue(activeTab?.url ?? '')
  }

  // === 홈 버튼 (신규 추가분) ==================================================
  // 클릭 시점에 최신 설정을 읽어 활성 탭을 홈 주소로 이동한다
  const goHome = (): void => {
    void window.samba.settings.get().then((r) => {
      if (r.ok) void navigate(r.data.homeUrl)
    })
  }
  // === 신규 추가분 끝 ==========================================================

  return (
    <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--bg)] px-3 py-2">
      <AddressBarButton onClick={back}>
        <ArrowLeft className="h-4 w-4" />
      </AddressBarButton>
      <AddressBarButton onClick={forward}>
        <ArrowRight className="h-4 w-4" />
      </AddressBarButton>
      <AddressBarButton onClick={reload}>
        <RotateCw className="h-4 w-4" />
      </AddressBarButton>
      <AddressBarButton onClick={goHome} title={t('address.home')}>
        <Home className="h-4 w-4" />
      </AddressBarButton>
      <form
        className="flex h-8 flex-1 items-center gap-2 rounded-[10px] border border-[var(--line)] bg-white px-3"
        onSubmit={(e) => {
          e.preventDefault()
          void navigate(value)
        }}
      >
        <Lock className="h-3.5 w-3.5 text-[var(--text3)]" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('address.placeholder')}
          className="flex-1 bg-transparent text-[12.5px] outline-none"
        />
      </form>
      <div className="flex rounded-[9px] bg-black/5 p-0.5">
        {[
          { m: false, icon: Monitor, label: t('address.pc') },
          { m: true, icon: Smartphone, label: t('address.mobile') }
        ].map(({ m, icon: Icon, label }) => (
          <button
            key={label}
            onClick={() => setMobile(m)}
            className={cn(
              'flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] text-[var(--text2)]',
              (activeTab?.mobile ?? false) === m &&
                'bg-white font-medium text-[var(--text)] shadow-sm'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex h-8 items-center gap-2 rounded-[10px] border border-[var(--line)] bg-white px-2.5 text-[12.5px]">
        {activeTab?.profile ?? 'default'}
      </div>
    </div>
  )
}
