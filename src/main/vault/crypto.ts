// 금고(vault) 암호화 순수 함수 모음
// Electron 의존성 없음 — node:crypto 와 hash-wasm 만 사용

import { randomBytes as nodeRandomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { argon2id } from 'hash-wasm'

// AES-256-GCM 상수
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const SALT_LENGTH = 16

// argon2id 메모리 비용(KiB) 기본값 및 허용 범위
const DEFAULT_MEMORY_KIB = 65536
const MIN_MEMORY_KIB = 8192
const MAX_MEMORY_KIB = 1048576

// argon2id iterations/parallelism 기본값(저장된 kdf_params 가 없을 때)
const DEFAULT_ITERATIONS = 3
const DEFAULT_PARALLELISM = 1

// randomBytes 로 생성 가능한 바이트 수 범위
const MIN_RANDOM_BYTES = 1
const MAX_RANDOM_BYTES = 1024

// verifier 에 사용하는 고정 평문/AAD
const VERIFIER_PLAINTEXT = 'samba-vault-verifier'
const VERIFIER_AAD = 'verifier'

export interface EncryptedBlob {
  ciphertext: Buffer
  iv: Buffer
}

/** 암호학적으로 안전한 난수 n바이트를 생성한다 (1~1024 범위만 허용) */
export function randomBytes(n: number): Buffer {
  if (!Number.isInteger(n) || n < MIN_RANDOM_BYTES || n > MAX_RANDOM_BYTES) {
    throw new Error(`randomBytes 는 ${MIN_RANDOM_BYTES}~${MAX_RANDOM_BYTES} 범위만 허용합니다`)
  }
  return nodeRandomBytes(n)
}

/** argon2id 파라미터. 저장된 kdf_params 와 같은 모양이다 */
export interface KdfParams {
  memoryKiB: number
  iterations: number
  parallelism: number
}

/** 메모리 비용(KiB)을 8192~1048576 범위로 clamp 한다. 숫자가 아니면 기본값(65536) */
export function clampMemoryKiB(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_KIB
  return Math.min(MAX_MEMORY_KIB, Math.max(MIN_MEMORY_KIB, value))
}

/** VAULT_KDF_MEM 환경변수를 8192~1048576 범위로 clamp 해서 읽는다. 숫자가 아니면 기본값 */
function resolveMemoryKiBFromEnv(): number {
  return clampMemoryKiB(Number(process.env.VAULT_KDF_MEM))
}

/**
 * 새 금고를 만들 때(또는 저장된 kdf_params 가 없을 때) 쓸 기본 argon2id 파라미터.
 * VAULT_KDF_MEM 환경변수는 vitest 실행 중(process.env.VITEST === 'true')에만 반영된다 —
 * 프로덕션에서는 환경변수로 메모리 비용을 낮춰 공격을 쉽게 만들 수 없다.
 * 호출부(service.setup 등)가 직접 process.env 를 읽으면 이 게이트가 무력화되므로,
 * KDF 기본값이 필요한 곳은 반드시 이 함수를 쓴다.
 */
export function resolveDefaultKdfParams(): KdfParams {
  return {
    memoryKiB: process.env.VITEST === 'true' ? resolveMemoryKiBFromEnv() : DEFAULT_MEMORY_KIB,
    iterations: DEFAULT_ITERATIONS,
    parallelism: DEFAULT_PARALLELISM
  }
}

/**
 * argon2id 로 비밀번호와 salt 로부터 32바이트 키를 유도한다.
 * 메모리 비용은 opts.memoryKiB 명시 인자가 우선이고(항상 8192~1048576 로 clamp),
 * 없으면 resolveDefaultKdfParams() 의 값을 쓴다.
 * VAULT_KDF_MEM 환경변수는 vitest 실행 중(process.env.VITEST === 'true')에만 반영된다.
 * iterations/parallelism 은 저장된 kdf_params 를 그대로 전달할 수 있도록 열어 두며,
 * 생략하면 기본값(3/1)을 쓴다.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  opts?: { memoryKiB?: number; iterations?: number; parallelism?: number }
): Promise<Buffer> {
  if (salt.length !== SALT_LENGTH) {
    throw new Error(`salt 는 ${SALT_LENGTH}바이트여야 합니다`)
  }

  const memorySize = clampMemoryKiB(opts?.memoryKiB ?? resolveDefaultKdfParams().memoryKiB)

  const hash = await argon2id({
    password,
    salt,
    parallelism: opts?.parallelism ?? DEFAULT_PARALLELISM,
    iterations: opts?.iterations ?? DEFAULT_ITERATIONS,
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
