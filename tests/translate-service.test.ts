// 번역 엔진 — 프롬프트 JSON 왕복 파싱(가짜 provider) · 캐시 LRU · 서비스 동작

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildTranslatePrompt,
  parseTranslateReply,
  TRANSLATE_SYSTEM_PROMPT
} from '../src/main/translate/prompt'
import { TranslateCache, cacheKey } from '../src/main/translate/cache'
import {
  AiTranslator,
  NEEDS_AI_ERROR,
  TranslateService,
  clampSource,
  isValidBatch,
  type AskText
} from '../src/main/translate/service'
import {
  TRANSLATE_MAX_CHARS,
  TRANSLATE_MAX_NODES,
  TRANSLATE_MAX_TEXT
} from '../src/shared/translate'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samba-translate-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 받은 JSON 배열을 그대로 "[ko] 원문" 으로 바꿔 돌려주는 가짜 제공자 */
function fakeAsk(transform: (texts: string[]) => unknown = (t) => t.map((s) => `[번역]${s}`)): {
  ask: AskText
  calls: { model: string; prompt: string }[]
} {
  const calls: { model: string; prompt: string }[] = []
  const ask: AskText = async ({ model, prompt }) => {
    calls.push({ model, prompt })
    const slice = prompt.slice(prompt.indexOf('['))
    const texts = JSON.parse(slice) as string[]
    return `여기 있습니다:\n${JSON.stringify(transform(texts))}\n끝`
  }
  return { ask, calls }
}

describe('번역 프롬프트 JSON 왕복', () => {
  it('원문 배열이 JSON 한 덩어리로 실린다', () => {
    const prompt = buildTranslatePrompt(['hello', '월드'], 'ko')
    expect(prompt).toContain('Korean')
    expect(prompt).toContain('exactly 2')
    expect(prompt).toContain(JSON.stringify(['hello', '월드']))
    expect(TRANSLATE_SYSTEM_PROMPT).toContain('SAME order')
  })

  it('설명 문장·코드펜스가 섞여도 배열만 잘라 읽는다', () => {
    const parsed = parseTranslateReply('물론이죠:\n```json\n["안녕","세계"]\n```', 2)
    expect(parsed).toEqual(['안녕', '세계'])
  })

  it('개수가 다른 응답은 통째로 버린다(자리 밀림 방지)', () => {
    expect(parseTranslateReply('["하나"]', 2)).toBeNull()
    expect(parseTranslateReply('["하나","둘","셋"]', 2)).toBeNull()
  })

  it('배열이 아니거나 문자열이 아닌 원소가 있으면 버린다', () => {
    expect(parseTranslateReply('{"a":1}', 1)).toBeNull()
    expect(parseTranslateReply('[1,2]', 2)).toBeNull()
    expect(parseTranslateReply('설명만 있고 배열이 없음', 1)).toBeNull()
  })

  it('가짜 제공자와 왕복하면 같은 순서로 돌아온다', async () => {
    const { ask, calls } = fakeAsk()
    const translator = new AiTranslator({ ask, model: () => 'haiku' })
    const out = await translator.translate(['one', 'two', 'three'], 'ko')
    expect(out).toEqual(['[번역]one', '[번역]two', '[번역]three'])
    expect(calls[0].model).toBe('haiku')
  })

  it('개수가 어긋난 응답이면 오류를 던진다', async () => {
    const { ask } = fakeAsk((t) => t.slice(1))
    const translator = new AiTranslator({ ask, model: () => 'haiku' })
    await expect(translator.translate(['a', 'b'], 'ko')).rejects.toThrow('translate:bad-reply')
  })

  it('모델이 답하지 않으면 AI 연결 필요 오류가 된다', async () => {
    const translator = new AiTranslator({ ask: async () => null, model: () => 'haiku' })
    await expect(translator.translate(['a'], 'ko')).rejects.toThrow(NEEDS_AI_ERROR)
  })

  it('지나치게 긴 원문은 잘라서 보낸다', () => {
    expect(clampSource('가'.repeat(TRANSLATE_MAX_TEXT + 500)).length).toBe(TRANSLATE_MAX_TEXT)
    expect(clampSource('짧다')).toBe('짧다')
  })

  it('상한을 넘는 배치는 거절한다', () => {
    expect(isValidBatch([])).toBe(false)
    expect(isValidBatch(Array.from({ length: TRANSLATE_MAX_NODES + 1 }, () => 'a'))).toBe(false)
    expect(isValidBatch(['a', 'b'])).toBe(true)
    expect(isValidBatch(Array.from({ length: TRANSLATE_MAX_NODES }, () => 'a'))).toBe(true)
  })

  it('긴 문단 하나만 담긴 배치는 총량 규칙에서 빼 준다(잘라서 보내므로)', () => {
    expect(isValidBatch(['가'.repeat(TRANSLATE_MAX_CHARS * 4)])).toBe(true)
    expect(isValidBatch(['가'.repeat(TRANSLATE_MAX_CHARS * 2), '나'.repeat(10)])).toBe(false)
  })
})

