import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  CODE_PROMPT,
  KEYPAD_PROMPT,
  parseKeypadResponse,
  readCodeFromImage,
  readKeypadLayout,
  type FetchLike,
  type VisualDeps
} from '../src/main/ai/visual'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SIZE = { width: 1080, height: 2400 }

interface FakeCall {
  url: string
  body: unknown
}

// 네트워크를 타지 않는 가짜 fetch. 호출 내역을 남겨 "부르지 않았다" 도 단언할 수 있게 한다
function fakeFetch(o: { status?: number; text?: string }): {
  fetch: FetchLike
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null })
    const status = o.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => o.text ?? ''
    }
  }
  return { fetch, calls }
}

// Anthropic Messages API 응답 모양(본문 텍스트 한 덩어리)
function modelReply(text: string): string {
  return JSON.stringify({ content: [{ type: 'text', text }] })
}

function deps(fetch: FetchLike, apiKey: string | null = 'sk-ant-test'): VisualDeps {
  return { fetch, apiKey: () => apiKey, model: () => 'claude-sonnet-5' }
}

// 0~9 전부가 든 정상 배치 응답
function fullLayoutJson(): string {
  const rows = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['', '0', '']
  ]
  const items: { d: string; x: number; y: number }[] = []
  rows.forEach((row, r) => {
    row.forEach((d, c) => {
      if (!d) return
      items.push({ d, x: 0.2 + c * 0.3, y: 0.6 + r * 0.1 })
    })
  })
  return JSON.stringify(items)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('프롬프트 상수', () => {
  it('CODE_PROMPT 는 화면에 보이는 인증번호만 묻고 값을 입력하라는 지시가 없다', () => {
    expect(CODE_PROMPT).toMatch(/인증번호/)
    expect(CODE_PROMPT).toMatch(/NONE/)
    expect(CODE_PROMPT).not.toMatch(/눌러|press|input|enter|입력하세요/i)
  })

  it('KEYPAD_PROMPT 는 배치만 묻고 어떤 숫자를 누를지 묻지 않는다', () => {
    expect(KEYPAD_PROMPT).toMatch(/위치/)
    expect(KEYPAD_PROMPT).not.toMatch(/눌러|press|input|enter/i)
  })

  it('KEYPAD_PROMPT 에는 비밀번호라는 낱말 자체가 없다', () => {
    expect(KEYPAD_PROMPT).not.toMatch(/비밀번호|password/i)
  })
})

describe('readCodeFromImage', () => {
  it('모델 답변에서 인증번호 숫자만 뽑는다', async () => {
    const { fetch } = fakeFetch({ text: modelReply('인증번호는 493028 입니다') })
    await expect(readCodeFromImage(deps(fetch), PNG)).resolves.toBe('493028')
  })

  it('숫자가 없으면 null', async () => {
    const { fetch } = fakeFetch({ text: modelReply('NONE') })
    await expect(readCodeFromImage(deps(fetch), PNG)).resolves.toBeNull()
  })

  it('4자리 미만 숫자만 있으면 null', async () => {
    const { fetch } = fakeFetch({ text: modelReply('화면에 123 만 보입니다') })
    await expect(readCodeFromImage(deps(fetch), PNG)).resolves.toBeNull()
  })

  it('API 키가 없으면 호출 없이 null', async () => {
    const { fetch, calls } = fakeFetch({ text: modelReply('493028') })
    await expect(readCodeFromImage(deps(fetch, null), PNG)).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('요청 본문에 png base64 와 CODE_PROMPT 가 실리고 모델은 주입값을 쓴다', async () => {
    const { fetch, calls } = fakeFetch({ text: modelReply('493028') })
    await readCodeFromImage(deps(fetch), PNG)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    const body = calls[0].body as {
      model: string
      messages: { content: { type: string; text?: string; source?: { data: string } }[] }[]
    }
    expect(body.model).toBe('claude-sonnet-5')
    const content = body.messages[0].content
    expect(content.find((c) => c.type === 'image')?.source?.data).toBe(PNG.toString('base64'))
    expect(content.find((c) => c.type === 'text')?.text).toBe(CODE_PROMPT)
  })

  it('응답이 200 이 아니면 null 이고 응답 본문을 로그에 남기지 않는다', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {})
    ]
    const { fetch } = fakeFetch({ status: 401, text: modelReply('493028') })
    await expect(readCodeFromImage(deps(fetch), PNG)).resolves.toBeNull()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('fetch 가 던져도 null 로 떨어진다', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('network down')
    }
    await expect(readCodeFromImage(deps(fetch), PNG)).resolves.toBeNull()
  })
})

