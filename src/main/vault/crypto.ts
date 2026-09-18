// 금고(vault) 암호화 순수 함수 모음
// Electron 의존성 없음 — node:crypto 와 hash-wasm 만 사용

import { randomBytes as nodeRandomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { argon2id } from 'hash-wasm'

// AES-256-GCM 상수
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32

// verifier 에 사용하는 고정 평문/AAD
const VERIFIER_PLAINTEXT = 'samba-vault-verifier'
const VERIFIER_AAD = 'verifier'

export interface EncryptedBlob {
  ciphertext: Buffer
  iv: Buffer
}

/** 암호학적으로 안전한 난수 n바이트를 생성한다 */
export function randomBytes(n: number): Buffer {
  return nodeRandomBytes(n)
}

/**
 * argon2id 로 비밀번호와 salt 로부터 32바이트 키를 유도한다.
 * 테스트에서는 VAULT_KDF_MEM 환경변수로 메모리 사용량을 낮춰 속도를 확보한다.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  opts?: { memoryKiB?: number }
): Promise<Buffer> {
  const memorySize = opts?.memoryKiB ?? Number(process.env.VAULT_KDF_MEM ?? 65536)
  const hash = await argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize,
    hashLength: KEY_LENGTH,
    outputType: 'binary'
  })
  return Buffer.from(hash)
}

/**
 * AES-256-GCM 으로 평문을 암호화한다.
 * ciphertext 는 암호문 뒤에 16바이트 인증 태그를 붙인 형태다.
 */
export function encrypt(key: Buffer, plaintext: string, aad: string): EncryptedBlob {
  const iv = nodeRandomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([encrypted, authTag]), iv }
}

/**
 * encrypt 로 만든 ciphertext 를 복호화한다.
 * 키/aad 가 잘못되었거나 데이터가 변조되었으면 예외를 던진다.
 */
export function decrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, aad: string): string {
  if (ciphertext.length < AUTH_TAG_LENGTH) {
    throw new Error('ciphertext 가 너무 짧습니다')
  }
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH)
  const encrypted = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}

/** 키가 올바른지 확인할 수 있는 verifier 블록을 만든다 */
export function makeVerifier(key: Buffer): EncryptedBlob {
  return encrypt(key, VERIFIER_PLAINTEXT, VERIFIER_AAD)
}

/** verifier 를 복호화해 키가 올바른지 확인한다 (예외를 삼키고 boolean 반환) */
export function checkVerifier(key: Buffer, verifier: EncryptedBlob): boolean {
  try {
    const plain = decrypt(key, verifier.ciphertext, verifier.iv, VERIFIER_AAD)
    return plain === VERIFIER_PLAINTEXT
  } catch {
    return false
  }
}

/** 버퍼 내용을 0으로 채워 메모리에서 민감 정보를 제거한다 */
export function zeroize(buf: Buffer): void {
  buf.fill(0)
}
