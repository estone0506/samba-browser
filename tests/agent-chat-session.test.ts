// 대화 ↔ SDK 세션 연결: 같은 대화의 다음 지시가 앞선 실행을 이어받는다
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ChatSessionStore,
  buildHistoryNote,
  HISTORY_NOTE_TURNS,
  RESUME_MAX_RUNS
} from '../src/main/agent/chat-session'
import { buildQueryOptions, type ProviderInput } from '../src/main/agent/provider'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'samba-chat-session-')), 'chat-sessions.json')
}

describe('ChatSessionStore', () => {
  it('처음엔 아무 대화도 세션이 없다', () => {
    const store = new ChatSessionStore(tmpFile())
    expect(store.get(1)).toBeNull()
  })

  it('실행이 끝날 때마다 세션 id 를 남기고 같은 세션이면 횟수를 올린다', () => {
    const file = tmpFile()
    const store = new ChatSessionStore(file)
    expect(store.note(7, 'sess-a')).toEqual({ sessionId: 'sess-a', runs: 1 })
    expect(store.note(7, 'sess-a')).toEqual({ sessionId: 'sess-a', runs: 2 })
    // 새 세션으로 갈아탔으면 1부터 다시 센다
    expect(store.note(7, 'sess-b')).toEqual({ sessionId: 'sess-b', runs: 1 })
    // 파일로 남아 앱을 다시 켜도 이어받는다
    expect(new ChatSessionStore(file).get(7)).toEqual({ sessionId: 'sess-b', runs: 1 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      '7': { sessionId: 'sess-b', runs: 1 }
    })
  })

  it('clear 로 연결을 지운다(세션 파일이 사라졌을 때)', () => {
    const store = new ChatSessionStore(tmpFile())
    store.note(3, 'x')
    store.clear(3)
    expect(store.get(3)).toBeNull()
  })

  it('깨진 파일은 빈 상태로 본다 — 세션 연결은 필수가 아니다', () => {
    const file = tmpFile()
    writeFileSync(file, '{not json')
    expect(new ChatSessionStore(file).get(1)).toBeNull()
  })

  it('한 세션으로 이어 돌리는 상한이 있다(컨텍스트 무한 성장 방지)', () => {
    expect(RESUME_MAX_RUNS).toBeGreaterThan(10)
  })
})

describe('buildHistoryNote — 세션을 못 이어받을 때 붙이는 앞부분 요약', () => {
  it('메시지가 없으면 빈 문자열', () => {
    expect(buildHistoryNote([])).toBe('')
  })

  it('사용자 지시와 AI 보고만 싣고, 자동 학습 턴과 빈 메시지는 뺀다', () => {
    const note = buildHistoryNote([
      { role: 'user', content: '123456789012345 주문처리해' },
      { role: 'assistant', content: '결제 완료했습니다.' },
      { role: 'user', content: '[자동 학습] 방금 끝난 작업에서…' },
      { role: 'assistant', content: '' },
      { role: 'system', content: '내부' }
    ])
    expect(note).toContain('- 사용자: 123456789012345 주문처리해')
    expect(note).toContain('- AI: 결제 완료했습니다.')
    expect(note).not.toContain('자동 학습')
    expect(note).not.toContain('내부')
    expect(note.endsWith('\n')).toBe(true)
  })

  it('최근 턴만 남기고 긴 본문은 자른다', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i} ` + 'x'.repeat(1000)
    }))
    const note = buildHistoryNote(many)
    const lines = note.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(HISTORY_NOTE_TURNS * 2)
    expect(lines[0]).toContain(`m${40 - HISTORY_NOTE_TURNS * 2} `)
    expect(lines.every((l) => l.length < 450)).toBe(true)
    expect(lines[0].endsWith('…')).toBe(true)
  })
})

describe('buildQueryOptions — resume 전달', () => {
  const base: ProviderInput = {
    prompt: 'p',
    systemPrompt: 's',
    model: 'm',
    mcpServers: {},
    allowedTools: [],
    abort: new AbortController()
  }

  it('resume 이 없으면 옵션에 실리지 않는다(새 세션)', () => {
    expect('resume' in buildQueryOptions(base, undefined)).toBe(false)
  })

  it('resume 이 있으면 SDK 옵션으로 그대로 넘긴다', () => {
    expect(buildQueryOptions({ ...base, resume: 'sess-1' }, undefined).resume).toBe('sess-1')
  })
})