describe('번역 캐시 LRU', () => {
  it('언어가 다르면 다른 열쇠를 쓴다', () => {
    expect(cacheKey('ko', 'hello')).not.toBe(cacheKey('ja', 'hello'))
    expect(cacheKey('ko', 'hello')).toBe(cacheKey('ko', 'hello'))
  })

  it('한도를 넘으면 가장 오래 안 쓴 것부터 버린다', () => {
    const cache = new TranslateCache(null, 3)
    cache.set('ko', 'a', '가')
    cache.set('ko', 'b', '나')
    cache.set('ko', 'c', '다')
    // a 를 다시 읽어 최근 사용으로 올린다 → 다음에 밀려나는 것은 b
    expect(cache.get('ko', 'a')).toBe('가')
    cache.set('ko', 'd', '라')
    expect(cache.size()).toBe(3)
    expect(cache.get('ko', 'b')).toBeUndefined()
    expect(cache.get('ko', 'a')).toBe('가')
    expect(cache.get('ko', 'd')).toBe('라')
  })

  it('같은 열쇠를 덮어써도 건수가 늘지 않는다', () => {
    const cache = new TranslateCache(null, 10)
    cache.set('ko', 'a', '가')
    cache.set('ko', 'a', '가2')
    expect(cache.size()).toBe(1)
    expect(cache.get('ko', 'a')).toBe('가2')
  })

  it('디스크에 내려쓰고 다시 읽는다', () => {
    const file = join(dir, 'cache.json')
    const cache = new TranslateCache(file, 100)
    cache.set('ko', 'hello', '안녕')
    cache.flush()
    expect(existsSync(file)).toBe(true)
    const reopened = new TranslateCache(file, 100)
    expect(reopened.get('ko', 'hello')).toBe('안녕')
  })

  it('setFile 은 쓰던 것을 먼저 내려쓰고 다른 프로필 캐시로 갈아 끼운다', () => {
    const first = join(dir, 'cache-ws1.json')
    const second = join(dir, 'cache-ws2.json')
    const cache = new TranslateCache(first, 100)
    cache.set('ko', 'hello', '안녕')

    cache.setFile(second)
    // 앞 작업공간의 번역문이 넘어오지 않는다
    expect(cache.get('ko', 'hello')).toBeUndefined()
    expect(cache.size()).toBe(0)
    // 갈아 끼우기 전에 내려썼으므로 앞 파일에는 남아 있다
    expect(existsSync(first)).toBe(true)

    cache.set('ko', 'hello', 'annyeong')
    cache.flush()
    cache.setFile(first)
    expect(cache.get('ko', 'hello')).toBe('안녕')
    cache.setFile(second)
    expect(cache.get('ko', 'hello')).toBe('annyeong')
  })

  it('같은 파일로 다시 setFile 하면 아무 일도 하지 않는다', () => {
    const file = join(dir, 'cache-same.json')
    const cache = new TranslateCache(file, 100)
    cache.set('ko', 'hello', '안녕')
    cache.setFile(file)
    expect(cache.get('ko', 'hello')).toBe('안녕')
  })

  it('불러올 때도 한도까지 줄인다', () => {
    const file = join(dir, 'cache.json')
    const big = new TranslateCache(file, 1000)
    for (let i = 0; i < 50; i++) big.set('ko', `t${i}`, `번역${i}`)
    big.flush()
    const small = new TranslateCache(file, 10)
    expect(small.size()).toBe(10)
  })

  it('캐시 지우기는 메모리와 파일을 모두 비운다', () => {
    const file = join(dir, 'cache.json')
    const cache = new TranslateCache(file, 100)
    cache.set('ko', 'hello', '안녕')
    cache.flush()
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(existsSync(file)).toBe(false)
  })
})

