import { afterEach, describe, expect, it } from 'vitest'
import { captureMessages } from '../src/main/i18n/messages/capture'
import { extensionMessages } from '../src/main/i18n/messages/extensions'
import { ipcMessages } from '../src/main/i18n/messages/ipc'
import { phoneMessages } from '../src/main/i18n/messages/phone'
import { syncMessages } from '../src/main/i18n/messages/sync'
import { vaultMessages } from '../src/main/i18n/messages/vault'
import { workspaceMessages } from '../src/main/i18n/messages/workspace'
import { getMainLanguage, setMainLanguage, tr, type MessageKey } from '../src/main/i18n'

const tables = {
  capture: captureMessages,
  extensions: extensionMessages,
  ipc: ipcMessages,
  phone: phoneMessages,
  sync: syncMessages,
  vault: vaultMessages,
  workspace: workspaceMessages
}

// 문구 안의 {name} 자리 목록(정렬)
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
}

afterEach(() => setMainLanguage('ko'))

describe('메인 문구 사전', () => {
  it.each(Object.entries(tables))('%s: ko·en 키가 같고 빈 문구가 없다', (_name, table) => {
    const ko: Record<string, string> = table.ko
    const en: Record<string, string> = table.en
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort())
    for (const key of Object.keys(ko)) {
      expect(ko[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
      expect(placeholders(en[key]), key).toEqual(placeholders(ko[key]))
    }
  })

  it('영역끼리 키가 겹치지 않는다', () => {
    const seen = new Map<string, string>()
    for (const [name, table] of Object.entries(tables)) {
      for (const key of Object.keys(table.ko)) {
        expect(seen.get(key), `${key}: ${name}`).toBeUndefined()
        seen.set(key, name)
      }
    }
  })

  // 실제 파일 경로(docs/…md)는 번역 대상이 아니라 빼고 본다
  it('en 문구에는 한글이 없다', () => {
    for (const table of Object.values(tables)) {
      const en: Record<string, string> = table.en
      for (const [key, text] of Object.entries(en)) {
        expect(text.replace(/docs\/\S+\.md/g, ''), key).not.toMatch(/[가-힣]/)
      }
    }
  })
})

describe('tr', () => {
  // 아무 영역의 첫 키 — 사전 내용이 바뀌어도 깨지지 않게
  const key = Object.keys(vaultMessages.ko)[0] as MessageKey

  it('기본 언어는 ko', () => {
    expect(getMainLanguage()).toBe('ko')
    expect(tr(key)).toBe((vaultMessages.ko as Record<string, string>)[key])
  })

  it('언어를 바꾸면 en 문구를 돌려준다', () => {
    setMainLanguage('en')
    expect(tr(key)).toBe((vaultMessages.en as Record<string, string>)[key])
  })

  it('{name} 자리를 채우고, 모르는 자리는 그대로 둔다', () => {
    const all = Object.values(tables).flatMap((t) => Object.entries(t.ko as Record<string, string>))
    const withVar = all.find(([, text]) => placeholders(text).length > 0)
    if (!withVar) return
    const [k, text] = withVar
    const vars = Object.fromEntries(placeholders(text).map((p) => [p, 'X']))
    expect(tr(k as MessageKey, vars)).not.toMatch(/\{\w+\}/)
    expect(tr(k as MessageKey, {})).toBe(text)
  })
})
