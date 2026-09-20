// 사이트 기억 — 추출 규칙·주입 블록·마스킹·저장 상한·설정 키·i18n.

import { describe, it, expect } from 'vitest'
import {
  addNote,
  addRecipe,
  autoNotesByHost,
  buildSiteMemoryBlock,
  extractStepsByHost,
  maskMemoryText,
  runHosts,
  stepLabel,
  toUrlPattern,
  SITE_MEMORY_BLOCK_MAX,
  SITE_MEMORY_HINT,
  SITE_NOTE_MAX,
  SITE_RECIPE_MAX,
  SITE_RECIPE_STEP_MAX,
  type AgentToolCall,
  type SiteMemoryEntry,
  type SiteRecipe
} from '@shared/site-memory'
import {
  REMEMBER_EMPTY_NOTE,
  REMEMBER_HOST_UNKNOWN,
  SiteMemoryService
} from '../src/main/agent/site-memory'
import { emptyEntry, type SiteMemoryStoreLike } from '../src/main/agent/site-memory-store'
import { SYNCED_SETTING_KEYS } from '@shared/sync'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { appendSiteMemory } from '../src/main/agent/prompt'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'

function call(patch: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    tool: 'click',
    label: '클릭: 구매하기 (#42)',
    ok: true,
    result: 'ok',
    url: 'https://www.musinsa.com/products/123?ref=search',
    ...patch
  }
}

// 메모리 대역 저장소 — 파일을 건드리지 않는다
function memoryStore(initial: Record<string, SiteMemoryEntry> = {}): SiteMemoryStoreLike & {
  data: Record<string, SiteMemoryEntry>
} {
  return {
    data: { ...initial },
    read() {
      return this.data
    },
    write(file) {
      this.data = file
    }
  }
}

describe('경로 추출 규칙', () => {
  it('행동 도구만 남고 관찰 도구는 빠진다', () => {
    const steps = extractStepsByHost([
      call({ tool: 'get_page', label: '페이지 읽기' }),
      call({ tool: 'find_elements', label: '요소 찾기: 255' }),
      call({ tool: 'screenshot', label: '화면 캡처' }),
      call({ tool: 'click', label: '클릭: 구매하기 (#42)' })
    ])
    expect(steps.get('musinsa.com')?.map((s) => s.tool)).toEqual(['click'])
  })

  it('실패로 끝난 호출은 경로에 넣지 않는다', () => {
    const steps = extractStepsByHost([
      call({ label: '클릭: 장바구니 (#1)', result: 'refused: read-only mode' }),
      call({ label: '클릭: 취소 (#2)', ok: false, result: 'ERR boom' }),
      call({ label: '클릭: 구매하기 (#3)', result: 'ok; clicked but nothing changed' }),
      call({ label: '클릭: 결제하기 (#4)', result: 'ok' })
    ])
    expect(steps.get('musinsa.com')?.map((s) => s.label)).toEqual(['결제하기'])
  })

  it('같은 라벨 연속 중복은 하나만 남는다', () => {
    const steps = extractStepsByHost([
      call({ tool: 'scroll', label: '스크롤 down' }),
      call({ tool: 'scroll', label: '스크롤 down' }),
      call({ tool: 'scroll', label: '스크롤 down' }),
      call({ tool: 'click', label: '클릭: 255 (#9)' })
    ])
    expect(steps.get('musinsa.com')).toHaveLength(2)
  })

  it('호스트별로 나뉘고 urlPattern 은 경로만 남는다', () => {
    const steps = extractStepsByHost([
      call({ url: 'https://www.musinsa.com/products/123?color=black' }),
      call({ label: '클릭: 주소 검색 (#7)', url: 'https://postcode.map.daum.net/guide?q=1' })
    ])
    expect(steps.get('musinsa.com')?.[0].urlPattern).toBe('/products/123')
    expect(steps.get('daum.net')?.[0].urlPattern).toBe('/guide')
  })

  it('단계 수 상한을 넘지 않는다', () => {
    const many = Array.from({ length: SITE_RECIPE_STEP_MAX + 10 }, (_, i) =>
      call({ label: `클릭: 항목${i} (#${i})` })
    )
    expect(extractStepsByHost(many).get('musinsa.com')).toHaveLength(SITE_RECIPE_STEP_MAX)
  })

  it('라벨에서 요소 텍스트만 떼어 낸다', () => {
    expect(stepLabel('클릭: 구매하기 (#42)')).toBe('구매하기')
    expect(stepLabel('입력: "255" (#3)')).toBe('255')
    expect(stepLabel('레이어 닫기')).toBe('레이어 닫기')
  })

  it('쿼리는 버리고 경로만 남긴다', () => {
    expect(toUrlPattern('https://a.com/b/c?d=1#e')).toBe('/b/c')
    expect(toUrlPattern('not a url')).toBe('')
  })
})

