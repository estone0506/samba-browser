import type React from 'react'
import { useTranslation } from 'react-i18next'
import { PHONE_PAD_KEYS } from './phone-view'

// 사람이 직접 누르는 하드웨어 키 패드(뒤로·홈·최근·전원).
// 화면 API 가 아직 없는 빌드에서는 버튼을 눌러도 아무 일도 하지 않게 막는다
export function PhoneManualPad({ serial }: { serial: string }): React.JSX.Element {
  const { t } = useTranslation()
  const ready = typeof window.samba.phone.key === 'function'
  return (
    <div className="flex flex-wrap gap-1.5">
      {PHONE_PAD_KEYS.map(({ key, labelKey }) => (
        <button
          key={key}
          type="button"
          disabled={!ready}
          onClick={() => void window.samba.phone.key?.(serial, key)}
          className="h-[30px] rounded-[9px] border border-[var(--line)] px-2.5 text-[12px] text-[var(--text2)] hover:bg-black/5 disabled:opacity-40"
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  )
}
