// 페이지 내 자동 채움 피커(격리 월드 preload → 메인)의 검증·레이트리밋 전담 모듈.
// vault-capture.ts 의 게이트 패턴을 그대로 따른다(발신자 검증 → 레이트리밋 → 호스트 대조).
// electron 의존이 없어 테스트에서 그대로 호출할 수 있다.
//
// 이 경로로는 비밀값이 한 바이트도 나가지 않는다:
// - 목록 응답은 {id,label,username} 뿐이다(사용자 본인 화면이라 username 은 가리지 않는다)
// - 채우기는 accountId 만 받고, 값은 메인이 격리 월드 인자로 직접 넣는다

import { z } from 'zod'
import { normalizeHost } from '../../shared/host'
import type { PickerAccountDto, VaultState } from '../../shared/vault'

export const pickerHostSchema = z.string().min(1).max(512)
export const pickerFillSchema = z.object({
  accountId: z.number().int().positive()
})

// 피커는 사용자가 아이콘을 누를 때마다 열리므로 저장 제안보다 넉넉하게 잡는다
export const PICKER_WINDOW_MS = 30_000
export const PICKER_MAX_PER_WINDOW = 60

// VaultService 중 피커 경로에서 실제로 쓰는 부분만 좁힌 인터페이스
export interface PickerVaultLike {
  state: () => VaultState
  listPickerAccounts: (host: string) => PickerAccountDto[]
}

// ipcMain 이벤트에서 뽑아낸, 신뢰 판단에 필요한 정보(vault-capture 와 같은 모양)
export interface PickerSender {
  // tabs.hasWebContents(e.sender) — 실제 탭의 webContents 인가
  trusted: boolean
  // e.senderFrame?.url — 메시지를 보낸 프레임의 실제 URL(확인 불가면 빈 문자열)
  frameUrl: string
}

export type PickerOutcome =
  'ok' | 'locked' | 'untrusted-sender' | 'rate-limited' | 'invalid' | 'host-mismatch' | 'excluded'

export interface PickerAccountsResult {
  outcome: PickerOutcome
  // 잠금·거부 시에는 항상 빈 배열이다
  accounts: PickerAccountDto[]
}

export interface PickerFillResult {
  outcome: PickerOutcome
  accountId?: number
  // 검증을 통과한 발신 프레임의 호스트(핸들러가 계정 소유 호스트 대조에 쓴다)
  host?: string
}

export interface VaultPickerGateDeps {
  vault: PickerVaultLike
  // 제외 도메인(설정에서 매번 최신 값을 읽는다)
  excludedHosts: () => string[]
  // 테스트에서 시간 흐름을 제어하기 위한 주입점
  now?: () => number
}

export class VaultPickerGate {
  private readonly sentAt = new WeakMap<object, number[]>()

  constructor(private readonly deps: VaultPickerGateDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private isRateLimited(senderKey: object): boolean {
    const now = this.now()
    const timestamps = (this.sentAt.get(senderKey) ?? []).filter((t) => now - t < PICKER_WINDOW_MS)
    if (timestamps.length >= PICKER_MAX_PER_WINDOW) {
      this.sentAt.set(senderKey, timestamps)
      return true
    }
    timestamps.push(now)
    this.sentAt.set(senderKey, timestamps)
    return false
  }

  // 발신자·레이트리밋·호스트 대조까지 공통으로 처리하고, 통과하면 정규화된 호스트를 돌려준다
  private verify(
    senderKey: object,
    sender: PickerSender,
    rawHost: string | null
  ): { outcome: PickerOutcome; host?: string } {
    if (!sender.trusted) return { outcome: 'untrusted-sender' }
    if (this.isRateLimited(senderKey)) return { outcome: 'rate-limited' }
    const frameHost = normalizeHost(sender.frameUrl)
    if (!frameHost) return { outcome: 'host-mismatch' }
    // 페이지가 보낸 host 는 참고값일 뿐이다. 실제 기준은 항상 발신 프레임의 URL 이다
    if (rawHost !== null) {
      const parsed = pickerHostSchema.safeParse(rawHost)
      if (!parsed.success) return { outcome: 'invalid' }
      const claimed = normalizeHost(parsed.data) || parsed.data
      if (claimed !== frameHost) return { outcome: 'host-mismatch' }
    }
    const excluded = this.deps.excludedHosts()
    if (excluded.some((h) => (normalizeHost(h) || h) === frameHost)) {
      return { outcome: 'excluded' }
    }
    return { outcome: 'ok', host: frameHost }
  }

  /** 드롭다운에 보여 줄 계정 목록. 잠겨 있으면 빈 목록 + 'locked' */
  accounts(senderKey: object, sender: PickerSender, rawHost: unknown): PickerAccountsResult {
    const verified = this.verify(
      senderKey,
      sender,
      typeof rawHost === 'string' ? rawHost : rawHost === undefined ? null : ''
    )
    if (verified.outcome !== 'ok' || !verified.host) {
      return { outcome: verified.outcome, accounts: [] }
    }
    if (this.deps.vault.state() !== 'unlocked') return { outcome: 'locked', accounts: [] }
    return { outcome: 'ok', accounts: this.deps.vault.listPickerAccounts(verified.host) }
  }

  /** 선택된 계정으로 채우기 요청. 실제 채우기는 호출부(메인)가 수행한다 */
  fill(senderKey: object, sender: PickerSender, raw: unknown): PickerFillResult {
    const verified = this.verify(senderKey, sender, null)
    if (verified.outcome !== 'ok' || !verified.host) return { outcome: verified.outcome }
    const parsed = pickerFillSchema.safeParse(raw)
    if (!parsed.success) return { outcome: 'invalid' }
    if (this.deps.vault.state() !== 'unlocked') return { outcome: 'locked' }
    return { outcome: 'ok', accountId: parsed.data.accountId, host: verified.host }
  }
}
