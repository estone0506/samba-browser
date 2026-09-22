import type React from 'react'
import { useTranslation } from 'react-i18next'
import { SignInCard } from '@renderer/components/settings/AccountSection'

// 로그인 게이트 — 계정 로그인 전에는 이 화면뿐이다(사이드바·탭·대화 전부 숨김).
// 자리를 비운 사이 다른 사람이 앱을 열어도 내 북마크·대화·금고가 보이지 않게 한다
export function LoginGate(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center justify-center bg-[var(--bg)] p-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-4 text-center">
          <div className="text-[18px] font-semibold text-[var(--text)]">{t('app.name')}</div>
          <div className="text-[12px] text-[var(--text2)]">{t('account.gateHint')}</div>
        </div>
        <SignInCard />
      </div>
    </div>
  )
}
