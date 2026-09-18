// supabase-js 세션 저장소 검증. refresh token 이 평문으로 디스크에 남지 않아야 한다
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionStore, type SafeStorageLike } from '../src/main/sync/session-store'

// safeStorage 스텁 — 실제 DPAPI 대신 base64 로 가려 왕복을 흉내낸다.
// 원문이 파일에 그대로 남지 않는지 단언해야 하므로 접두사만 붙이는 방식은 쓰지 않는다
function makeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) =>
      Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('복호화 실패')
      return Buffer.from(s.slice('enc:'.length), 'base64').toString('utf8')
    }
  }
}

const TOKEN = 'refresh-token-abcdef-0123456789'

describe('createSessionStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'samba-session-'))
    // 하위 디렉터리까지 만들어지는지도 함께 확인한다
    file = join(dir, 'nested', 'session.bin')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('set 한 값을 get 으로 되읽는다', () => {
    const store = createSessionStore(file, makeSafeStorage())
    store.setItem('sb-auth-token', TOKEN)
    expect(store.getItem('sb-auth-token')).toBe(TOKEN)
  })

  it('없는 키는 null 을 준다', () => {
    const store = createSessionStore(file, makeSafeStorage())
    expect(store.getItem('없는키')).toBeNull()
  })

  it('여러 키를 함께 보관한다', () => {
    const store = createSessionStore(file, makeSafeStorage())
    store.setItem('a', '1')
    store.setItem('b', '2')
    expect(store.getItem('a')).toBe('1')
    expect(store.getItem('b')).toBe('2')
  })

  it('파일에 원문 문자열이 그대로 들어 있지 않다', () => {
    const store = createSessionStore(file, makeSafeStorage())
    store.setItem('sb-auth-token', TOKEN)
    const raw = readFileSync(file).toString('utf8')
    expect(raw).not.toContain(TOKEN)
  })

  it('암호화를 쓸 수 없으면 파일을 만들지 않는다', () => {
    const store = createSessionStore(file, makeSafeStorage(false))
    store.setItem('sb-auth-token', TOKEN)
    expect(existsSync(file)).toBe(false)
    expect(store.getItem('sb-auth-token')).toBeNull()
  })

  it('safeStorage 가 아예 없으면 평문으로 저장하지 않는다', () => {
    const store = createSessionStore(file)
    store.setItem('sb-auth-token', TOKEN)
    expect(existsSync(file)).toBe(false)
  })

  it('마지막 키를 지우면 파일도 지운다', () => {
    const store = createSessionStore(file, makeSafeStorage())
    store.setItem('a', '1')
    store.setItem('b', '2')
    store.removeItem('a')
    expect(existsSync(file)).toBe(true)
    expect(store.getItem('b')).toBe('2')
    store.removeItem('b')
    expect(existsSync(file)).toBe(false)
    expect(store.getItem('b')).toBeNull()
  })

  it('다른 PC 의 DPAPI 로 만든 파일처럼 복호화가 실패하면 빈 상태로 본다', () => {
    const store = createSessionStore(file, makeSafeStorage())
    store.setItem('a', '1')
    // 복호화에 실패하는 스텁으로 같은 파일을 읽는다
    const broken = createSessionStore(file, {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
      decryptString: () => {
        throw new Error('복호화 실패')
      }
    })
    expect(broken.getItem('a')).toBeNull()
  })
})
