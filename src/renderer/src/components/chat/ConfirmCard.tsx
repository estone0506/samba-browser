import type React from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chatStore'

// 위험 행동 확인 카드.
// 네이티브 WebContentsView 는 렌더러 DOM 위에 겹쳐 그려지므로 fixed 모달은 웹뷰에 가려진다.
// 그래서 웹뷰 영역 바깥인 오른쪽 채팅 패널 안(메시지 목록 아래·입력창 위)에 인라인으로 띄운다.
export function ConfirmCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const confirm = useChatStore((s) => s.confirm)
  const reply = useChatStore((s) => s.reply)
  if (!confirm) return null
  return (
    <div
      role="alertdialog"
      aria-label={t('confirm.title')}
      className="mx-3 mb-1 rounded-xl border-2 border-[var(--warn)] bg-[var(--warn)]/10 p-3 shadow-[0_2px_10px_rgba(0,0,0,.08)]"
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <TriangleAlert className="h-4 w-4 text-[var(--warn)]" />
        {t('confirm.title')}
      </div>
      <p className="mt-1.5 break-words text-[13px] leading-relaxed text-[var(--text2)]">
        {t('confirm.body', { action: confirm.action })}
      </p>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => reply(confirm.requestId, false)}>
          {t('confirm.deny')}
        </Button>
        <Button size="sm" autoFocus onClick={() => reply(confirm.requestId, true)}>
          {t('confirm.approve')}
        </Button>
      </div>
    </div>
  )
}