describe('TranslateService', () => {
  it('캐시에 있는 것은 엔진을 다시 부르지 않는다', async () => {
    const { ask, calls } = fakeAsk()
    const cache = new TranslateCache(null, 100)
    const service = new TranslateService({
      translator: () => new AiTranslator({ ask, model: () => 'haiku' }),
      cache
    })
    expect(await service.translate(['a', 'b'], 'ko')).toEqual(['[번역]a', '[번역]b'])
    expect(await service.translate(['a', 'b'], 'ko')).toEqual(['[번역]a', '[번역]b'])
    expect(calls).toHaveLength(1)
  })

  it('빠진 것만 골라 보내고 순서를 지켜 합친다', async () => {
    const { ask, calls } = fakeAsk()
    const cache = new TranslateCache(null, 100)
    cache.set('ko', 'b', '이미있음')
    const service = new TranslateService({
      translator: () => new AiTranslator({ ask, model: () => 'haiku' }),
      cache
    })
    expect(await service.translate(['a', 'b', 'c'], 'ko')).toEqual([
      '[번역]a',
      '이미있음',
      '[번역]c'
    ])
    expect(JSON.parse(calls[0].prompt.slice(calls[0].prompt.indexOf('[')))).toEqual(['a', 'c'])
  })

  it('같은 배치 안의 중복 원문은 한 번만 보낸다', async () => {
    const { ask, calls } = fakeAsk()
    const service = new TranslateService({
      translator: () => new AiTranslator({ ask, model: () => 'haiku' }),
      cache: new TranslateCache(null, 100)
    })
    expect(await service.translate(['a', 'b', 'a'], 'ko')).toEqual([
      '[번역]a',
      '[번역]b',
      '[번역]a'
    ])
    expect(JSON.parse(calls[0].prompt.slice(calls[0].prompt.indexOf('[')))).toEqual(['a', 'b'])
  })

  it('동시에 도는 배치가 같은 문장을 두 번 물어보지 않는다', async () => {
    const { ask, calls } = fakeAsk()
    const service = new TranslateService({
      translator: () => new AiTranslator({ ask, model: () => 'haiku' }),
      cache: new TranslateCache(null, 100)
    })
    // 첫 배치가 아직 답하기 전에 같은 문장이 들어 있는 두 번째 배치가 출발한다
    const [first, second] = await Promise.all([
      service.translate(['a', 'b'], 'ko'),
      service.translate(['b', 'c'], 'ko')
    ])
    expect(first).toEqual(['[번역]a', '[번역]b'])
    expect(second).toEqual(['[번역]b', '[번역]c'])
    // 'b' 는 한 번만 실려 나간다
    const sent = calls.map((c) => JSON.parse(c.prompt.slice(c.prompt.indexOf('['))) as string[])
    expect(sent.flat().filter((t) => t === 'b')).toHaveLength(1)
  })

  it('AI 연결이 없으면 호출 없이 안내 오류를 던진다', async () => {
    const service = new TranslateService({
      translator: () => null,
      cache: new TranslateCache(null, 100)
    })
    await expect(service.translate(['a'], 'ko')).rejects.toThrow(NEEDS_AI_ERROR)
  })
})
