// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect } from 'vitest'
import {
  randomBytes,
  deriveKey,
  encrypt,
  decrypt,
  makeVerifier,
  checkVerifier,
  zeroize
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