describe('자동 메모', () => {
  it('Enter 폴백 표식이 있으면 메모를 만든다', () => {
    const notes = autoNotesByHost([call({ result: 'ok (pressed Enter)' })])
    expect(notes.get('musinsa.com')).toEqual(["'구매하기' 는 Enter 로 열린다"])
  })

  it('팝업 안내가 붙은 클릭은 팝업 메모를 만든다', () => {
    const notes = autoNotesByHost([
      call({
        label: '클릭: 배송지 변경 (#5)',
        result: 'ok\nopened popup p1 "주소" (musinsa.com) - call switch_tab("p1")'
      })
    ])
    expect(notes.get('musinsa.com')).toEqual(["'배송지 변경' 는 팝업 창으로 열린다"])
  })

  it('실패한 호출에서는 메모를 만들지 않는다', () => {
    expect(autoNotesByHost([call({ ok: false, result: 'error (pressed Enter)' })]).size).toBe(0)
  })
})

describe('마스킹', () => {
  it('전화번호·주소·이메일·수령인을 지운다', () => {
    expect(maskMemoryText('수령인 홍길동 010-1234-5678')).toBe('수령인 *** ***')
    expect(maskMemoryText('서울특별시 강남구 테헤란로 12')).toContain('***')
    expect(maskMemoryText('me@example.com 으로 보내기')).toBe('*** 으로 보내기')
  })

  it('비밀값과 6자리 이상 숫자를 지운다', () => {
    expect(maskMemoryText('비밀번호 abcd1234')).toBe('비밀번호 ***')
    expect(maskMemoryText('주문번호 20240131001')).toBe('주문번호 ***')
  })
})

describe('저장 상한', () => {
  it('메모는 중복을 거르고 상한을 지킨다', () => {
    let notes: string[] = []
    for (let i = 0; i < SITE_NOTE_MAX + 5; i += 1) notes = addNote(notes, `메모 ${i}`)
    expect(notes).toHaveLength(SITE_NOTE_MAX)
    const again = addNote(notes, notes[0])
    expect(again).toHaveLength(SITE_NOTE_MAX)
  })

  it('빈 메모는 저장하지 않는다', () => {
    expect(addNote([], '   ')).toEqual([])
  })

  it('경로는 최신이 앞이고 상한을 지킨다', () => {
    const make = (goal: string): SiteRecipe => ({
      goal,
      steps: [],
      createdAt: 1,
      uses: 0,
      lastOkAt: 1
    })
    let recipes: SiteRecipe[] = []
    for (let i = 0; i < SITE_RECIPE_MAX + 3; i += 1) recipes = addRecipe(recipes, make(`목표 ${i}`))
    expect(recipes).toHaveLength(SITE_RECIPE_MAX)
    expect(recipes[0].goal).toBe(`목표 ${SITE_RECIPE_MAX + 2}`)
  })

  it('같은 목표의 옛 경로는 새 것으로 갈아 끼운다', () => {
    const old: SiteRecipe = { goal: '같은 일', steps: [], createdAt: 1, uses: 3, lastOkAt: 1 }
    const fresh: SiteRecipe = { goal: '같은 일', steps: [], createdAt: 9, uses: 0, lastOkAt: 9 }
    expect(addRecipe([old], fresh)).toEqual([fresh])
  })
})

