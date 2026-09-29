import { useEffect } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Lock, X } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore } from '@renderer/stores/vaultStore'

// main 의 pendingCapture TTL(60초)과 맞춘 자동 소멸 시간
const PROMPT_DISMISS_MS = 60_000
// 자동 저장 알림은 짧게(되돌리기 토큰 자체는 60초 유효)
const NOTICE_DISMISS_MS = 8_000

const barClass =
  'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--line)] bg-[var(--bg)] px-3 py-2 animate-in fade-in-0 slide-in-from-top-1 duration-150'
const outlineButton = 'h-[28px] rounded-[8px] border-[var(--line)] bg-white px-2.5 text-[12px]'
const primaryButton =
  'h-[28px] rounded-[8px] bg-[var(--text)] px-3 text-[12px] text-white hover:bg-[var(--text)]/90'

// 로그인 자격증명 저장 확인 바 — 주소창 바로 아래에 뜬다(크롬 '비밀번호 저장' 흐름).
// 메인이 로그인 성공을 확인한 뒤 push 하는 {host, 가린 아이디, isNew, locked} 만 보여 준다.
// 비밀번호는 절대 이 경로로 오지 않는다. 웹 영역(WebArea)이 이 바만큼 줄어들어 페이지를 가리지 않는다.
// '묻지 않고 자동 저장'이 켜져 있어 이미 저장·갱신된 경우엔 되돌리기 알림으로 뜬다
export function LoginSaveBar(): React.JSX.Element | null {
  const capture = useVaultStore((s) => s.capture)
  const notice = useVaultStore((s) => s.passwordUpdated)
  if (capture) return <CaptureBar />
  if (notice) return <SavedNotice />
  return null
}

function CaptureBar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const capture = useVaultStore((s) => s.capture)
  const decideCapture = useVaultStore((s) => s.decideCapture)
  const setCapture = useVaultStore((s) => s.setCapture)
  const vaultState = useVaultStore((s) => s.state)
  // 인라인 잠금 해제 전용 — settings.set(vaultRememberDevice) 를 건드리지 않는다
  const unlockOnly = useVaultStore((s) => s.unlockOnly)
  const loading = useVaultStore((s) => s.loading)
  const unlocking = useVaultStore((s) => s.captureUnlocking)
  const setUnlocking = useVaultStore((s) => s.setCaptureUnlocking)
  const pw = useVaultStore((s) => s.capturePw)
  const setPw = useVaultStore((s) => s.setCapturePw)
  const err = useVaultStore((s) => s.captureErr)
  const setErr = useVaultStore((s) => s.setCaptureErr)

  // 60초가 지나면 스스로 사라진다(main 쪽 보관 값도 그때 만료된다 — 답을 보낼 필요가 없다)
  useEffect(() => {
    if (!capture) return
    const timer = setTimeout(() => setCapture(null), PROMPT_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [capture, setCapture])

  if (!capture) return null

  const isLocked = vaultState !== 'unlocked'
  // 잠긴 상태에서 감지된 제안은 기존 계정 여부를 알 수 없어 "새 계정" 이라고 단정하지 않는다
  const titleKey = capture.locked
    ? 'capture.titleLocked'
    : capture.isNew
      ? 'capture.title'
      : 'capture.titleUpdate'
  const saveKey = capture.isNew || capture.locked ? 'capture.save' : 'capture.update'

  const submitUnlock = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setErr(null)
    const ok = await unlockOnly(pw)
    if (!ok) {
      // captureErr 에는 번역된 문장이 아니라 i18n 키를 담는다
      setErr('vault.unlock.failed')
      setPw('')
      return
    }
    decideCapture('save')
  }

  return (
    <div role="alertdialog" aria-label={t(titleKey, { host: capture.host })} className={barClass}>
      <div className="flex min-w-0 flex-1 basis-[220px] items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/5">
          <KeyRound className="h-3.5 w-3.5 text-[var(--text)]" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-[var(--text)]">
            {t(titleKey, { host: capture.host })}
          </div>
          <div className="truncate text-[11.5px] text-[var(--text2)]">
            {t('capture.account', { host: capture.host, username: capture.username })}
          </div>
        </div>
      </div>

      {isLocked && unlocking ? (
        <form
          onSubmit={submitUnlock}
          className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-[var(--line)] bg-white px-2.5 sm:w-[220px] sm:flex-none">
            <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
            <Input
              type="password"
              autoFocus
              placeholder={t('vault.unlock.placeholder')}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className="h-7 border-0 bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={outlineButton}
            onClick={() => {
              setUnlocking(false)
              setPw('')
              setErr(null)
            }}
          >
            {t('vault.editor.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={loading} className={primaryButton}>
            {t('vault.unlock.submit')}
          </Button>
          {err && <p className="w-full text-[11.5px] text-[#b91c1c]">{t(err)}</p>}
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {(capture.isNew || capture.locked) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-[28px] rounded-[8px] px-2 text-[12px] text-[var(--text2)]"
              onClick={() => decideCapture('never')}
            >
              {t('capture.never')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className={outlineButton}
            onClick={() => decideCapture('skip')}
          >
            {t('capture.skip')}
          </Button>
          <Button
            size="sm"
            className={primaryButton}
            onClick={() => (isLocked ? setUnlocking(true) : decideCapture('save'))}
          >
            {isLocked ? t('capture.unlockToSave') : t(saveKey)}
          </Button>
        </div>
      )}
    </div>
  )
}

function SavedNotice(): React.JSX.Element | null {
  const { t } = useTranslation()
  const notice = useVaultStore((s) => s.passwordUpdated)
  const setNotice = useVaultStore((s) => s.setPasswordUpdated)
  const undo = useVaultStore((s) => s.undoPasswordUpdate)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [notice, setNotice])

  if (!notice) return null
  const key = notice.kind === 'saved' ? 'capture.saved' : 'capture.updated'

  return (
    <div role="status" aria-live="polite" className={barClass}>
      <div className="flex min-w-0 flex-1 basis-[200px] items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/5">
          <KeyRound className="h-3.5 w-3.5 text-[var(--text)]" />
        </span>
        <p className="min-w-0 truncate text-[12.5px] text-[var(--text)]">
          {t(key, { host: notice.host, username: notice.username })}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="outline" className={outlineButton} onClick={undo}>
          {t('capture.undo')}
        </Button>
        <button
          type="button"
          aria-label={t('capture.close')}
          onClick={() => setNotice(null)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text2)] hover:bg-black/5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
