import { describe, it, expect } from 'vitest'
import {
  TASK_PAGE_SIZE,
  chatResult,
  chatRuns,
  hasMore,
  mergeTaskRuns,
  pageOf,
  scheduleRuns,
  taskTitle,
  type TaskRun
} from '../src/renderer/src/lib/task-runs'
import type { ScheduleStatusDto } from '../src/shared/schedule'
import ko from '../src/renderer/src/i18n/ko.json'
import en from '../src/renderer/src/i18n/en.json'

function status(over: Partial<ScheduleStatusDto> = {}): ScheduleStatusDto {
  return {
    playbookId: 'p1',
    schedule: { enabled: true, kind: 'daily', at: '09:00', paused: false },
    state: 'waiting',
    nextRunAt: 3000,
    lastRunAt: 2000,
    lastResult: 'ok',
    lastSummary: '메일 3건을 정리했어요',
    history: [
      { at: 1000, result: 'failed' },
      { at: 2000, result: 'ok' }
    ],
    ...over
  }
}

describe('이력 줄 제목', () => {
  it('첫 줄만 쓰고 앞뒤 공백을 턴다', () => {
    expect(taskTitle('  네이버 메일 정리해 줘  \n두 번째 줄')).toBe('네이버 메일 정리해 줘')
  })

  it('빈 줄은 건너뛴다', () => {
    expect(taskTitle('\n\n  \n실제 지시')).toBe('실제 지시')
  })

  it('60자를 넘으면 잘라 붙임표를 단다', () => {
    const title = taskTitle('가'.repeat(80))
    expect(title).toHaveLength(61)
    expect(title.endsWith('…')).toBe(true)
  })

  it('비어 있으면 빈 문자열', () => {
    expect(taskTitle('   ')).toBe('')
  })
})

describe('채팅 결과 판정', () => {
  it('AI 가 답을 썼으면 성공', () => {
    expect(chatResult('끝냈습니다')).toBe('ok')
  })

  it('답이 없으면 중간에 멈춘 것으로 본다', () => {
    expect(chatResult('')).toBe('skipped')
    expect(chatResult('  \n ')).toBe('skipped')
  })
})

describe('예약 실행 기록 → 이력 줄', () => {
  it('최근 이력 한 건마다 한 줄을 만들고 플레이북 이름을 붙인다', () => {
    const rows = scheduleRuns([status()], () => '메일 정리')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === 'schedule')).toBe(true)
    expect(rows.every((r) => r.title === '메일 정리')).toBe(true)
    expect(rows.map((r) => r.result)).toEqual(['failed', 'ok'])
  })

  it('이름을 못 찾으면 id 로 떨어진다', () => {
    expect(scheduleRuns([status()], () => undefined)[0].title).toBe('p1')
  })

  it('요약은 마지막 실행 줄에만 붙는다', () => {
    const rows = scheduleRuns([status()], () => '메일 정리')
    expect(rows.find((r) => r.at === 2000)?.summary).toBe('메일 3건을 정리했어요')
    expect(rows.find((r) => r.at === 1000)?.summary).toBe('')
  })

  it('예약 줄은 열 대화가 없다', () => {
    expect(scheduleRuns([status()], () => '메일 정리')[0].chatId).toBeNull()
  })

  it('이력이 비면 줄도 없다', () => {
    expect(scheduleRuns([status({ history: [] })], () => '메일 정리')).toEqual([])
  })
})

describe('채팅 기록 → 이력 줄', () => {
  it('제목은 첫 지시, 요약은 마지막 응답의 첫 줄', () => {
    const rows = chatRuns([
      { id: 7, at: 1500, prompt: '장바구니 비워 줘', lastText: '# 제목\n\n비웠습니다\n나머지' }
    ])
    expect(rows[0]).toMatchObject({
      source: 'chat',
      chatId: 7,
      title: '장바구니 비워 줘',
      summary: '비웠습니다',
      result: 'ok',
      playbookId: null
    })
  })
})

describe('이력 합치기', () => {
  it('두 출처를 시간 역순으로 섞는다', () => {
    const merged = mergeTaskRuns(
      scheduleRuns([status()], () => '메일 정리'),
      chatRuns([{ id: 7, at: 1500, prompt: '장바구니 비워 줘', lastText: '비웠습니다' }])
    )
    expect(merged.map((r) => r.at)).toEqual([2000, 1500, 1000])
    expect(merged.map((r) => r.source)).toEqual(['schedule', 'chat', 'schedule'])
  })

  it('같은 시각이면 key 순으로 갈라 순서가 흔들리지 않는다', () => {
    const a = chatRuns([{ id: 2, at: 1000, prompt: 'b', lastText: 'x' }])
    const b = chatRuns([{ id: 1, at: 1000, prompt: 'a', lastText: 'x' }])
    expect(mergeTaskRuns(a, b).map((r) => r.chatId)).toEqual([1, 2])
    expect(mergeTaskRuns(b, a).map((r) => r.chatId)).toEqual([1, 2])
  })

  it('한쪽이 비어도 그대로 돌려준다', () => {
    expect(mergeTaskRuns([], chatRuns([]))).toEqual([])
  })
})

describe('50건 페이지', () => {
  const runs: TaskRun[] = Array.from({ length: 120 }, (_, i) => ({
    key: `chat-${i}`,
    source: 'chat',
    at: 1000 - i,
    title: `t${i}`,
    result: 'ok',
    summary: '',
    chatId: i,
    playbookId: null
  }))

  it('한 쪽은 50건이다', () => {
    expect(TASK_PAGE_SIZE).toBe(50)
    expect(pageOf(runs, 1)).toHaveLength(50)
    expect(pageOf(runs, 2)).toHaveLength(100)
  })

  it('남은 게 없으면 더 보기를 감춘다', () => {
    expect(hasMore(runs, 2)).toBe(true)
    expect(hasMore(runs, 3)).toBe(false)
    expect(pageOf(runs, 3)).toHaveLength(120)
  })
})

// 평평한 키 목록(중첩 객체는 점으로 잇는다)
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

describe('작업 페이지 i18n', () => {
  const koKeys = flatten(ko as Record<string, unknown>)
  const enKeys = flatten(en as Record<string, unknown>)

  it('tasks.* 키가 두 파일에 모두 있다', () => {
    const keys = [
      'tasks.title',
      'tasks.desc',
      'tasks.running.title',
      'tasks.running.empty',
      'tasks.running.stop',
      'tasks.running.scheduled',
      'tasks.scheduled.title',
      'tasks.scheduled.empty',
      'tasks.scheduled.open',
      'tasks.history.title',
      'tasks.history.empty',
      'tasks.history.more',
      'tasks.history.loading',
      'tasks.source.schedule',
      'tasks.source.chat',
      'tasks.untitled'
    ]
    for (const key of keys) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })

  it('사이드바 작업 항목 문구가 있다', () => {
    expect(koKeys).toContain('sidebar.tasks')
    expect(enKeys).toContain('sidebar.tasks')
  })
})