describe('주입 블록', () => {
  const entry: SiteMemoryEntry = {
    notes: ["'구매하기' 는 Enter 로 열린다"],
    recipes: [
      {
        goal: '무신사에서 255 사이즈 주문',
        steps: [{ tool: 'click', label: '구매하기', urlPattern: '/products/123' }],
        createdAt: 1,
        uses: 0,
        lastOkAt: 2
      }
    ]
  }

  it('호스트 머리글과 안내 문구를 담는다', () => {
    const block = buildSiteMemoryBlock([{ host: 'musinsa.com', entry }])
    expect(block).toContain(`SITE MEMORY (musinsa.com): ${SITE_MEMORY_HINT}`)
    expect(block).toContain("- 메모: '구매하기' 는 Enter 로 열린다")
    expect(block).toContain('- 경로(무신사에서 255 사이즈 주문): click 구매하기 @/products/123')
  })

  it('가장 최근 성공 경로부터 최대 2개만 싣는다', () => {
    const many: SiteMemoryEntry = {
      notes: [],
      recipes: [1, 2, 3, 4].map((n) => ({
        goal: `목표${n}`,
        steps: [],
        createdAt: n,
        uses: 0,
        lastOkAt: n
      }))
    }
    const block = buildSiteMemoryBlock([{ host: 'a.com', entry: many }])
    expect(block).toContain('목표4')
    expect(block).toContain('목표3')
    expect(block).not.toContain('목표1')
  })

  it('전체 길이 상한을 넘지 않는다', () => {
    const big: SiteMemoryEntry = {
      notes: Array.from({ length: SITE_NOTE_MAX }, (_, i) => `${i}`.padEnd(150, '가')),
      recipes: []
    }
    const block = buildSiteMemoryBlock([
      { host: 'a.com', entry: big },
      { host: 'b.com', entry: big }
    ])
    expect(block.length).toBeLessThanOrEqual(SITE_MEMORY_BLOCK_MAX)
  })

  it('빈 기억은 아무 줄도 만들지 않는다', () => {
    expect(buildSiteMemoryBlock([{ host: 'a.com', entry: emptyEntry() }])).toBe('')
  })

  it('블록이 비어 있으면 시스템 프롬프트를 그대로 둔다', () => {
    expect(appendSiteMemory('BASE', '')).toBe('BASE')
    expect(appendSiteMemory('BASE', 'SITE MEMORY (a.com): x')).toContain('SITE MEMORY (a.com)')
  })
})

describe('호스트 뽑기', () => {
  it('지시문의 사이트명을 호스트로 옮긴다', () => {
    expect(runHosts({ prompt: '무신사에서 신발 주문해 줘' })).toEqual(['musinsa.com'])
    expect(runHosts({ prompt: '29CM 장바구니 확인' })).toEqual(['29cm.co.kr'])
    expect(runHosts({ prompt: '롯데온에서 가격 비교' })).toEqual(['lotteon.com'])
  })

  it('현재 탭 URL 이 가장 앞에 온다', () => {
    const hosts = runHosts({
      prompt: '무신사에서 주문',
      currentUrl: 'https://shop.a-rt.com/product/1'
    })
    expect(hosts[0]).toBe('a-rt.com')
    expect(hosts).toContain('musinsa.com')
  })

  it('플레이북 본문의 URL 도 읽는다', () => {
    const hosts = runHosts({
      prompt: '미이행 주문 처리',
      playbookTexts: ['SAMBA WAVE(https://samba-wave.vercel.app)의 주문을 …']
    })
    expect(hosts).toContain('samba-wave.vercel.app')
  })
})

