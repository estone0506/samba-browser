// 복구 키 — 24자 Crockford base32(I·L·O·U 제외), 4자씩 6그룹. 120비트.
// 생성 화면에서만 화면에 뜨고, 저장되는 것은 "복구 키로 감싼 마스터 키" 뿐이다

import { deriveKey, encrypt, decrypt, randomBytes, type EncryptedBlob } from './crypto'

export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const RECOVERY_KEY_CHARS = 24
export const RECOVERY_GROUP_SIZE = 4
export const RECOVERY_GROUPS = 6
const RECOVERY_AAD = 'recovery'
// 256 을 32 로 나눈 나머지가 0 이라 0~255 전부 써도 편향이 없지만,
// 알파벳이 32 가 아닌 값으로 바뀌어도 안전하도록 상한을 계산해 둔다(거부 표집)
const MAX_UNBIASED = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length

/** 새 복구 키를 만든다. 편향 없는 거부 표집으로 뽑는다 */
export function generateRecoveryKey(): string {
  let out = ''
  while (out.length < RECOVERY_KEY_CHARS) {
    for (const byte of randomBytes(RECOVERY_KEY_CHARS)) {
      if (byte >= MAX_UNBIASED) continue
      out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
      if (out.length === RECOVERY_KEY_CHARS) break
    }
  }
  return formatRecoveryKey(out)
}

/** 하이픈 없는 24자를 4자씩 6그룹으로 끊어 표시용 문자열을 만든다 */
export function formatRecoveryKey(compact: string): string {
  const groups: string[] = []
  for (let i = 0; i < compact.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(compact.slice(i, i + RECOVERY_GROUP_SIZE))
  }
  return groups.join('-')
}

/** 사람이 옮겨 적다 생기는 혼동(O/0, I·L/1, U/V)을 교정하고 하이픈·공백을 없앤다 */
export function normalizeRecoveryKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

/** 정규화한 값이 24자이고 모두 알파벳 안의 문자인지 확인한다 */
export function isValidRecoveryKey(input: string): boolean {
  const compact = normalizeRecoveryKey(input)
  if (compact.length !== RECOVERY_KEY_CHARS) return false
  return [...compact].every((c) => RECOVERY_ALPHABET.includes(c))
}

/** 복구 키에서 유도한 키로 마스터 키를 감싼다. salt 는 vault_meta.recovery_salt */
export async function wrapMasterKey(
  master: Buffer,
  recoveryKey: string,
  salt: Uint8Array
): Promise<EncryptedBlob> {
  const wrapper = await deriveKey(normalizeRecoveryKey(recoveryKey), salt)
  return encrypt(wrapper, master.toString('base64'), RECOVERY_AAD)
}

/** 복구 키로 마스터 키를 되찾는다. 틀리면 예외가 난다 */
export async function unwrapMasterKey(
  blob: EncryptedBlob,
  recoveryKey: string,
  salt: Uint8Array
): Promise<Buffer> {
  const wrapper = await deriveKey(normalizeRecoveryKey(recoveryKey), salt)
  return Buffer.from(decrypt(wrapper, blob.ciphertext, blob.iv, RECOVERY_AAD), 'base64')
}
