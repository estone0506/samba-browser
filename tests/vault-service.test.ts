// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService, type SafeStorageLike } from '../src/main/vault/service'
import { VaultRepo } from '../src/main/vault/repo'
import {
  deriveKey,
  makeVerifier,
  randomBytes,
  resolveDefaultKdfParams
} from '../src/main/vault/crypto'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

const SECRET = 'sup3rs3cret!'

// SettingsStore 는 electron app 에 의존하므로 테스트에서는 최소 인터페이스만 흉내낸다
function makeSettings(patch: Partial<Settings> = {}): { get: () => Settings } {
  const value: Settings = { ...DEFAULT_SETTINGS, ...patch }
  return { get: () => value }
}

// 테스트 중간에 옵션을 바꿔야 하는 케이스(기기 기억 해제 등)를 위한 변경 가능한 스텁
function makeMutableSettings(patch: Partial<Settings> = {}): {
  get: () => Settings
  set: (patch: Partial<Settings>) => void
} {
  let value: Settings = { ...DEFAULT_SETTINGS, ...patch }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
    }
  }
}

// safeStorage 스텁 — 실제 DPAPI 대신 접두사만 붙여 왕복을 흉내낸다
function makeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`wrapped:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('wrapped:')) throw new Error('복호화 실패')
      return s.slice('wrapped:'.length)
    }
  }
}

describe('VaultService', () => {
  let db: Db
  let vault: VaultService

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, makeSettings())
  })

  afterEach(() => {
    vault.dispose()
    db.close()
    vi.useRealTimers()
  })

  it('db.close() 이후 dispose() 를 호출해도 throw 하지 않는다(종료 순서 버그 회귀 테스트)', async () => {
    await vault.setup('master-pw')
    // 실제 버그 재현 순서: db 가 먼저 닫히고, 그 다음 vault.dispose() → lock() →
    // pruneDeviceWrappedKeyIfDisabled() 가 닫힌 DB 를 조회하려 했었다
    db.close()
    expect(() => vault.dispose()).not.toThrow()
    // dispose() 는 DB 접근과 무관하게 항상 키를 zeroize 해야 한다
    expect(vault.state()).toBe('uninitialized')
  })

  it('처음에는 uninitialized, setup 하면 unlocked', async () => {
    expect(vault.state()).toBe('uninitialized')
    await vault.setup('master-pw')
    expect(vault.state()).toBe('unlocked')
  })

  it('lock 하면 locked, 올바른 마스터로 다시 unlock 된다', async () => {
    await vault.setup('master-pw')
    vault.lock()
    expect(vault.state()).toBe('locked')
    await expect(vault.unlock('master-pw')).resolves.toBe(true)
    expect(vault.state()).toBe('unlocked')
  })

  it('잘못된 마스터 비밀번호는 false 를 반환하고 잠긴 상태를 유지한다', async () => {
    await vault.setup('master-pw')
    vault.lock()
    await expect(vault.unlock('wrong-pw')).resolves.toBe(false)
    expect(vault.state()).toBe('locked')
  })

  it('putItem 후 listItems 결과에 값·ciphertext 가 없다', async () => {
    await vault.setup('master-pw')
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: true
    })
    const meta = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: SECRET
    })

    const items = vault.listItems(account.id)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(meta.id)
    expect(items[0].type).toBe('login')
    // 메타에는 값 관련 필드 자체가 없어야 한다(sections 는 secret 필드의 key/label/kind 만 담는다)
    expect(Object.keys(items[0]).sort()).toEqual(
      ['accountId', 'id', 'label', 'sections', 'type', 'updatedAt'].sort()
    )
    const secretFields = items[0].sections.flatMap((s) =>
      s.fields.filter((f) => f.kind === 'secret')
    )
    expect(secretFields).toHaveLength(1)
    expect(secretFields[0].value).toBeUndefined()
  })

  it('공개 목록·메타 어디에도 비밀값 문자열이 직렬화되지 않는다', async () => {
    await vault.setup('master-pw')
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: true
    })
    vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: SECRET
    })

    const serialized = JSON.stringify({
      state: vault.state(),
      sites: vault.listSites(),
      accounts: vault.listAccounts('example.com'),
      allAccounts: vault.listAccounts(),
      items: vault.listItems(account.id),
      globalItems: vault.listItems(null)
    })
    expect(serialized).not.toMatch(/sup3rs3cret/)
    expect(serialized).not.toMatch(/ciphertext/i)
    expect(serialized).not.toMatch(/\biv\b/)
  })

  it('reveal 은 잠금 상태에서 throw 하고, 해제 상태에서 원문을 돌려준다', async () => {
    await vault.setup('master-pw')
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: false
    })
    const meta = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: SECRET
    })

    expect(vault.reveal(meta.id)).toBe(SECRET)

    vault.lock()
    expect(() => vault.reveal(meta.id)).toThrow()
  })

  it('getSecretForFill 왕복 — 계정/타입으로 평문을 얻는다', async () => {
    await vault.setup('master-pw')
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: true
    })
    vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: SECRET
    })

    expect(vault.getSecretForFill(account.id, 'login', 'value', 'job-1')).toBe(SECRET)
    expect(vault.getSecretForFill(account.id, 'card')).toBeNull()

    vault.lock()
    expect(vault.getSecretForFill(account.id, 'login')).toBeNull()
  })

  it('reveal/fill 은 감사 로그를 남긴다', async () => {
    await vault.setup('master-pw')
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: true
    })
    const meta = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: SECRET
    })

    vault.reveal(meta.id)
    vault.getSecretForFill(account.id, 'login', 'value', 'job-9')

    const log = vault.listAudit()
    const reveal = log.find((r) => r.action === 'reveal')
    const fill = log.find((r) => r.action === 'fill')
    expect(reveal).toBeDefined()
    expect(reveal?.source).toBe('user')
    expect(reveal?.itemId).toBe(meta.id)
    expect(fill).toBeDefined()
    expect(fill?.source).toBe('ai')
    expect(fill?.jobId).toBe('job-9')
    // 감사 로그에도 값은 들어가지 않는다
    expect(JSON.stringify(log)).not.toMatch(/sup3rs3cret/)
  })

  it('deleteItem 후 목록에서 사라진다', async () => {
    await vault.setup('master-pw')
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: true
    })
    const meta = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: SECRET
    })
    vault.deleteItem(meta.id)
    expect(vault.listItems(account.id)).toHaveLength(0)
  })

  it('listAccounts 는 보유한 항목 타입을 함께 준다', async () => {
    await vault.setup('master-pw')
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: true
    })
    vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인 비밀번호',
      value: SECRET
    })
    vault.putItem({
      accountId: account.id,
      type: 'card',
      label: '카드',
      value: '4111-1111-1111-1111'
    })

    const accounts = vault.listAccounts('example.com')
    expect(accounts).toHaveLength(1)
    expect(accounts[0].itemTypes.sort()).toEqual(['card', 'login'])
    expect(vault.listSites().map((s) => s.host)).toEqual(['example.com'])
  })

  it('미사용 시간이 설정값(분)을 넘으면 자동으로 잠긴다', async () => {
    vi.useFakeTimers()
    // 기본값(1주)이 아니라 설정 가능한 값 자체를 검증하기 위해 15분으로 명시한다
    const v = new VaultService(db, makeSettings({ vaultAutoLockMinutes: 15 }))
    await v.setup('master-pw')
    expect(v.state()).toBe('unlocked')

    // 설정한 15분 - 1ms 까지는 열려 있다
    vi.advanceTimersByTime(15 * 60 * 1000 - 1)
    expect(v.state()).toBe('unlocked')

    vi.advanceTimersByTime(1)
    expect(v.state()).toBe('locked')
    v.dispose()
  })

  it('touch() 는 자동 잠금 타이머를 되돌린다', async () => {
    vi.useFakeTimers()
    const v = new VaultService(db, makeSettings({ vaultAutoLockMinutes: 15 }))
    await v.setup('master-pw')

    vi.advanceTimersByTime(14 * 60 * 1000)
    v.touch()
    vi.advanceTimersByTime(14 * 60 * 1000)
    expect(v.state()).toBe('unlocked')

    vi.advanceTimersByTime(60 * 1000)
    expect(v.state()).toBe('locked')
    v.dispose()
  })

  it('onStateChanged 구독자가 상태 변화를 받는다', async () => {
    const seen: string[] = []
    const off = vault.onStateChanged((s) => seen.push(s))
    await vault.setup('master-pw')
    vault.lock()
    off()
    await vault.unlock('master-pw')
    expect(seen).toEqual(['unlocked', 'locked'])
  })

  it('보류 중 캡처는 60초 뒤 폐기되고, take 하면 즉시 비워진다', async () => {
    vi.useFakeTimers()
    vault.setPendingCapture({
      host: 'example.com',
      username: 'alice',
      password: SECRET,
      isNew: true
    })
    const taken = vault.takePendingCapture()
    expect(taken?.password).toBe(SECRET)
    // 한 번 가져가면 사라진다
    expect(vault.takePendingCapture()).toBeNull()

    vault.setPendingCapture({
      host: 'example.com',
      username: 'alice',
      password: SECRET,
      isNew: false
    })
    vi.advanceTimersByTime(60 * 1000 + 1)
    expect(vault.takePendingCapture()).toBeNull()
  })

  it('capture 프롬프트 DTO 에는 비밀번호가 없다', () => {
    vault.setPendingCapture({
      host: 'example.com',
      username: 'alice',
      password: SECRET,
      isNew: true
    })
    const prompt = vault.pendingCapturePrompt()
    expect(prompt).toEqual({ host: 'example.com', username: 'alice', isNew: true })
    expect(JSON.stringify(prompt)).not.toMatch(/sup3rs3cret/)
  })

  describe('기기 기억(vaultRememberDevice)', () => {
    it('켜져 있으면 다음 인스턴스가 마스터 없이 자동 해제된다', async () => {
      const settings = makeSettings({ vaultRememberDevice: true })
      const safeStorage = makeSafeStorage()
      const first = new VaultService(db, settings, { safeStorage })
      await first.setup('master-pw')
      first.dispose()

      const second = new VaultService(db, settings, { safeStorage })
      expect(second.state()).toBe('unlocked')
      second.dispose()
    })

    it('safeStorage 를 쓸 수 없으면 잠긴 상태를 유지한다', async () => {
      const settings = makeSettings({ vaultRememberDevice: true })
      const first = new VaultService(db, settings, { safeStorage: makeSafeStorage() })
      await first.setup('master-pw')
      first.dispose()

      const second = new VaultService(db, settings, { safeStorage: makeSafeStorage(false) })
      expect(second.state()).toBe('locked')
      second.dispose()
    })

    it('꺼져 있으면 감싼 키를 저장하지 않아 자동 해제되지 않는다', async () => {
      const settings = makeSettings({ vaultRememberDevice: false })
      const safeStorage = makeSafeStorage()
      const first = new VaultService(db, settings, { safeStorage })
      await first.setup('master-pw')
      first.dispose()

      const second = new VaultService(db, settings, { safeStorage })
      expect(second.state()).toBe('locked')
      second.dispose()
    })

    it('옵션을 켠 채로 해제해 뒀다가 옵션을 끄고 touch() 하면 저장된 감싼 키가 삭제된다', async () => {
      const settings = makeMutableSettings({ vaultRememberDevice: true })
      const safeStorage = makeSafeStorage()
      const repo = new VaultRepo(db)
      const service = new VaultService(db, settings, { safeStorage })
      await service.setup('master-pw')
      // 감싼 키가 저장되어 있어야 한다
      expect(repo.getMeta('device_wrapped_key')).not.toBeNull()

      settings.set({ vaultRememberDevice: false })
      service.touch()
      expect(repo.getMeta('device_wrapped_key')).toBeNull()
      service.dispose()
    })

    it('옵션을 켠 채로 해제해 뒀다가 옵션을 끄고 lock() 하면 저장된 감싼 키가 삭제된다', async () => {
      const settings = makeMutableSettings({ vaultRememberDevice: true })
      const safeStorage = makeSafeStorage()
      const repo = new VaultRepo(db)
      const service = new VaultService(db, settings, { safeStorage })
      await service.setup('master-pw')
      expect(repo.getMeta('device_wrapped_key')).not.toBeNull()

      settings.set({ vaultRememberDevice: false })
      service.lock()
      expect(repo.getMeta('device_wrapped_key')).toBeNull()
      service.dispose()
    })

    it('ensureUnlockedByDevice: 잠긴 상태에서 기기 키로 잠금 해제를 시도한다(접근 정책 always 용)', async () => {
      const settings = makeSettings({ vaultRememberDevice: true })
      const safeStorage = makeSafeStorage()
      const first = new VaultService(db, settings, { safeStorage })
      await first.setup('master-pw')
      first.dispose()

      // 새 인스턴스는 생성자에서 이미 자동 해제됐을 수 있으니, lock() 으로 다시 잠근 뒤 확인한다
      const second = new VaultService(db, settings, { safeStorage })
      second.lock()
      expect(second.state()).toBe('locked')

      const ok = await second.ensureUnlockedByDevice()
      expect(ok).toBe(true)
      expect(second.state()).toBe('unlocked')
      second.dispose()
    })
  })

  describe('호스트 정규화', () => {
    it('www.·대문자·포트가 섞인 호스트로 저장해도 정규화된 호스트로 조회된다', async () => {
      await vault.setup('master-pw')
      vault.upsertAccount({
        host: 'www.Naver.com:443',
        label: '네이버',
        username: 'alice',
        isDefault: true
      })

      const accounts = vault.listAccounts('naver.com')
      expect(accounts).toHaveLength(1)
      expect(accounts[0].host).toBe('naver.com')
    })
  })

  describe('저장된 KDF 파라미터로 unlock', () => {
    it('기본값과 다른 iterations/parallelism 로 만들어진 금고도 저장된 값으로 unlock 된다', async () => {
      // setup() 을 거치지 않고 커스텀 파라미터로 직접 금고를 초기화한다(예전에 다른 파라미터로 만들어진 상황을 흉내)
      const repo = new VaultRepo(db)
      const salt = randomBytes(16)
      const customParams = { memoryKiB: 8192, iterations: 2, parallelism: 1 }
      const key = await deriveKey('old-master', salt, customParams)
      const verifier = makeVerifier(key)
      repo.setMeta('salt', salt)
      repo.setMeta('kdf_params', Buffer.from(JSON.stringify(customParams), 'utf8'))
      repo.setMeta('verifier_ct', verifier.ciphertext)
      repo.setMeta('verifier_iv', verifier.iv)

      // 새 인스턴스로 다시 읽어야 tryDeviceUnlock 등 생성자 로직이 새 데이터를 본다
      const reopened = new VaultService(db, makeSettings())
      expect(reopened.state()).toBe('locked')
      await expect(reopened.unlock('old-master')).resolves.toBe(true)
      expect(reopened.state()).toBe('unlocked')
      reopened.dispose()
    })
  })

  describe('같은 (accountId,type) putItem 재저장', () => {
    it('두 번째 putItem 이후 reveal 은 새 값을, item id 는 그대로 돌려준다', async () => {
      await vault.setup('master-pw')
      const account = vault.upsertAccount({
        host: 'example.com',
        label: '메인',
        username: 'alice',
        isDefault: true
      })
      const first = vault.putItem({
        accountId: account.id,
        type: 'login',
        label: '로그인 비밀번호',
        value: 'old-secret'
      })
      const second = vault.putItem({
        accountId: account.id,
        type: 'login',
        label: '로그인 비밀번호',
        value: 'new-secret'
      })

      expect(second.id).toBe(first.id)
      expect(vault.reveal(second.id)).toBe('new-secret')
      expect(vault.listItems(account.id)).toHaveLength(1)
    })
  })

  describe('putItem 감사 로그', () => {
    it("putItem 은 action='save', source='user' 감사 로그를 남긴다", async () => {
      await vault.setup('master-pw')
      const account = vault.upsertAccount({
        host: 'example.com',
        label: '메인',
        username: 'alice',
        isDefault: true
      })
      const meta = vault.putItem({
        accountId: account.id,
        type: 'login',
        label: '로그인 비밀번호',
        value: SECRET
      })

      const log = vault.listAudit()
      const save = log.find((r) => r.action === 'save')
      expect(save).toBeDefined()
      expect(save?.source).toBe('user')
      expect(save?.itemId).toBe(meta.id)
      expect(JSON.stringify(log)).not.toMatch(/sup3rs3cret/)
    })
  })
  describe('KDF 파라미터', () => {
    it('setup 은 resolveDefaultKdfParams() 결과를 그대로 저장한다', async () => {
      await vault.setup('master-pw')
      const raw = new VaultRepo(db).getMeta('kdf_params')
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw!.toString('utf8'))).toEqual(resolveDefaultKdfParams())
    })

    it('VITEST 게이트 밖(프로덕션 경로)에서는 VAULT_KDF_MEM 을 무시하고 65536 으로 저장한다', async () => {
      // 게이트가 뚫려 있으면 저장된 memoryKiB 가 8192 가 된다(리뷰 지적 회귀 테스트)
      const originalVitest = process.env.VITEST
      delete process.env.VITEST
      try {
        await vault.setup('master-pw')
      } finally {
        if (originalVitest === undefined) delete process.env.VITEST
        else process.env.VITEST = originalVitest
      }
      const raw = new VaultRepo(db).getMeta('kdf_params')
      expect(JSON.parse(raw!.toString('utf8'))).toEqual({
        memoryKiB: 65536,
        iterations: 3,
        parallelism: 1
      })
    })
  })
  describe('계정 upsert 보존 규칙', () => {
    it('label/isDefault 를 생략하면 기존 계정 값을 유지한다(자동 저장 회귀 테스트)', async () => {
      await vault.setup('master-pw')
      const created = vault.upsertAccount({
        host: 'shop.example',
        label: '내 쇼핑 계정',
        username: 'alice',
        isDefault: true
      })

      // capture 수락 경로와 동일하게 label/isDefault 없이 저장한다
      const again = vault.upsertAccount({
        id: created.id,
        host: 'shop.example',
        username: 'alice'
      })

      expect(again.id).toBe(created.id)
      expect(again.label).toBe('내 쇼핑 계정')
      expect(again.isDefault).toBe(true)
    })

    it('신규 계정에서 label 을 생략하면 username 을 라벨로 쓴다', async () => {
      await vault.setup('master-pw')
      const created = vault.upsertAccount({ host: 'shop.example', username: 'alice' })
      expect(created.label).toBe('alice')
      expect(created.isDefault).toBe(false)
    })

    it('label 을 명시하면 기존 계정도 갱신된다', async () => {
      await vault.setup('master-pw')
      const created = vault.upsertAccount({
        host: 'shop.example',
        label: '예전 라벨',
        username: 'alice'
      })
      const renamed = vault.upsertAccount({
        id: created.id,
        host: 'shop.example',
        label: '새 라벨',
        username: 'alice'
      })
      expect(renamed.label).toBe('새 라벨')
    })
  })

  describe('전역 항목 키', () => {
    it("라벨이 다른 전역 'note' 항목 두 개가 서로를 덮어쓰지 않는다", async () => {
      await vault.setup('master-pw')
      const first = vault.putItem({
        accountId: null,
        type: 'note',
        label: '와이파이 비번',
        value: 'wifi-1234'
      })
      const second = vault.putItem({
        accountId: null,
        type: 'note',
        label: '금고 번호',
        value: 'safe-5678'
      })

      expect(second.id).not.toBe(first.id)
      expect(vault.listItems(null)).toHaveLength(2)
      expect(vault.reveal(first.id)).toBe('wifi-1234')
      expect(vault.reveal(second.id)).toBe('safe-5678')
    })

    it('같은 (종류, 라벨)이면 기존 전역 항목을 덮어쓴다', async () => {
      await vault.setup('master-pw')
      const first = vault.putItem({
        accountId: null,
        type: 'note',
        label: '와이파이 비번',
        value: 'wifi-1234'
      })
      const updated = vault.putItem({
        accountId: null,
        type: 'note',
        label: '와이파이 비번',
        value: 'wifi-9999'
      })
      expect(updated.id).toBe(first.id)
      expect(vault.listItems(null)).toHaveLength(1)
      expect(vault.reveal(first.id)).toBe('wifi-9999')
    })

    it('id 를 주면 라벨을 바꿔도 같은 항목을 갱신한다', async () => {
      await vault.setup('master-pw')
      const created = vault.putItem({
        accountId: null,
        type: 'note',
        label: '와이파이 비번',
        value: 'wifi-1234'
      })
      const renamed = vault.putItem({
        id: created.id,
        accountId: null,
        type: 'note',
        label: '집 와이파이',
        value: 'wifi-1234'
      })
      expect(renamed.id).toBe(created.id)
      expect(renamed.label).toBe('집 와이파이')
      expect(vault.listItems(null)).toHaveLength(1)
    })
  })
  describe('삭제 감사 로그', () => {
    it('항목을 지워도 계정별 사용 기록에 삭제 기록이 남는다', async () => {
      await vault.setup('master-pw')
      const account = vault.upsertAccount({
        host: 'example.com',
        label: '메인',
        username: 'alice'
      })
      const meta = vault.putItem({
        accountId: account.id,
        type: 'login',
        label: '로그인 비밀번호',
        value: SECRET
      })

      vault.deleteItem(meta.id)

      // 예전에는 vault_items 조인 때문에 삭제 기록이 통째로 사라졌다
      const logs = vault.listAudit(account.id)
      const del = logs.find((r) => r.action === 'delete')
      expect(del).toBeDefined()
      expect(del?.itemId).toBe(meta.id)
      expect(del?.accountId).toBe(account.id)
      // 저장 기록도 그대로 보인다
      expect(logs.some((r) => r.action === 'save')).toBe(true)
      expect(JSON.stringify(logs)).not.toMatch(/sup3rs3cret/)
    })

    it('다른 계정의 기록은 섞이지 않는다', async () => {
      await vault.setup('master-pw')
      const a = vault.upsertAccount({ host: 'a.example', label: 'A', username: 'alice' })
      const b = vault.upsertAccount({ host: 'b.example', label: 'B', username: 'bob' })
      const itemA = vault.putItem({
        accountId: a.id,
        type: 'login',
        label: '로그인 비밀번호',
        value: SECRET
      })
      vault.putItem({
        accountId: b.id,
        type: 'login',
        label: '로그인 비밀번호',
        value: SECRET
      })
      vault.deleteItem(itemA.id)

      const logsB = vault.listAudit(b.id)
      expect(logsB.every((r) => r.action !== 'delete')).toBe(true)
    })
  })
  // --- v2 필드 구조 ---------------------------------------------------------

  describe('섹션>필드 구조(v2)', () => {
    it('secret 필드만 암호화되고 평문 필드는 메타에 그대로 내려간다', async () => {
      await vault.setup('master-pw')
      const meta = vault.putItem({
        accountId: null,
        type: 'card',
        label: '신한카드',
        sections: [
          {
            key: 'card',
            label: '카드 정보',
            fields: [
              { key: 'card.holder', label: '소유자', kind: 'text', value: '홍길동' },
              { key: 'card.number', label: '번호', kind: 'secret', value: '4111111111111111' },
              { key: 'card.cvc', label: 'CVC', kind: 'secret', value: '123' }
            ]
          }
        ]
      })

      const fields = meta.sections[0].fields
      expect(fields.map((f) => f.kind)).toEqual(['text', 'secret', 'secret'])
      // 평문 필드는 값이 그대로, secret 필드는 값이 아예 없다
      expect(fields[0].value).toBe('홍길동')
      expect(fields[1].value).toBeUndefined()
      expect(fields[2].value).toBeUndefined()
      // 직렬화 결과 어디에도 비밀값이 없어야 한다
      expect(JSON.stringify(vault.listItems(null))).not.toContain('4111111111111111')
    })

    it('필드별로 reveal·getSecretForFill 왕복이 된다', async () => {
      await vault.setup('master-pw')
      const account = vault.upsertAccount({ host: 'pay.example', label: '결제', username: 'me' })
      const meta = vault.putItem({
        accountId: account.id,
        type: 'card',
        label: '신한카드',
        sections: [
          {
            key: 'card',
            label: '카드 정보',
            fields: [
              { key: 'card.number', label: '번호', kind: 'secret', value: '4111111111111111' },
              { key: 'card.cvc', label: 'CVC', kind: 'secret', value: '123' }
            ]
          }
        ]
      })

      expect(vault.reveal(meta.id, 'card.number')).toBe('4111111111111111')
      expect(vault.reveal(meta.id, 'card.cvc')).toBe('123')
      expect(vault.getSecretForFill(account.id, 'card', 'card.number')).toBe('4111111111111111')
      // 없는 필드는 null(도구가 not found 로 답한다)
      expect(vault.getSecretForFill(account.id, 'card', 'card.expiry')).toBeNull()
    })

    it('값을 생략한 secret 필드는 기존 암호문을 유지한다', async () => {
      await vault.setup('master-pw')
      const first = vault.putItem({
        accountId: null,
        type: 'card',
        label: '카드',
        sections: [
          {
            key: 'card',
            label: '카드 정보',
            fields: [{ key: 'card.number', label: '번호', kind: 'secret', value: '4111' }]
          }
        ]
      })
      vault.putItem({
        id: first.id,
        accountId: null,
        type: 'card',
        label: '카드(수정)',
        sections: [
          {
            key: 'card',
            label: '카드 정보',
            fields: [{ key: 'card.number', label: '번호', kind: 'secret' }]
          }
        ]
      })
      expect(vault.reveal(first.id, 'card.number')).toBe('4111')
    })

    it('upsertAccount 가 urls/tags/agentAccess 를 patch 한다', async () => {
      await vault.setup('master-pw')
      const created = vault.upsertAccount({
        host: 'example.com',
        label: '메인',
        username: 'me',
        urls: ['https://example.com/login'],
        tags: ['쇼핑'],
        agentAccess: 'never'
      })
      expect(created.urls).toEqual(['https://example.com/login'])
      expect(created.tags).toEqual(['쇼핑'])
      expect(created.agentAccess).toBe('never')

      // 생략한 항목은 기존 값을 유지한다(자동 저장이 사용자 설정을 지우지 않게)
      const patched = vault.upsertAccount({ id: created.id, host: 'example.com', username: 'me' })
      expect(patched.urls).toEqual(['https://example.com/login'])
      expect(patched.tags).toEqual(['쇼핑'])
      expect(patched.agentAccess).toBe('never')
    })

    it('listPickerAccounts 는 id/label/username 만 돌려준다', async () => {
      await vault.setup('master-pw')
      vault.upsertAccount({ host: 'shop.example', label: '메인', username: 'me' })
      const picker = vault.listPickerAccounts('https://shop.example/login')
      expect(picker).toHaveLength(1)
      expect(Object.keys(picker[0]).sort()).toEqual(['id', 'label', 'username'])
    })
  })
})