describe('SiteMemoryService', () => {
  it('성공 실행에서 호스트별 경로와 자동 메모를 남긴다', () => {
    const store = memoryStore()
    const svc = new SiteMemoryService(
      store,
      () => true,
      () => 100
    )
    svc.learn({
      prompt: '무신사에서 255 주문해 줘',
      calls: [
        call({ tool: 'get_page', label: '페이지 읽기' }),
        call({ label: '클릭: 구매하기 (#42)', result: 'ok (pressed Enter)' })
      ]
    })
    const entry = store.data['musinsa.com']
    expect(entry.recipes[0].steps).toEqual([
      { tool: 'click', label: '구매하기', urlPattern: '/products/123' }
    ])
    expect(entry.recipes[0].lastOkAt).toBe(100)
    expect(entry.notes).toEqual(["'구매하기' 는 Enter 로 열린다"])
  })

  it('기억이 꺼져 있으면 저장도 주입도 하지 않는다', () => {
    const store = memoryStore()
    const svc = new SiteMemoryService(store, () => false)
    svc.learn({ prompt: '무신사 주문', calls: [call()] })
    expect(store.data).toEqual({})
    expect(svc.blockFor({ prompt: '무신사 주문' }).text).toBe('')
  })

  it('아는 호스트의 기억만 블록으로 싣고 uses 를 올린다', () => {
    const store = memoryStore({
      'musinsa.com': {
        notes: ['메모 하나'],
        recipes: [{ goal: '주문', steps: [], createdAt: 1, uses: 2, lastOkAt: 1 }]
      }
    })
    const svc = new SiteMemoryService(store, () => true)
    const block = svc.blockFor({ prompt: '무신사에서 또 주문해 줘' })
    expect(block.hosts).toEqual(['musinsa.com'])
    expect(block.usedRecipe).toBe(true)
    expect(block.text).toContain('SITE MEMORY (musinsa.com)')
    expect(store.data['musinsa.com'].recipes[0].uses).toBe(3)
  })

  it('remember_site 는 마스킹 뒤에 저장한다', () => {
    const store = memoryStore()
    const svc = new SiteMemoryService(store, () => true)
    const r = svc.remember(
      'https://www.musinsa.com/mypage',
      '수령인 홍길동 010-1234-5678 주문번호 20240131001 은 그대로 둔다'
    )
    expect(r).toContain('musinsa.com')
    const note = store.data['musinsa.com'].notes[0]
    expect(note).not.toContain('홍길동')
    expect(note).not.toContain('1234')
    expect(note).not.toContain('20240131001')
  })

  it('호스트를 알 수 없거나 메모가 비면 거부한다', () => {
    const svc = new SiteMemoryService(memoryStore(), () => true)
    expect(svc.remember('  ', '메모')).toBe(REMEMBER_HOST_UNKNOWN)
    expect(svc.remember('musinsa.com', '   ')).toBe(REMEMBER_EMPTY_NOTE)
  })

  it('설정 화면 요약과 지우기', () => {
    const store = memoryStore({
      'musinsa.com': { notes: ['a'], recipes: [] },
      '29cm.co.kr': { notes: [], recipes: [] }
    })
    const svc = new SiteMemoryService(store, () => true)
    expect(svc.summary()).toEqual([
      { host: '29cm.co.kr', recipes: 0, notes: 0 },
      { host: 'musinsa.com', recipes: 0, notes: 1 }
    ])
    expect(svc.forget('www.musinsa.com')).toBe(true)
    expect(svc.forget('musinsa.com')).toBe(false)
    expect(Object.keys(store.data)).toEqual(['29cm.co.kr'])
  })
})

describe('설정 키', () => {
  it('기본은 켬', () => expect(DEFAULT_SETTINGS.siteMemoryEnabled).toBe(true))

  it('기기 로컬이라 동기화 대상이 아니다', () => {
    expect(SYNCED_SETTING_KEYS as readonly string[]).not.toContain('siteMemoryEnabled')
  })
})

describe('사이트 기억 i18n', () => {
  const keys = [
    'siteMemoryTitle',
    'siteMemory',
    'siteMemoryDesc',
    'siteMemoryEmpty',
    'siteMemoryCounts',
    'siteMemoryForget'
  ]

  it('ko/en 이 같은 키를 갖는다', () => {
    for (const key of keys) {
      expect(ko.settingsPage.agent).toHaveProperty(key)
      expect(en.settingsPage.agent).toHaveProperty(key)
    }
  })

  it('개수 문구는 양쪽 다 같은 자리 표시자를 쓴다', () => {
    for (const dict of [ko, en]) {
      expect(dict.settingsPage.agent.siteMemoryCounts).toContain('{{recipes}}')
      expect(dict.settingsPage.agent.siteMemoryCounts).toContain('{{notes}}')
    }
  })
})
