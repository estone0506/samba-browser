import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Hand, ShieldAlert } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chatStore'

// 확인 카드. 위험 행동(danger)과 작업 완료(finish) 두 용도를 같은 컴포넌트로 표현한다.
// 애플 스타일: 경고색 없이 무채색만 사용 — 흰 배경, 얇은 선, 은은한 그림자, 검정 기본 버튼.
// 네이티브 WebContentsView 는 렌더러 DOM 위에 겹쳐 그려지므로 fixed 모달은 웹뷰에 가려진다.
// 그래서 웹뷰 영역 바깥인 오른쪽 채팅 패널 안(메시지 목록 아래·입력창 위)에 인라인으로 띄운다.
export function ConfirmCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const confirm = useChatStore((s) => s.confirm)
  const reply = useChatStore((s) => s.reply)
  if (!confirm) return null
  const isFinish = confirm.kind === 'finish'
  const Icon = isFinish ? Hand : ShieldAlert
  const title = isFinish ? t('confirm.finish') : t('confirm.title')
  const body = isFinish ? confirm.action : t('confirm.body', { action: confirm.action })
  const approveLabel = isFinish ? t('confirm.finishOk') : t('confirm.approve')
  const denyLabel = isFinish ? t('confirm.continue') : t('confirm.deny')
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="mx-3 mb-1 animate-in rounded-[14px] border border-[var(--line)] bg-white p-3 shadow-[0_8px_24px_rgba(0,0,0,.06)] fade-in-0 slide-in-from-bottom-1 duration-150"
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/5">
          <Icon className="h-3.5 w-3.5 text-[var(--text)]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--text)]">{title}</div>
          <p className="mt-1 break-words text-[12.5px] leading-relaxed text-[var(--text2)]">
            {body}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-[30px] rounded-[9px] border-[var(--line)] bg-white"
          onClick={() => reply(confirm.requestId, false)}
        >
          {denyLabel}
        </Button>
        <Button
          size="sm"
          autoFocus
          className="h-[30px] rounded-[9px] bg-[var(--text)] text-white hover:bg-[var(--text)]/90"
          onClick={() => reply(confirm.requestId, true)}
        >
          {approveLabel}
        </Button>
      </div>
    </div>
  )
}
