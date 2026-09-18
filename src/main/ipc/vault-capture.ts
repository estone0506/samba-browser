// vault:capture(격리 월드 preload → 메인) 메시지의 검증·레이트리밋·저장 제안 판단 전담 모듈.
// electron 의존이 없어 테스트에서 그대로 호출할 수 있다.
//
// 메인 프로세스는 페이지가 보낸 값을 신뢰하지 않는다:
// - 발신자가 실제 탭의 webContents 인지(위조 발신자 차단)
// - 발신 프레임의 URL 호스트와 payload 의 host 가 같은지(호스트 위조 차단)
// - sender 당 30초에 3회까지만(preload 레이트리밋 우회 대비)
// 어떤 경우에도 비밀번호 값 자체는 로그·반환값에 남기지 않는다.

import { z } from 'zod'
import { normalizeHost, registrableDomain } from '../../shared/host'
import type { VaultState } from '../../shared/vault'

export const captureSchema = z.object({
  host: z.string().min(1).max(512),
  username: z.string().max(512),
  password: z.string().min(1).max(512)
})

export const CAPTURE_WINDOW_MS = 30_000
export const CAPTURE_MAX_PER_WINDOW = 3

// VaultService 중 capture 경로에서 실제로 쓰는 부분만 좁힌 인터페이스
export interface CaptureVaultLike {
  state: () => VaultState
  hasSameSecret: (host: string, username: string, password: string) => boolean
  listAccounts: (host?: string) => { username: string }[]
  setPendingCapture: (capture: {
    host: string
    username: string
    password: string
    isNew: boolean
    locked: boolean
  }) => void
}

// ipcMain 이벤트에서 뽑아낸, 신뢰 판단에 필요한 정보
export interface CaptureSender {
  // tabs.hasWebContents(e.sender) — 실제 탭의 webContents 인가
  trusted: boolean
  // e.senderFrame?.url — 메시지를 보낸 프레임의 실제 URL(확인 불가면 빈 문자열)
  frameUrl: string
}

// 처리 결과. 값(비밀번호)은 절대 담지 않는다
export type CaptureOutcome =
  | 'accepted'
  | 'untrusted-sender'
  | 'rate-limited'
  | 'invalid'
  | 'host-mismatch'
  | 'excluded'
  | 'duplicate'

export interface VaultCaptureGateDeps {
  vault: CaptureVaultLike
  // 제외 도메인(설정에서 매번 최신 값을 읽는다)
  excludedHosts: () => string[]
  // 테스트에서 시간 흐름을 제어하기 위한 주입점
  now?: () => number
}

export class VaultCaptureGate {
  // sender(webContents) 별 최근 전송 시각. WeakMap 이라 탭이 닫히면 함께 사라진다
  private readonly sentAt = new WeakMap<object, number[]>()

  constructor(private readonly deps: VaultCaptureGateDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private isRateLimited(senderKey: object): boolean {
    const now = this.now()
    const timestamps = (this.sentAt.get(senderKey) ?? []).filter((t) => now - t < CAPTURE_WINDOW_MS)
    if (timestamps.length >= CAPTURE_MAX_PER_WINDOW) {
      this.sentAt.set(senderKey, timestamps)
      return true
    }
    timestamps.push(now)
    this.sentAt.set(senderKey, timestamps)
    return false
  }

  /** 한 건의 vault:capture 메시지를 처리한다. 저장 제안을 띄웠으면 'accepted' */
  handle(senderKey: object, sender: CaptureSender, raw: unknown): CaptureOutcome {
    // 발신자가 실제 탭의 webContents 가 아니면 무시(위조 발신자 방지)
    if (!sender.trusted) return 'untrusted-sender'
    if (this.isRateLimited(senderKey)) return 'rate-limited'

    const parsed = captureSchema.safeParse(raw)
    if (!parsed.success) return 'invalid'
    const { host: rawHost, username, password } = parsed.data

    // payload 의 host 는 페이지가 준 값이므로, 발신 프레임의 실제 URL 과 반드시 대조한다.
    // 프레임 URL 을 알 수 없으면(빈 문자열) 검증할 수 없으므로 받지 않는다.
    // iframe 등으로 같은 사이트의 다른 서브도메인(예: 로그인 서브도메인)에서 캡처가 오는 경우가
    // 있으므로, 정확 일치가 아니어도 등록 도메인(eTLD+1)이 같으면 허용한다
    const frameHost = normalizeHost(sender.frameUrl)
    const host = normalizeHost(rawHost) || rawHost
    if (
      !frameHost ||
      (frameHost !== host && registrableDomain(frameHost) !== registrableDomain(host))
    ) {
      return 'host-mismatch'
    }

    // 제외 도메인이면 저장 제안 자체를 띄우지 않는다
    const excluded = this.deps.excludedHosts()
    if (excluded.some((h) => (normalizeHost(h) || h) === host)) return 'excluded'

    const vault = this.deps.vault
    if (vault.state() === 'unlocked') {
      // 기존 값과 동일하면 제안하지 않는다
      if (vault.hasSameSecret(host, username, password)) return 'duplicate'
      const isNew = !vault.listAccounts(host).some((a) => a.username === username)
      vault.setPendingCapture({ host, username, password, isNew, locked: false })
      return 'accepted'
    }

    // 잠긴 상태에서는 기존 계정·값을 확인할 수 없다. locked 를 함께 넘겨
    // UI 가 "새 계정" 이라고 단정하지 않도록 한다
    vault.setPendingCapture({ host, username, password, isNew: true, locked: true })
    return 'accepted'
  }
}
