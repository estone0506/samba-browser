import type React from 'react'
import { useTranslation } from 'react-i18next'
import { UserCheck } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chatStore'

// 캡차·2FA 넘김 카드. 사이트가 사람의 확인을 요구하면 작업을 멈추고 이 카드를 띄운다.
// 사용자가 화면에서 직접 입력하면 메인이 그것을 감지해 작업을 자동으로 이어 간다.
// 애플 스타일: 경고색 없이 무채색만, 흰 배경·얇은 선·은은한 그림자.
// (ConfirmCard 와 같은 이유로 웹뷰에 가리지 않는 채팅 패널 안에 인라인으로 띄운다)
export function HandoffCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const handoff = useChatStore((s) => s.handoff)
  const replyHandoff = useChatStore((s) => s.replyHandoff)
  if (!handoff) return null
  return (
    <div
      role="alertdialog"
      aria-label={t('handoff.title')}
      className="mx-3 mb-1 animate-in rounded-[14px] border border-[var(--line)] bg-white p-3 shadow-[0_8px_24px_rgba(0,0,0,.06)] fade-in-0 slide-in-from-bottom-1 duration-150"
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/5">
          <UserCheck className="h-3.5 w-3.5 text-[var(--text)]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--text)]">{t('handoff.title')}</div>
          <p className="mt-1 break-words text-[12.5px] leading-relaxed text-[var(--text2)]">
            {t('handoff.body')}
          </p>
          <p className="mt-1 truncate text-[11px] text-[var(--text2)]" title={handoff.url}>
            {handoff.url}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-[30px] rounded-[9px] border-[var(--line)] bg-white"
          onClick={() => replyHandoff(handoff.requestId, false)}
        >
          {t('handoff.abort')}
        </Button>
        <Button
          size="sm"
          className="h-[30px] rounded-[9px] bg-[var(--text)] text-white hover:bg-[var(--text)]/90"
          onClick={() => replyHandoff(handoff.requestId, true)}
        >
          {t('handoff.skip')}
        </Button>
      </div>
    </div>
  )
}
