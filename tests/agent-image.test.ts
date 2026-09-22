// AI 창에 붙여 넣은 이미지 — IPC 검증과 SDK 입력 변환.

import { describe, it, expect } from 'vitest'
import {
  AGENT_IMAGE_MAX_BYTES,
  AGENT_IMAGE_MAX_COUNT,
  agentImageDataUrl,
  base64Bytes,
  parseAgentImages
} from '../src/shared/agent-image'
import { promptInputOf } from '../src/main/agent/provider'

const png = { mediaType: 'image/png', data: Buffer.from('hello').toString('base64') }

describe('parseAgentImages', () => {
  it('없으면 빈 배열, 올바른 목록은 그대로', () => {
    expect(parseAgentImages(undefined)).toEqual([])
    expect(parseAgentImages([png])).toEqual([png])
  })

  it('형식·본문·장수가 어긋나면 전체를 거절한다', () => {
    expect(parseAgentImages('x')).toBeNull()
    expect(parseAgentImages([{ mediaType: 'image/bmp', data: png.data }])).toBeNull()
    expect(parseAgentImages([{ mediaType: 'image/png', data: '' }])).toBeNull()
    expect(parseAgentImages([{ mediaType: 'image/png', data: 'not base64!' }])).toBeNull()
    expect(parseAgentImages([png, { mediaType: 'image/png' }])).toBeNull()
    expect(
      parseAgentImages(Array.from({ length: AGENT_IMAGE_MAX_COUNT + 1 }, () => png))
    ).toBeNull()
  })

  it('5MB 를 넘는 한 장은 거절한다', () => {
    const big = Buffer.alloc(AGENT_IMAGE_MAX_BYTES + 1).toString('base64')
    expect(base64Bytes(big)).toBe(AGENT_IMAGE_MAX_BYTES + 1)
    expect(parseAgentImages([{ mediaType: 'image/png', data: big }])).toBeNull()
    const ok = Buffer.alloc(AGENT_IMAGE_MAX_BYTES).toString('base64')
    expect(parseAgentImages([{ mediaType: 'image/png', data: ok }])).toHaveLength(1)
  })

  it('data URL 은 형식과 본문을 붙인다', () => {
    expect(agentImageDataUrl(png)).toBe(`data:image/png;base64,${png.data}`)
  })
})

describe('promptInputOf', () => {
  it('이미지가 없으면 문자열 그대로', () => {
    expect(promptInputOf('검색해')).toBe('검색해')
    expect(promptInputOf('검색해', [])).toBe('검색해')
  })

  it('이미지가 있으면 이미지 블록 뒤에 글을 붙인 사용자 메시지 한 건을 낸다', async () => {
    const input = promptInputOf('이 화면 읽어', [png, { mediaType: 'image/jpeg', data: png.data }])
    expect(typeof input).not.toBe('string')
    const messages = []
    for await (const m of input as AsyncIterable<unknown>) messages.push(m)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: png.data } },
          { type: 'text', text: '이 화면 읽어' }
        ]
      }
    })
  })
})
