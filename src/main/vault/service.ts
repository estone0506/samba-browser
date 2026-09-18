// 금고 서비스 — 잠금/해제 상태, 항목 CRUD, 감사 로그, 자동 잠금, 저장 제안 보관을 담당한다.
//
// 비밀값 규칙
// - 마스터 키는 이 인스턴스의 private 필드에만 존재한다(파일·로그·IPC 어디에도 없음)
// - 평문을 돌려주는 메서드는 reveal(사용자 클릭)과 getSecretForFill(메인 내부 전용) 둘뿐이다
// - 목록/메타 반환값에는 ciphertext·iv·평문 필드가 아예 존재하지 않는다
//
// AAD 전략
// - 항목 암호문의 AAD 는 `String(item.id)` 다. id 는 INSERT 시점에 정해지므로
//   "빈 암호문으로 행을 먼저 만들고(id 확보) → 같은 트랜잭션에서 암호문을 UPDATE" 하는 방식을 쓴다.
//   (per-item 랜덤 aadToken 컬럼을 추가하는 대안 대신, 스키마 변경이 없는 이 방식을 선택했다)

import { timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/client'
import { VaultRepo, type AuditRow } from './repo'
import {
  randomBytes,
  deriveKey,
  encrypt,
  decrypt,
  makeVerifier,
  checkVerifier,
  zeroize,
  clampMemoryKiB,
  resolveDefaultKdfParams,
  type KdfParams
} from './crypto'
import type {
  AccountDto,
  CapturePromptDto,
  SiteDto,
  VaultItemMeta,
  VaultItemType,
  VaultState
} from '../../shared/vault'
import type { Settings } from '../../shared/settings'
import { normalizeHost } from '../../shared/host'

// electron safeStorage 중 실제로 쓰는 부분만 좁혀 둔 인터페이스(테스트에서 스텁 주입)
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

// SettingsStore 를 통째로 요구하지 않는다(테스트에서 electron 의존 제거)
export interface SettingsReader {
  get: () => Settings
}

export interface VaultServiceOptions {
  safeStorage?: SafeStorageLike
}

export interface PutItemInput {
  // 편집 대상 항목 id. 주면 그 항목을 그대로 갱신한다(라벨·종류 변경 포함)
  id?: number
  accountId: number | null
  type: VaultItemType
  label: string
  value: string
}

export interface UpsertAccountInput {
  id?: number
  host: string
  // 생략하면 기존 계정의 라벨을 유지한다(repo.upsertAccount 참고)
  label?: string
  username: string
  // 생략하면 기존 계정의 기본 계정 여부를 유지한다
  isDefault?: boolean
  siteName?: string
  loginUrl?: string
}

// 저장 제안으로 잡아 둔 자격정보. password 는 메인 메모리에만 60초 머문다
export interface PendingCapture {
  host: string
  username: string
  password: string
  isNew: boolean
}

const META_SALT = 'salt'
const META_VERIFIER_CT = 'verifier_ct'
const META_VERIFIER_IV = 'verifier_iv'
const META_KDF_PARAMS = 'kdf_params'
const META_DEVICE_KEY = 'device_wrapped_key'

const SALT_BYTES = 16
const CAPTURE_TTL_MS = 60_000
const MINUTE_MS = 60_000

export class VaultService {
  private readonly repo: VaultRepo
  private readonly safeStorage?: SafeStorageLike
  // 마스터 키. 잠금 해제 상태에서만 값이 있고, lock() 이 0으로 덮어쓴다
  private key: Buffer | null = null
  private autoLockTimer: ReturnType<typeof setTimeout> | undefined
  private captureTimer: ReturnType<typeof setTimeout> | undefined
  private pending: (PendingCapture & { expiresAt: number }) | null = null
  private listeners = new Set<(state: VaultState) => void>()
  private captureListeners = new Set<(prompt: CapturePromptDto) => void>()
  // dispose() 가 이미 실행됐는지(중복 호출 방어). before-quit 과 창 closed 이벤트
  // 양쪽에서 종료 정리를 부를 수 있어서 필요하다
  private disposed = false

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsReader,
    options: VaultServiceOptions = {}
  ) {
    this.repo = new VaultRepo(db)
    this.safeStorage = options.safeStorage
    this.tryDeviceUnlock()
  }

  // --- 상태 -------------------------------------------------------------

  state(): VaultState {
    // 키를 이미 들고 있으면 DB 를 다시 확인할 필요가 없다 — DB 가 닫힌 뒤에도
    // (종료 순서가 겹치는 경우) 안전하게 'unlocked' 를 돌려줄 수 있다
    if (this.key) return 'unlocked'
    if (!this.isInitialized()) return 'uninitialized'
    return 'locked'
  }

  onStateChanged(cb: (state: VaultState) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private emit(): void {
    const s = this.state()
    for (const cb of this.listeners) cb(s)
  }

  private isInitialized(): boolean {
    // DB 가 이미 닫혔으면(종료 중) 쿼리를 시도하지 않는다 — sql.js 는 닫힌 핸들에 대한
    // 쿼리에서 'out of memory' 예외를 던진다
    if (this.db.isClosed) return false
    return this.repo.getMeta(META_SALT) !== null && this.repo.getMeta(META_VERIFIER_CT) !== null
  }

  // --- 설정/해제 ---------------------------------------------------------

  async setup(master: string): Promise<void> {
    if (this.isInitialized()) throw new Error('금고가 이미 설정되어 있습니다')
    if (master.length === 0) throw new Error('마스터 비밀번호가 비어 있습니다')

    const salt = randomBytes(SALT_BYTES)
    // 환경변수 게이트는 crypto.resolveDefaultKdfParams() 안에만 있다 — 여기서 process.env 를
    // 직접 읽으면 프로덕션에서도 메모리 비용을 낮출 수 있게 되므로 절대 하지 않는다
    const params: KdfParams = resolveDefaultKdfParams()
    const key = await deriveKey(master, salt, {
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism
    })
    const verifier = makeVerifier(key)

    this.repo.setMeta(META_SALT, salt)
    this.repo.setMeta(META_KDF_PARAMS, Buffer.from(JSON.stringify(params), 'utf8'))
    this.repo.setMeta(META_VERIFIER_CT, verifier.ciphertext)
    this.repo.setMeta(META_VERIFIER_IV, verifier.iv)

    this.applyKey(key)
  }

  async unlock(master: string): Promise<boolean> {
    if (!this.isInitialized()) throw new Error('금고가 아직 설정되지 않았습니다')
    const salt = this.repo.getMeta(META_SALT)
    const ct = this.repo.getMeta(META_VERIFIER_CT)
    const iv = this.repo.getMeta(META_VERIFIER_IV)
    if (!salt || !ct || !iv) throw new Error('금고 메타데이터가 손상되었습니다')

    const params = this.readKdfParams()
    const key = await deriveKey(master, salt, {
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism
    })
    if (!checkVerifier(key, { ciphertext: ct, iv })) {
      zeroize(key)
      return false
    }
    this.applyKey(key)
    return true
  }

  lock(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer)
      this.autoLockTimer = undefined
    }
    // 키 zeroize 는 DB 상태와 무관하게 항상 수행한다(메모리에 평문 키를 남기지 않는 것이 최우선)
    if (this.key) {
      zeroize(this.key)
      this.key = null
      this.emit()
    }
    // 종료 순서가 겹쳐 DB 가 먼저 닫힌 뒤 lock() 이 불릴 수 있다(예: before-quit 에서
    // vault.dispose() 후 db.close() 를 호출했는데 창 closed 이벤트가 뒤이어 dispose() 를
    // 한 번 더 부르는 경우). DB 작업은 실패해도 잠금 자체를 막으면 안 되므로 try/catch 로 감싼다
    try {
      this.pruneDeviceWrappedKeyIfDisabled()
    } catch (e: unknown) {
      console.error('기기 기억 키 정리 실패', e instanceof Error ? e.message : String(e))
    }
  }

  // 사용자 활동이 있을 때마다 자동 잠금 타이머를 되돌린다
  touch(): void {
    this.pruneDeviceWrappedKeyIfDisabled()
    if (!this.key) return
    this.restartAutoLock()
  }

  // vaultRememberDevice 가 꺼져 있는데 예전에 저장된 감싼 키가 남아 있으면 지운다.
  // lock()/touch() 양쪽에서 불러 옵션을 끈 시점 이후 첫 상태 확인에서 곧바로 반영되게 한다
  private pruneDeviceWrappedKeyIfDisabled(): void {
    if (this.db.isClosed) return
    if (this.settings.get().vaultRememberDevice) return
    if (this.repo.getMeta(META_DEVICE_KEY)) this.repo.deleteMeta(META_DEVICE_KEY)
  }

  // 인스턴스를 버릴 때 타이머·키를 정리한다(앱 종료·테스트). 두 번 호출돼도 안전하다
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = undefined
    }
    this.pending = null
    this.listeners.clear()
    this.captureListeners.clear()
    this.lock()
  }

  private readKdfParams(): KdfParams {
    const raw = this.repo.getMeta(META_KDF_PARAMS)
    const fallback: KdfParams = resolveDefaultKdfParams()
    if (!raw) return fallback
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null) return fallback
      const p = parsed as Partial<KdfParams>
      return {
        // DB 값이 변조돼 터무니없이 작아도 허용 범위 아래로는 내려가지 않는다
        memoryKiB:
          typeof p.memoryKiB === 'number' ? clampMemoryKiB(p.memoryKiB) : fallback.memoryKiB,
        iterations: typeof p.iterations === 'number' ? p.iterations : fallback.iterations,
        parallelism: typeof p.parallelism === 'number' ? p.parallelism : fallback.parallelism
      }
    } catch {
      return fallback
    }
  }

  // 키를 채택하고(기기 기억 옵션 반영) 자동 잠금 타이머를 건다
  private applyKey(key: Buffer): void {
    // 이미 채택된 키가 있으면(예: unlock 을 다시 호출) 새 키로 덮어쓰기 전에 메모리에서 지운다
    if (this.key) zeroize(this.key)
    this.key = key
    this.syncDeviceWrappedKey()
    this.restartAutoLock()
    this.emit()
  }

  private restartAutoLock(): void {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer)
    const minutes = this.settings.get().vaultAutoLockMinutes
    this.autoLockTimer = setTimeout(() => {
      this.autoLockTimer = undefined
      this.lock()
    }, minutes * MINUTE_MS)
    // 자동 잠금 타이머 때문에 프로세스가 살아 있지 않도록 한다
    this.autoLockTimer.unref?.()
  }

  // --- 기기 기억(safeStorage) --------------------------------------------

  private canUseSafeStorage(): boolean {
    if (!this.safeStorage) return false
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private syncDeviceWrappedKey(): void {
    const remember = this.settings.get().vaultRememberDevice
    if (!remember) {
      // 옵션을 껐으면 저장돼 있던 키도 지운다
      if (this.repo.getMeta(META_DEVICE_KEY)) this.repo.deleteMeta(META_DEVICE_KEY)
      return
    }
    if (!this.key || !this.safeStorage || !this.canUseSafeStorage()) return
    try {
      const wrapped = this.safeStorage.encryptString(this.key.toString('base64'))
      this.repo.setMeta(META_DEVICE_KEY, Buffer.from(wrapped))
    } catch {
      // 기기 기억 실패는 치명적이지 않다(다음 실행에서 마스터 입력을 받으면 된다)
    }
  }

  // 시작 시 감싼 키가 있으면 마스터 입력 없이 해제를 시도한다(실패하면 잠긴 채로 둔다)
  private tryDeviceUnlock(): void {
    this.unlockWithDeviceKey()
  }

  // 기기에 감싸 저장된 키로 잠금 해제를 1회 시도한다. 성공하면 true.
  // 생성자의 tryDeviceUnlock 과 ensureUnlockedByDevice() 가 공유하는 핵심 로직이다
  private unlockWithDeviceKey(): boolean {
    if (!this.isInitialized()) return false
    if (!this.settings.get().vaultRememberDevice) return false
    if (!this.canUseSafeStorage() || !this.safeStorage) return false
    const wrapped = this.repo.getMeta(META_DEVICE_KEY)
    if (!wrapped) return false
    const ct = this.repo.getMeta(META_VERIFIER_CT)
    const iv = this.repo.getMeta(META_VERIFIER_IV)
    if (!ct || !iv) return false
    try {
      const key = Buffer.from(this.safeStorage.decryptString(wrapped), 'base64')
      if (!checkVerifier(key, { ciphertext: ct, iv })) {
        zeroize(key)
        return false
      }
      this.key = key
      this.restartAutoLock()
      this.emit()
      return true
    } catch {
      // 복호화 실패(다른 기기·사용자) → 잠긴 상태 유지
      return false
    }
  }

  /**
   * 접근 정책이 'always' 일 때, 잠긴 상태에서 AI 도구/UI 진입 시 기기 키로 자동 해제를 시도한다.
   * 이미 해제돼 있으면 즉시 true. 기기 기억이 꺼져 있거나 기기 키가 없으면 false.
   */
  async ensureUnlockedByDevice(): Promise<boolean> {
    if (this.key) return true
    return this.unlockWithDeviceKey()
  }

  // --- 조회 -------------------------------------------------------------

  listSites(): SiteDto[] {
    return this.repo.listSites()
  }

  listAccounts(host?: string): AccountDto[] {
    const normalizedHost = host === undefined ? undefined : normalizeHost(host)
    const types = this.repo.itemTypesByAccount()
    return this.repo.listAccounts(normalizedHost).map((a) => ({
      id: a.id,
      siteId: a.siteId,
      host: a.host,
      label: a.label,
      username: a.username,
      isDefault: a.isDefault,
      itemTypes: types.get(a.id) ?? []
    }))
  }

  listItems(accountId: number | null): VaultItemMeta[] {
    return this.repo.listItems(accountId)
  }

  listAudit(accountId?: number, limit?: number): AuditRow[] {
    return this.repo.listAudit(accountId, limit)
  }

  // 특정 항목에 매이지 않는 감사 로그 한 줄을 남긴다(예: 가져오기 완료). 값은 절대 넣지 않는다
  logAudit(action: string, source: string): void {
    this.repo.insertAudit({ itemId: null, action, source })
  }

  // --- 쓰기 -------------------------------------------------------------

  upsertAccount(input: UpsertAccountInput): AccountDto {
    // 정규화 결과가 빈 문자열이면(예: 호스트만 있고 파싱이 안 되는 값) 원래 값을 그대로 둔다 —
    // 계정 자체를 잃어버리는 것보다 정규화 실패를 허용하는 편이 안전하다
    const normalized = normalizeHost(input.host)
    const host = normalized || input.host
    const row = this.repo.upsertAccount({ ...input, host })
    const types = this.repo.itemTypesByAccount()
    return {
      id: row.id,
      siteId: row.siteId,
      host: row.host,
      label: row.label,
      username: row.username,
      isDefault: row.isDefault,
      itemTypes: types.get(row.id) ?? []
    }
  }

  // 기존 항목이 있으면 덮어쓰고, 없으면 새로 만든다.
  // - input.id 를 주면 그 항목을 갱신한다(편집)
  // - 계정 항목은 (accountId, type) 이 키다(계정당 로그인 비밀번호 1개)
  // - 전역 항목은 (type, label) 이 키다 — 같은 종류라도 라벨이 다르면 별개 항목이다
  //   (예전에는 type 만으로 upsert 해서 '기타' 항목 두 개가 서로를 덮어썼다)
  // 새로 만들 때는 id 를 AAD 로 쓰기 위해 placeholder insert → 암호문 update 순서를 한 트랜잭션에서 수행한다
  putItem(input: PutItemInput): VaultItemMeta {
    const key = this.requireKey()
    const now = Date.now()

    const meta = this.repo.transaction(() => {
      const existing = this.findExistingItem(input)
      const id =
        existing?.id ??
        this.repo.insertItemPlaceholder(input.accountId, input.type, input.label, now)
      const blob = encrypt(key, input.value, String(id))
      this.repo.updateItemSecret(id, blob.ciphertext, blob.iv, input.label, input.type, now)
      this.repo.insertAudit({ itemId: id, action: 'save', source: 'user' })
      return this.repo.itemMeta(id)
    })
    if (!meta) throw new Error('항목을 저장하지 못했습니다')
    this.touch()
    return meta
  }

  // putItem 이 덮어쓸 기존 항목을 찾는다(없으면 null → 새 항목을 만든다)
  private findExistingItem(input: PutItemInput): { id: number } | null {
    if (input.id !== undefined) {
      const row = this.repo.getItemRow(input.id)
      if (!row) throw new Error('항목을 찾을 수 없습니다')
      return row
    }
    if (input.accountId === null) return this.repo.findGlobalItemRow(input.type, input.label)
    return this.repo.findItemRow(input.accountId, input.type)
  }

  deleteItem(id: number): void {
    this.requireKey()
    this.repo.deleteItem(id)
    this.repo.insertAudit({ itemId: id, action: 'delete', source: 'user' })
    this.touch()
  }

  // 사용자가 "보기" 를 눌렀을 때만 호출된다. 평문을 돌려주는 유일한 사용자 경로
  reveal(id: number): string {
    const key = this.requireKey()
    const row = this.repo.getItemRow(id)
    if (!row) throw new Error('항목을 찾을 수 없습니다')
    const plain = decrypt(key, row.ciphertext, row.iv, String(row.id))
    this.repo.insertAudit({ itemId: id, action: 'reveal', source: 'user' })
    this.touch()
    return plain
  }

  /**
   * 자동 채움용 평문 조회 — **메인 프로세스 내부에서만** 호출한다.
   * IPC 로 노출하지 않으며, 반환값은 격리 월드 인자로만 전달된다.
   */
  getSecretForFill(accountId: number, type: VaultItemType, jobId?: string): string | null {
    if (!this.key) return null
    const row = this.repo.findItemRow(accountId, type)
    if (!row) return null
    try {
      const plain = decrypt(this.key, row.ciphertext, row.iv, String(row.id))
      this.repo.insertAudit({ itemId: row.id, action: 'fill', source: 'ai', jobId })
      this.touch()
      return plain
    } catch {
      return null
    }
  }

  /**
   * capture 로 감지된 (host, username, password) 가 이미 저장된 로그인 비밀번호와 같은지 확인한다.
   * 같으면 저장 제안을 다시 띄우지 않기 위해 쓴다. 잠겨 있거나 계정이 없으면 false.
   */
  hasSameSecret(host: string, username: string, password: string): boolean {
    if (!this.key) return false
    const normalized = normalizeHost(host) || host
    const account = this.repo.listAccounts(normalized).find((a) => a.username === username)
    if (!account) return false
    const row = this.repo.findItemRow(account.id, 'login_password')
    if (!row) return false
    try {
      const stored = decrypt(this.key, row.ciphertext, row.iv, String(row.id))
      // 타이밍 오라클 방지: 길이가 다르면 즉시 false, 같으면 상수 시간 비교
      const a = Buffer.from(stored, 'utf8')
      const b = Buffer.from(password, 'utf8')
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('금고가 잠겨 있습니다')
    return this.key
  }

  // --- 저장 제안(capture) -------------------------------------------------

  // 저장 제안 카드를 띄울 구독자(=IPC 핸들러)를 등록한다. 비밀번호는 전달되지 않는다
  onCapturePrompt(cb: (prompt: CapturePromptDto) => void): () => void {
    this.captureListeners.add(cb)
    return () => {
      this.captureListeners.delete(cb)
    }
  }

  setPendingCapture(capture: PendingCapture): void {
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.pending = { ...capture, expiresAt: Date.now() + CAPTURE_TTL_MS }
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined
      this.pending = null
    }, CAPTURE_TTL_MS)
    this.captureTimer.unref?.()
    const prompt = this.pendingCapturePrompt()
    if (prompt) for (const cb of this.captureListeners) cb(prompt)
  }

  // 렌더러에 보여줄 정보(비밀번호 제외)
  pendingCapturePrompt(): CapturePromptDto | null {
    if (!this.pending || Date.now() > this.pending.expiresAt) return null
    return {
      host: this.pending.host,
      username: this.pending.username,
      isNew: this.pending.isNew
    }
  }

  // 한 번 가져가면 즉시 비운다(메모리에 남기지 않는다)
  takePendingCapture(): PendingCapture | null {
    const pending = this.pending
    this.pending = null
    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = undefined
    }
    if (!pending) return null
    if (Date.now() > pending.expiresAt) return null
    const { host, username, password, isNew } = pending
    return { host, username, password, isNew }
  }
}
