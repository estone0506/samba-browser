// 내 API 키 보관소. 키는 electron safeStorage 로 암호화해 파일 하나(ai-keys.bin)에만 둔다.
//
// 안전 규칙(2b 단계 Global Constraints):
//  - 평문 키는 이 모듈과 `agent/provider.ts` 밖으로 나가지 않는다.
//    **`ApiKeyStore.get` 을 호출하는 곳은 `src/main/agent/provider.ts` 하나뿐이다.**
//  - 렌더러로는 `masked()` 결과(`sk-ant-••••1234`)와 boolean 만 보낸다.
//  - 동기화(Supabase) 대상이 아니다. 로그에도 남기지 않는다.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { API_KEY_VENDORS, type ApiKeyVendor } from '../../shared/ai'
import { tr } from '../i18n'

// electron safeStorage 중 실제로 쓰는 부분만 좁혀 둔 인터페이스(테스트에서 스텁 주입)
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

// 마스킹에서 끝자리를 노출할 최소 길이. 이보다 짧으면 전부 가린다
const MIN_MASKABLE_LENGTH = 8
const DOTS = '••••'

/** 'sk-ant-api03-abcdefgh1234' → 'sk-ant-••••1234'. 원문 일부(끝 4자)와 벤더 접두사만 남는다 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length < MIN_MASKABLE_LENGTH) return DOTS
  const tail = trimmed.slice(-4)
  // 'sk-ant-...' · 'sk-proj-...' 처럼 앞 두 마디가 벤더 표식인 형태만 남긴다
  const prefix = /^([A-Za-z]+-[A-Za-z0-9]+)-/.exec(trimmed)?.[1] ?? ''
  return prefix ? `${prefix}-${DOTS}${tail}` : `${DOTS}${tail}`
}

type KeyRecord = Partial<Record<ApiKeyVendor, string>>

export class ApiKeyStore {
  private keys: KeyRecord = {}

  constructor(
    private readonly filePath: string,
    private readonly safeStorage?: SafeStorageLike
  ) {
    this.keys = this.load()
  }

  /** safeStorage 를 쓸 수 있는가. 못 쓰면 키를 아예 보관하지 않는다 */
  isAvailable(): boolean {
    if (!this.safeStorage) return false
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private load(): KeyRecord {
    if (!this.isAvailable() || !existsSync(this.filePath)) return {}
    try {
      const plain = this.safeStorage!.decryptString(readFileSync(this.filePath))
      const raw: unknown = JSON.parse(plain)
      if (!raw || typeof raw !== 'object') return {}
      const out: KeyRecord = {}
      for (const vendor of API_KEY_VENDORS) {
        const value = (raw as Record<string, unknown>)[vendor]
        if (typeof value === 'string' && value.trim()) out[vendor] = value
      }
      return out
    } catch (e) {
      // 값은 절대 로그에 넣지 않는다 — 실패 사실만 남긴다
      console.error('API 키 읽기 실패, 빈 상태로 시작', e instanceof Error ? e.message : String(e))
      return {}
    }
  }

  private save(): void {
    try {
      if (Object.keys(this.keys).length === 0) {
        if (existsSync(this.filePath)) rmSync(this.filePath, { force: true })
        return
      }
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, this.safeStorage!.encryptString(JSON.stringify(this.keys)))
    } catch (e) {
      throw new Error(
        tr('aiKeys.saveFailed', { reason: e instanceof Error ? e.message : String(e) })
      )
    }
  }

  /** 키를 저장한다. 빈 문자열이면 삭제와 같다. safeStorage 불가 환경에서는 저장하지 않고 예외를 던진다 */
  set(vendor: ApiKeyVendor, key: string): void {
    if (!this.isAvailable()) {
      throw new Error(tr('aiKeys.safeStorageUnavailable'))
    }
    const value = key.trim()
    if (!value) {
      this.remove(vendor)
      return
    }
    this.keys = { ...this.keys, [vendor]: value }
    this.save()
  }

  /** 평문 키. 메인 내부 전용이며 렌더러로 나가는 경로가 존재하지 않는다 */
  get(vendor: ApiKeyVendor): string | null {
    if (!this.isAvailable()) return null
    return this.keys[vendor] ?? null
  }

  remove(vendor: ApiKeyVendor): void {
    if (!(vendor in this.keys)) return
    const next = { ...this.keys }
    delete next[vendor]
    this.keys = next
    this.save()
  }

  /** 렌더러에 보낼 수 있는 유일한 형태 */
  masked(): Partial<Record<ApiKeyVendor, string>> {
    const out: Partial<Record<ApiKeyVendor, string>> = {}
    for (const vendor of API_KEY_VENDORS) {
      const key = this.keys[vendor]
      if (key) out[vendor] = maskApiKey(key)
    }
    return out
  }

  /** 저장된 키가 하나라도 있는가(제공자 카드 상태 판정용) */
  hasAny(): boolean {
    return Object.keys(this.masked()).length > 0
  }
}
