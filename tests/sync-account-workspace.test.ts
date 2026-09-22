// 계정별 로컬 공간 — 계정이 로그인하면 그 계정의 작업공간으로 전환한다
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AccountWorkspaceStore,
  ensureAccountWorkspace,
  type WorkspaceLike
} from '../src/main/sync/account-workspace'

function fakeWorkspace(
  names: string[]
): WorkspaceLike & { active: number | null; created: string[] } {
  const rows = names.map((name, i) => ({ id: i + 1, name }))
  const w = {
    active: null as number | null,
    created: [] as string[],
    list: () => rows,
    create: (name: string) => {
      const id = rows.length + 1
      rows.push({ id, name })
      w.created.push(name)
      return { id }
    },
    switchTo: (id: number) => {
      w.active = id
    }
  }
  return w
}

const storeFile = (): string =>
  join(mkdtempSync(join(tmpdir(), 'samba-acct-ws-')), 'account-workspaces.json')

describe('ensureAccountWorkspace', () => {
  it('로그인 전 데이터가 든 첫 작업공간은 물려주지 않는다 — 계정은 새 공간을 받는다(실기: 남의 키마스터가 내 계정에 보였다)', () => {
    const w = fakeWorkspace(['기본'])
    const store = new AccountWorkspaceStore(storeFile())
    expect(ensureAccountWorkspace(w, store, 'user-a', 'a@x.com')).toBe(2)
    expect(w.active).toBe(2)
    expect(w.created).toEqual(['a@x.com'])
    expect(store.isAccountWorkspace(1)).toBe(false)
  })

  it('계정마다 다른 공간을 받고, 다시 로그인하면 같은 공간으로 돌아온다', () => {
    const w = fakeWorkspace(['기본'])
    const store = new AccountWorkspaceStore(storeFile())
    expect(ensureAccountWorkspace(w, store, 'user-a', 'a@x.com')).toBe(2)
    expect(ensureAccountWorkspace(w, store, 'user-b', 'b@x.com')).toBe(3)
    expect(w.created).toEqual(['a@x.com', 'b@x.com'])
    expect(ensureAccountWorkspace(w, store, 'user-a', 'a@x.com')).toBe(2)
    expect(w.active).toBe(2)
    expect(w.created).toEqual(['a@x.com', 'b@x.com'])
  })

  it('대응은 파일에 남아 앱을 다시 켜도 같다', () => {
    const file = storeFile()
    const w = fakeWorkspace(['기본', '둘째'])
    ensureAccountWorkspace(w, new AccountWorkspaceStore(file), 'user-a', 'a@x.com')
    const again = new AccountWorkspaceStore(file)
    expect(again.get('user-a')).toBe(3)
    expect(again.isAccountWorkspace(3)).toBe(true)
    expect(again.isAccountWorkspace(1)).toBe(false)
  })

  it('배정된 작업공간이 지워졌으면 새로 만든다', () => {
    const store = new AccountWorkspaceStore(storeFile())
    store.set('user-a', 99)
    const w = fakeWorkspace(['기본'])
    expect(ensureAccountWorkspace(w, store, 'user-a', 'a@x.com')).toBe(2)
    expect(store.get('user-a')).toBe(2)
  })
})
