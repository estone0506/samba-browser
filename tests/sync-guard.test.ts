// 전송 직전 평문 유출 검사. 금고는 암호문만 올라가야 하므로
// 허용 컬럼 밖의 키나 평문으로 보이는 키가 있으면 전송을 막는다

import { describe, it, expect } from 'vitest'
import {
  assertNoPlaintext,
  PlaintextLeakError,
  VAULT_SYNC_ALLOWED_KEYS
} from '../src/main/sync/guard'
import { SYNC_TABLES } from '../src/shared/sync'

function vaultRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'uuid-1',
    user_id: 'uuid-user',
    workspace_id: 'uuid-ws',
    account_id: 'uuid-acc',
    type: 'login',
    label: '내 계정',
    fields_ciphertext: new Uint8Array([1, 2, 3]),
    iv: new Uint8Array([4, 5, 6]),
    aad: '12',
    updated_at: 1,
    deleted_at: null,
    ...extra
  }
}

describe('assertNoPlaintext — vault_items_sync', () => {
  it('허용 키만 있는 행은 통과한다', () => {
    expect(() => assertNoPlaintext('vault_items_sync', vaultRow())).not.toThrow()
  })

  it('평문으로 보이는 키가 있으면 막는다', () => {
    for (const key of ['password', 'value', 'secret', 'plaintext']) {
      expect(() => assertNoPlaintext('vault_items_sync', vaultRow({ [key]: 'x' }))).toThrow(
        PlaintextLeakError
      )
    }
  })

  it('허용 목록 밖의 임의 키도 막는다', () => {
    expect(() => assertNoPlaintext('vault_items_sync', vaultRow({ fields: '{}' }))).toThrow(
      PlaintextLeakError
    )
  })

  it('암호문·iv 가 바이트가 아니면 막는다', () => {
    expect(() =>
      assertNoPlaintext('vault_items_sync', vaultRow({ fields_ciphertext: 'base64문자열' }))
    ).toThrow(PlaintextLeakError)
    expect(() => assertNoPlaintext('vault_items_sync', vaultRow({ iv: 'base64문자열' }))).toThrow(
      PlaintextLeakError
    )
  })

  it('aad 가 비어 있으면 막는다', () => {
    expect(() => assertNoPlaintext('vault_items_sync', vaultRow({ aad: '' }))).toThrow(
      PlaintextLeakError
    )
  })

  it('에러 메시지에 값은 담지 않는다', () => {
    try {
      assertNoPlaintext('vault_items_sync', vaultRow({ password: '진짜비밀번호' }))
      throw new Error('여기까지 오면 안 된다')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(PlaintextLeakError)
      expect((e as Error).message).not.toContain('진짜비밀번호')
    }
  })

  it('허용 키 목록은 암호문 관련 컬럼만 담는다', () => {
    expect(VAULT_SYNC_ALLOWED_KEYS).toContain('fields_ciphertext')
    expect(VAULT_SYNC_ALLOWED_KEYS).not.toContain('fields')
    expect(VAULT_SYNC_ALLOWED_KEYS).not.toContain('value')
  })
})

describe('assertNoPlaintext — 그 외 표', () => {
  it('키 화이트리스트는 적용하지 않는다', () => {
    expect(() =>
      assertNoPlaintext('accounts_sync', { id: 'uuid', username: 'me@example.com', tags: '[]' })
    ).not.toThrow()
  })

  it('password·secret 키는 어느 표에서든 막는다', () => {
    expect(() => assertNoPlaintext('accounts_sync', { id: 'uuid', password: 'x' })).toThrow(
      PlaintextLeakError
    )
    expect(() => assertNoPlaintext('accounts_sync', { id: 'uuid', api_key: 'x' })).toThrow(
      PlaintextLeakError
    )
  })

  it('settings_sync 의 value 는 정상 컬럼이라 통과한다', () => {
    expect(() =>
      assertNoPlaintext('settings_sync', { id: 'uuid', key: 'theme', value: 'dark' })
    ).not.toThrow()
    // 같은 키라도 다른 표에서는 막힌다
    expect(() => assertNoPlaintext('bookmarks_sync', { id: 'uuid', value: 'dark' })).toThrow(
      PlaintextLeakError
    )
  })
})

describe('SYNC_TABLES', () => {
  it('감사 로그는 동기화 대상이 아니다', () => {
    expect(SYNC_TABLES).not.toContain('audit')
    expect(SYNC_TABLES).not.toContain('audit_log')
  })

  it('설정·계정·금고·북마크·채팅만 동기화한다', () => {
    expect([...SYNC_TABLES]).toEqual([
      'settings',
      'accounts',
      'vault_items',
      'bookmarks',
      'chats',
      'chat_messages'
    ])
  })
})