describe('parseKeypadResponse', () => {
  it('0~1 비율 좌표를 화면 픽셀로 환산한다', () => {
    const layout = parseKeypadResponse('[{"d":"0","x":0.2,"y":0.8}]', SIZE)
    // 0~9 가 다 없으므로 배치로는 쓰지 않는다 — 환산 자체는 readKeypadLayout 테스트에서 확인
    expect(layout).toBeNull()
  })

  it('0~9 가 모두 있으면 픽셀 좌표를 돌려준다', () => {
    const layout = parseKeypadResponse(fullLayoutJson(), SIZE)
    expect(layout).not.toBeNull()
    expect(Object.keys(layout!.digits).sort()).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9'
    ])
    expect(layout!.digits['1']).toEqual({ x: Math.round(0.2 * 1080), y: Math.round(0.6 * 2400) })
    expect(layout!.digits['0']).toEqual({ x: Math.round(0.5 * 1080), y: Math.round(0.9 * 2400) })
  })

  it('설명 문장이 섞여 있어도 JSON 배열만 읽는다', () => {
    const text = `키패드 배치는 다음과 같습니다.\n${fullLayoutJson()}\n이상입니다.`
    expect(parseKeypadResponse(text, SIZE)).not.toBeNull()
  })

  it('코드펜스로 감싼 응답도 읽는다', () => {
    const text = '```json\n' + fullLayoutJson() + '\n```'
    expect(parseKeypadResponse(text, SIZE)).not.toBeNull()
  })

  it('0~9 중 하나라도 빠지면 null(부분 배치로는 누르지 않는다)', () => {
    const partial = JSON.parse(fullLayoutJson()) as { d: string }[]
    const text = JSON.stringify(partial.filter((i) => i.d !== '7'))
    expect(parseKeypadResponse(text, SIZE)).toBeNull()
  })

  it('좌표가 화면 밖이면 null', () => {
    const items = JSON.parse(fullLayoutJson()) as { d: string; x: number; y: number }[]
    items[0].x = 1.4
    expect(parseKeypadResponse(JSON.stringify(items), SIZE)).toBeNull()
    items[0].x = -0.1
    expect(parseKeypadResponse(JSON.stringify(items), SIZE)).toBeNull()
  })

  it('같은 숫자가 두 번 오면 null(어느 칸인지 확정할 수 없다)', () => {
    const items = JSON.parse(fullLayoutJson()) as { d: string }[]
    items[1].d = '1'
    expect(parseKeypadResponse(JSON.stringify(items), SIZE)).toBeNull()
  })

  it('모양이 어긋난 응답(JSON 아님·객체·숫자 아닌 좌표)은 null', () => {
    expect(parseKeypadResponse('미안하지만 알 수 없습니다', SIZE)).toBeNull()
    expect(parseKeypadResponse('{"d":"0","x":0.2,"y":0.8}', SIZE)).toBeNull()
    expect(parseKeypadResponse('[{"d":"0","x":"왼쪽","y":0.8}]', SIZE)).toBeNull()
  })

  it('화면 크기가 0 이하이면 null', () => {
    expect(parseKeypadResponse(fullLayoutJson(), { width: 0, height: 2400 })).toBeNull()
  })
})

describe('readKeypadLayout', () => {
  it('0~9 가 모두 있는 응답이면 배치를 돌려준다', async () => {
    const { fetch, calls } = fakeFetch({ text: modelReply(fullLayoutJson()) })
    const layout = await readKeypadLayout(deps(fetch), PNG, SIZE)
    expect(layout?.digits['5']).toEqual({ x: Math.round(0.5 * 1080), y: Math.round(0.7 * 2400) })
    const body = calls[0].body as { messages: { content: { type: string; text?: string }[] }[] }
    expect(body.messages[0].content.find((c) => c.type === 'text')?.text).toBe(KEYPAD_PROMPT)
  })

  it('부분 배치면 null', async () => {
    const partial = (JSON.parse(fullLayoutJson()) as { d: string }[]).filter((i) => i.d !== '3')
    const { fetch } = fakeFetch({ text: modelReply(JSON.stringify(partial)) })
    await expect(readKeypadLayout(deps(fetch), PNG, SIZE)).resolves.toBeNull()
  })

  it('API 키가 없으면 호출 없이 null', async () => {
    const { fetch, calls } = fakeFetch({ text: modelReply(fullLayoutJson()) })
    await expect(readKeypadLayout(deps(fetch, null), PNG, SIZE)).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('응답이 200 이 아니면 null 이고 로그를 남기지 않는다', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {})
    ]
    const { fetch } = fakeFetch({ status: 500, text: modelReply(fullLayoutJson()) })
    await expect(readKeypadLayout(deps(fetch), PNG, SIZE)).resolves.toBeNull()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})
