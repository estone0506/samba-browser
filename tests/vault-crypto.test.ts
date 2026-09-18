// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, afterEach } from 'vitest'
import {
  randomBytes,
  deriveKey,
  encrypt,
  decrypt,
  makeVerifier,
  checkVerifier,
  zeroize,
  clampMemoryKiB,
  resolveDefaultKdfParams
} from '../src/main/vault/crypto'

describe('deriveKey', () => {
  it('같은 비밀번호+salt → 같은 키', async () => {
    const salt = randomBytes(16)
    const k1 = await deriveKey('pw1234', salt)
    const k2 = await deriveKey('pw1234', salt)
    expect(k1.equals(k2)).toBe(true)
    expect(k1.length).toBe(32)
  })

  it('다른 salt → 다른 키', async () => {
    const salt1 = randomBytes(16)
    const salt2 = randomBytes(16)
    const k1 = await deriveKey('pw1234', salt1)
    const k2 = await deriveKey('pw1234', salt2)
    expect(k1.equals(k2)).toBe(false)
  })

  it('salt 길이가 16바이트가 아니면 throw', async () => {
    await expect(deriveKey('pw1234', Buffer.alloc(15))).rejects.toThrow()
    await expect(deriveKey('pw1234', Buffer.alloc(17))).rejects.toThrow()
  })

  it('memoryKiB 인자를 명시하면 해당 값을 사용한다(값이 달라도 정상 동작)', async () => {
    const salt = randomBytes(16)
    const key = await deriveKey('pw1234', salt, { memoryKiB: 8192 })
    expect(key.length).toBe(32)
  })
})

describe('randomBytes', () => {
  it('1~1024 범위를 벗어나면 throw', () => {
    expect(() => randomBytes(0)).toThrow()
    expect(() => randomBytes(1025)).toThrow()
  })

  it('범위 내 값은 정상 동작', () => {
    expect(randomBytes(1).length).toBe(1)
    expect(randomBytes(1024).length).toBe(1024)
  })
})

describe('encrypt/decrypt', () => {
  it('왕복 시 원문 복원', async () => {
    const key = await deriveKey('pw1234', randomBytes(16))
    const { ciphertext, iv } = encrypt(key, 'hello world', 'item-1')
    const plain = decrypt(key, ciphertext, iv, 'item-1')
    expect(plain).toBe('hello world')
  })

  it('두 번 암호화 시 iv 가 서로 다름', async () => {
    const key = await deriveKey('pw1234', randomBytes(16))
    const a = encrypt(key, 'hello', 'item-1')
    const b = encrypt(key, 'hello', 'item-1')
    expect(a.iv.equals(b.iv)).toBe(false)
  })

  it('잘못된 키로 복호화 시 throw', async () => {
    const key1 = await deriveKey('pw1234', randomBytes(16))
    const key2 = await deriveKey('other-pw', randomBytes(16))
    const { ciphertext, iv } = encrypt(key1, 'secret', 'item-1')
    expect(() => decrypt(key2, ciphertext, iv, 'item-1')).toThrow()
  })

  it('잘못된 aad 로 복호화 시 throw', async () => {
    const key = await deriveKey('pw1234', randomBytes(16))
    const { ciphertext, iv } = encrypt(key, 'secret', 'item-1')
    expect(() => decrypt(key, ciphertext, iv, 'item-2')).toThrow()
  })

  it('ciphertext 변조 시 throw', async () => {
    const key = await deriveKey('pw1234', randomBytes(16))
    const { ciphertext, iv } = encrypt(key, 'secret', 'item-1')
    const tampered = Buffer.from(ciphertext)
    tampered[0] = tampered[0] ^ 0xff
    expect(() => decrypt(key, tampered, iv, 'item-1')).toThrow()
  })
})

describe('verifier', () => {
  it('올바른 키면 true', async () => {
    const key = await deriveKey('pw1234', randomBytes(16))
    const verifier = makeVerifier(key)
    expect(checkVerifier(key, verifier)).toBe(true)
  })

  it('잘못된 키면 false', async () => {
    const key1 = await deriveKey('pw1234', randomBytes(16))
    const key2 = await deriveKey('wrong-pw', randomBytes(16))
    const verifier = makeVerifier(key1)
    expect(checkVerifier(key2, verifier)).toBe(false)
  })
})

describe('zeroize', () => {
  it('버퍼를 0으로 채운다', () => {
    const buf = Buffer.from([1, 2, 3, 4])
    zeroize(buf)
    expect(buf.every((b) => b === 0)).toBe(true)
  })
})

describe('resolveDefaultKdfParams', () => {
  // process.env 를 만지므로 각 테스트가 끝나면 원래 값으로 되돌린다
  const original = { vitest: process.env.VITEST, mem: process.env.VAULT_KDF_MEM }
  afterEach(() => {
    if (original.vitest === undefined) delete process.env.VITEST
    else process.env.VITEST = original.vitest
    if (original.mem === undefined) delete process.env.VAULT_KDF_MEM
    else process.env.VAULT_KDF_MEM = original.mem
  })

  it('VITEST 가 아니면 VAULT_KDF_MEM 을 무시하고 65536 을 쓴다(프로덕션 경로)', () => {
    delete process.env.VITEST
    process.env.VAULT_KDF_MEM = '8192'
    expect(resolveDefaultKdfParams()).toEqual({
      memoryKiB: 65536,
      iterations: 3,
      parallelism: 1
    })
  })

  it('VITEST 중에는 VAULT_KDF_MEM 을 허용 범위로 clamp 해서 쓴다', () => {
    process.env.VITEST = 'true'
    process.env.VAULT_KDF_MEM = '8192'
    expect(resolveDefaultKdfParams().memoryKiB).toBe(8192)
    process.env.VAULT_KDF_MEM = '1'
    expect(resolveDefaultKdfParams().memoryKiB).toBe(8192)
    process.env.VAULT_KDF_MEM = '99999999'
    expect(resolveDefaultKdfParams().memoryKiB).toBe(1048576)
    process.env.VAULT_KDF_MEM = 'abc'
    expect(resolveDefaultKdfParams().memoryKiB).toBe(65536)
  })
})

describe('clampMemoryKiB', () => {
  it('범위를 벗어난 값을 8192~1048576 으로 맞춘다', () => {
    expect(clampMemoryKiB(1)).toBe(8192)
    expect(clampMemoryKiB(65536)).toBe(65536)
    expect(clampMemoryKiB(9_999_999)).toBe(1048576)
    expect(clampMemoryKiB(Number.NaN)).toBe(65536)
  })
})
