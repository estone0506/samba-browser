// AI 채팅 저장소 — CRUD·삭제 표식(tombstone)·비밀값 방어

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { ChatRepo } from '../src/main/chat/repo'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import { sanitizeSteps, titleFromMessage } from '../src/shared/chat'

const SECRET = 'sup3rs3cret!'

describe('ChatRepo', () => {
  let db: Db
  let repo: ChatRepo
  let outbox: SyncOutbox

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    outbox = new SyncOutbox(db)
    repo = new ChatRepo(db)
    repo.setWorkspaceScope({ id: 1, isDefault: true })
    repo.setOutboxRecorder(createOutboxRecorder(db, outbox, () => 1))
  })

  afterEach(() => {
    db.close()
  })

  it('대화를 만들고 목록·상세로 읽는다', () => {
    const chat = repo.create('첫 대화')
    expect(chat.id).toBeGreaterThan(0)
    expect(repo.list().map((c) => c.title)).toEqual(['첫 대화'])

    const detail = repo.get(chat.id)
    expect(detail?.chat.title).toBe('첫 대화')
    expect(detail?.messages).toEqual([])
  })

  it('메시지를 덧붙이면 순서대로 읽히고 대화 수정 시각이 올라간다', () => {
    const chat = repo.create('대화')
    repo.append({ chatId: chat.id, role: 'user', content: '구글 열어줘' }, 1000)
    repo.append(
      {
        chatId: chat.id,
        role: 'assistant',
        content: '열었습니다',
        steps: [{ label: '이동', ok: true }]
      },
      2000
    )

    const detail = repo.get(chat.id)
    expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(detail?.messages[1].content).toBe('열었습니다')
    expect(detail?.messages[1].steps).toEqual([{ label: '이동', ok: true }])
    expect(detail?.chat.updatedAt).toBe(2000)
  })

  it('없는 대화에 붙이면 null, 알 수 없는 역할은 거부한다', () => {
    expect(repo.append({ chatId: 999, role: 'user', content: '유령' })).toBeNull()
    const chat = repo.create('대화')
    expect(() =>
      repo.append({ chatId: chat.id, role: 'root' as unknown as 'user', content: 'x' })
    ).toThrow()
  })

  it('제목을 바꾸면 목록에도 반영된다', () => {
    const chat = repo.create('옛 제목')
    expect(repo.rename(chat.id, '새 제목')?.title).toBe('새 제목')
    expect(repo.list()[0].title).toBe('새 제목')
    expect(repo.rename(999, '없음')).toBeNull()
  })

  it('삭제는 물리 삭제가 아니라 표식이다 — 목록·상세에서 모두 사라진다', () => {
    const chat = repo.create('지울 대화')
    repo.append({ chatId: chat.id, role: 'user', content: '안녕' })
    expect(repo.remove(chat.id)).toBe(true)

    expect(repo.list()).toEqual([])
    expect(repo.get(chat.id)).toBeNull()
    // 메시지도 함께 표식을 받아 목록에서 빠진다
    expect(repo.messages(chat.id)).toEqual([])
    // 이미 지운 대화는 두 번 지워지지 않는다
    expect(repo.remove(chat.id)).toBe(false)
  })

  it('삭제 시 대화·메시지 모두 변경 로그에 스냅샷과 함께 남는다', () => {
    const chat = repo.create('지울 대화')
    repo.append({ chatId: chat.id, role: 'user', content: '안녕' })
    repo.remove(chat.id)

    const chatEntry = outbox.pendingFor('chats').at(-1)
    expect(chatEntry?.op).toBe('delete')
    expect(chatEntry?.payload).toContain('지울 대화')

    const messageEntry = outbox.pendingFor('chat_messages').at(-1)
    expect(messageEntry?.op).toBe('delete')
    expect(messageEntry?.payload).toContain('안녕')
  })

  it('다른 작업공간의 대화는 보이지 않는다', () => {
    repo.create('기본 작업공간 대화')
    repo.setWorkspaceScope({ id: 2, isDefault: false })
    expect(repo.list()).toEqual([])
    repo.create('두 번째 작업공간 대화')
    expect(repo.list().map((c) => c.title)).toEqual(['두 번째 작업공간 대화'])
  })

  it('진행 로그는 라벨만 저장한다 — 값이 딸려 와도 버려진다', () => {
    const chat = repo.create('비밀 방어')
    repo.append({
      chatId: chat.id,
      role: 'assistant',
      content: '로그인했습니다',
      steps: [
        // 도구가 실수로 값을 덧붙였다고 가정한다(실제 경로에는 없다)
        { label: '로그인: example.com (내 계정)', ok: true, value: SECRET } as never,
        { label: '입력: login (#3)', ok: true, password: SECRET } as never
      ]
    })

    const stored = repo.get(chat.id)?.messages[0]
    expect(stored?.steps).toEqual([
      { label: '로그인: example.com (내 계정)', ok: true },
      { label: '입력: login (#3)', ok: true }
    ])
    // DB 에 들어간 원문에도 비밀 문자열이 없다
    expect(JSON.stringify(stored)).not.toContain(SECRET)
  })
})

describe('shared/chat 순수 함수', () => {
  it('sanitizeSteps 는 label/ok/key 만 남긴다', () => {
    expect(sanitizeSteps([{ label: 'a', ok: true, key: 'k', secret: SECRET }])).toEqual([
      { label: 'a', ok: true, key: 'k' }
    ])
    expect(sanitizeSteps('아님')).toBeNull()
    expect(sanitizeSteps([null, 3])).toEqual([])
  })

  it('titleFromMessage 는 첫 줄만 쓰고 길면 자른다', () => {
    expect(titleFromMessage('  구글 열어줘\n두 번째 줄 ')).toBe('구글 열어줘')
    expect(titleFromMessage('가'.repeat(60))).toHaveLength(41)
    expect(titleFromMessage('   ')).toBe('')
  })
})
