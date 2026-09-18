import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiKeyStore, maskApiKey, type SafeStorageLike } from '../src/main/ai/keys'

const ANTHROPIC_KEY = 'sk-ant-api03-abcdefgh1234'
const OPENAI_KEY = 'sk-proj-zzzzzzzzwxyz'

// 실제 safeStorage 대신 쓰는 스텁. 평문을 그대로 두지 않도록 바이트를 뒤집어 저장한다
function makeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(Buffer.from(plain, 'utf8').reverse()),
    decryptString: (enc: Buffer) => Buffer.from(Buffer.from(enc).reverse()).toString('utf8')
  }
}

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samba-ai-keys-'))
  file = join(dir, 'ai-keys.bin')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('maskApiKey', () => {
  it('앞 두 마디를 남기고 끝 4자만 보여 준다', () => {
    expect(maskApiKey(ANTHROPIC_KEY)).toBe('sk-ant-••••1234')
  })

  it('마스킹 결과에 원문이 담기지 않는다', () => {
    const masked = maskApiKey(ANTHROPIC_KEY)
    expect(masked).not.toContain('api03')
    expect(masked).not.toContain('abcdefgh')
    expect(masked.length).toBeLessThan(ANTHROPIC_KEY.length)
  })

  it('8자 미만 짧은 키는 전부 가린다', () => {
    expect(maskApiKey('sk-abc')).toBe('••••')
    expect(maskApiKey('')).toBe('••••')
  })

  it('구분자가 없는 키(Gemini)는 끝 4자만 남긴다', () => {
    expect(maskApiKey('AIzaSyABCDEFGH9876')).toBe('••••9876')
  })
})

describe('ApiKeyStore', () => {
  it('set → get 왕복', () => {
    const store = new ApiKeyStore(file, makeSafeStorage())
    store.set('anthropic', ANTHROPIC_KEY)
    expect(store.get('anthropic')).toBe(ANTHROPIC_KEY)
    expect(store.get('openai')).toBeNull()
  })

  it('저장 파일 바이트에 원문 키가 등장하지 않는다', () => {
    const store = new ApiKeyStore(file, makeSafeStorage())
    store.set('anthropic', ANTHROPIC_KEY)
    expect(existsSync(file)).toBe(true)
    const bytes = readFileSync(file)
    expect(bytes.includes(Buffer.from(ANTHROPIC_KEY, 'utf8'))).toBe(false)
    expect(bytes.toString('utf8')).not.toContain('abcdefgh')
  })

  it('다시 열어도 저장된 키를 읽는다', () => {
    new ApiKeyStore(file, makeSafeStorage()).set('anthropic', ANTHROPIC_KEY)
    const reopened = new ApiKeyStore(file, makeSafeStorage())
    expect(reopened.get('anthropic')).toBe(ANTHROPIC_KEY)
  })

  it('masked() 는 마스킹 문자열만 돌려준다', () => {
    const store = new ApiKeyStore(file, makeSafeStorage())
    store.set('anthropic', ANTHROPIC_KEY)
    store.set('openai', OPENAI_KEY)
    const masked = store.masked()
    expect(masked).toEqual({ anthropic: 'sk-ant-••••1234', openai: 'sk-proj-••••wxyz' })
    expect(JSON.stringify(masked)).not.toContain('api03')
    expect(JSON.stringify(masked)).not.toContain('zzzzzzzz')
  })

  it('remove 하면 get 이 null 이 된다', () => {
    const store = new ApiKeyStore(file, makeSafeStorage())
    store.set('anthropic', ANTHROPIC_KEY)
    store.remove('anthropic')
    expect(store.get('anthropic')).toBeNull()
    expect(store.masked()).toEqual({})
    expect(new ApiKeyStore(file, makeSafeStorage()).get('anthropic')).toBeNull()
  })

  it('빈 문자열 저장은 삭제와 같다', () => {
    const store = new ApiKeyStore(file, makeSafeStorage())
    store.set('anthropic', ANTHROPIC_KEY)
    store.set('anthropic', '   ')
    expect(store.get('anthropic')).toBeNull()
  })

  it('safeStorage 를 쓸 수 없으면 저장하지 않고 get 은 null 이다', () => {
    const store = new ApiKeyStore(file, makeSafeStorage(false))
    expect(store.isAvailable()).toBe(false)
    expect(() => store.set('anthropic', ANTHROPIC_KEY)).toThrow()
    expect(store.get('anthropic')).toBeNull()
    expect(store.masked()).toEqual({})
    expect(existsSync(file)).toBe(false)
  })

  it('safeStorage 자체가 없는 환경에서도 터지지 않는다', () => {
    const store = new ApiKeyStore(file)
    expect(store.isAvailable()).toBe(false)
    expect(() => store.set('anthropic', ANTHROPIC_KEY)).toThrow()
    expect(store.get('anthropic')).toBeNull()
  })

  it('손상된 저장 파일은 빈 상태로 되돌린다', () => {
    const safeStorage = makeSafeStorage()
    new ApiKeyStore(file, safeStorage).set('anthropic', ANTHROPIC_KEY)
    const store = new ApiKeyStore(file, {
      ...safeStorage,
      decryptString: () => {
        throw new Error('복호화 실패')
      }
    })
    expect(store.get('anthropic')).toBeNull()
    expect(store.masked()).toEqual({})
  })
})
