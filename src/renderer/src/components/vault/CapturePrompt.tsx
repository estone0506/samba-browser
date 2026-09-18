import { useEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Lock } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore } from '@renderer/stores/vaultStore'

// main 의 pendingCapture TTL(60초)과 맞춘 자동 소멸 시간
const AUTO_DISMISS_MS = 60_000

// 자동 저장 제안 카드. 로그인 폼 제출을 감지했을 때 메인이 push 하는 {host, username, isNew}
// 만 보여준다(비밀번호는 절대 이 경로로 오지 않는다). 메시지 목록 맨 위에 고정으로 띄운다.
// ConfirmCard 와 같은 애플 스타일: 흰 배경, 얇은 선, 무채색 아이콘, 검정 기본 버튼.
export function CapturePrompt(): React.JSX.Element | null {
  const { t } = useTranslation()
  const capture = useVaultStore((s) => s.capture)
  const decideCapture = useVaultStore((s) => s.decideCapture)
  const setCapture = useVaultStore((s) => s.setCapture)
  const vaultState = useVaultStore((s) => s.state)
  // CapturePrompt 인라인 잠금 해제 전용 — settings.set(vaultRememberDevice) 를 건드리지 않는다.
  // unlock(pw, false) 를 쓰면 "기기 기억" 설정이 false 로 영구 저장돼 이후 기기 기억 키가 삭제된다
  const unlockOnly = useVaultStore((s) => s.unlockOnly)
  const loading = useVaultStore((s) => s.loading)
  // 폼 상태는 store 레벨에서 관리한다(capture 대상이 바뀌면 store 가 알아서 초기화)
  const unlocking = useVaultStore((s) => s.captureUnlocking)
  const setUnlocking = useVaultStore((s) => s.setCaptureUnlocking)
  const pw = useVaultStore((s) => s.capturePw)
  const setPw = useVaultStore((s) => s.setCapturePw)
  const err = useVaultStore((s) => s.captureErr)
  const setErr = useVaultStore((s) => s.setCaptureErr)

  // 카드가 뜨고 60초가 지나면 자동으로 사라진다(main pendingCapture 만료와 동일 타이밍).
  // 이 경우는 결정을 보낼 필요가 없다 — main 쪽도 이미 만료돼 있다.
  useEffect(() => {
    if (!capture) return
    const timer = setTimeout(() => {
      setCapture(null)
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [capture, setCapture])

  if (!capture) return null

  const isLocked = vaultState !== 'unlocked'
  // 잠긴 상태에서 감지된 제안은 기존 계정 여부를 알 수 없어 isNew 가 항상 true 다.
  // 그래서 "새 계정" 이라고 단정하지 않는 중립 문구를 쓴다
  const titleKey = capture.locked
    ? 'capture.titleLocked'
    : capture.isNew
      ? 'capture.title'
      : 'capture.titleUpdate'

  const submitUnlock = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setErr(null)
    const ok = await unlockOnly(pw)
    if (!ok) {
      // captureErr 에는 번역된 문장이 아니라 i18n 키를 담는다(store 에서도 설정하기 때문)
      setErr('vault.unlock.failed')
      setPw('')
      return
    }
    decideCapture(true)
  }

  return (
    <div
      role="alertdialog"
      aria-label={t(titleKey, { host: capture.host })}
      className="mx-3 mt-3 mb-1 animate-in rounded-[14px] border border-[var(--line)] bg-white p-3 shadow-[0_8px_24px_rgba(0,0,0,.06)] fade-in-0 slide-in-from-top-1 duration-150"
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/5">
          <KeyRound className="h-3.5 w-3.5 text-[var(--text)]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--text)]">
            {t(titleKey, { host: capture.host })}
          </div>
          <p className="mt-1 break-words text-[12.5px] leading-relaxed text-[var(--text2)]">
            {t('capture.body', { host: capture.host, username: capture.username })}
          </p>
        </div>
      </div>

      {isLocked && unlocking ? (
        <form onSubmit={submitUnlock} className="mt-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-[9px] border border-[var(--line)] bg-[var(--bg)] px-2.5">
            <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
            <Input
              type="password"
              autoFocus
              placeholder={t('vault.unlock.placeholder')}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          {err && <p className="text-[12px] text-[#b91c1c]">{t(err)}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-[30px] rounded-[9px] border-[var(--line)] bg-white"
              onClick={() => {
                setUnlocking(false)
                setPw('')
                setErr(null)
              }}
            >
              {t('vault.editor.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={loading}
              className="h-[30px] rounded-[9px] bg-[var(--text)] text-white hover:bg-[var(--text)]/90"
            >
              {t('vault.unlock.submit')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2.5 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-[30px] rounded-[9px] border-[var(--line)] bg-white"
            onClick={() => decideCapture(false)}
          >
            {t('capture.skip')}
          </Button>
          <Button
            size="sm"
            autoFocus
            className="h-[30px] rounded-[9px] bg-[var(--text)] text-white hover:bg-[var(--text)]/90"
            onClick={() => (isLocked ? setUnlocking(true) : decideCapture(true))}
          >
            {isLocked ? t('capture.unlockToSave') : t('capture.save')}
          </Button>
        </div>
      )}
    </div>
  )
}
