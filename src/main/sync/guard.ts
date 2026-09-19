// 동기화 전송 직전 마지막 방어선.
// vault_items 는 허용 컬럼 화이트리스트로, 나머지 표는 금지 키 목록으로 검사한다.
// 여기서 걸리면 전송을 중단하고 에러를 남긴다(값은 로그에 절대 넣지 않는다)

export class PlaintextLeakError extends Error {}

// vault_items_sync 에 올라갈 수 있는 컬럼 전부. label 만 사용자 지정 이름이라 평문이다
export const VAULT_SYNC_ALLOWED_KEYS: readonly string[] = [
  'id',
  'user_id',
  'workspace_id',
  'account_id',
  'type',
  'label',
  'fields_ciphertext',
  'iv',
  'aad',
  'updated_at',
  'deleted_at'
]

// 어떤 표에서도 나타나면 안 되는 키 조각
const FORBIDDEN_KEY_PARTS = ['password', 'secret', 'plaintext', 'token', 'apikey', 'api_key']

function isBytes(v: unknown): boolean {
  return v instanceof Uint8Array || Buffer.isBuffer(v)
}

/** 전송 직전 검사. 위반이면 던진다 — 호출부는 잡아서 전송을 중단하고 기록한다 */
export function assertNoPlaintext(table: string, row: Record<string, unknown>): void {
  for (const key of Object.keys(row)) {
    const lower = key.toLowerCase()
    // 'value' 는 settings_sync 의 정상 컬럼이므로 표를 구분해서 본다
    if (lower === 'value' && table !== 'settings_sync') {
      throw new PlaintextLeakError(`${table}: 평문 가능성이 있는 컬럼 '${key}' 가 포함됐습니다`)
    }
    if (FORBIDDEN_KEY_PARTS.some((p) => lower.includes(p))) {
      throw new PlaintextLeakError(`${table}: 금지된 컬럼 '${key}' 가 포함됐습니다`)
    }
  }
  if (table !== 'vault_items_sync') return

  for (const key of Object.keys(row)) {
    if (!VAULT_SYNC_ALLOWED_KEYS.includes(key)) {
      throw new PlaintextLeakError(`vault_items_sync: 허용되지 않은 컬럼 '${key}'`)
    }
  }
  if (!isBytes(row.fields_ciphertext) || !isBytes(row.iv)) {
    throw new PlaintextLeakError('vault_items_sync: 암호문·iv 는 바이트여야 합니다')
  }
  if (typeof row.aad !== 'string' || row.aad.length === 0) {
    throw new PlaintextLeakError('vault_items_sync: aad 가 비어 있습니다')
  }
}
