import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, effortLine } from '../src/main/agent/prompt'
import { buildQueryOptions } from '../src/main/agent/provider'
import { AGENT_EFFORTS } from '../src/shared/settings'

describe('추론 강도 프롬프트 한 줄', () => {
  it('높음은 신중히, 낮음은 짧게', () => {
    expect(effortLine('high')).toMatch(/high — think carefully/)
    expect(effortLine('low')).toMatch(/low — be brief/)
    expect(effortLine('medium')).toMatch(/medium/)
  })

  it('모든 강도에 한 줄이 있다', () => {
    for (const e of AGENT_EFFORTS) expect(effortLine(e)).toMatch(/^Reasoning effort: /)
  })

  it('시스템 프롬프트에 권한 모드 바로 아래로 들어간다', () => {
    const prompt = buildSystemPrompt('ko', 'guard', 'high')
    expect(prompt).toContain(effortLine('high'))
    expect(prompt.indexOf('PERMISSION MODE')).toBeLessThan(prompt.indexOf('Reasoning effort'))
  })

  it('생략하면 보통이다(기존 호출부 하위 호환)', () => {
    expect(buildSystemPrompt('en', 'guard')).toContain(effortLine('medium'))
  })
})

describe('SDK 옵션 조립', () => {
  const base = {
    prompt: '네이버 열어 줘',
    systemPrompt: 'sys',
    model: 'sonnet',
    mcpServers: undefined,
    allowedTools: ['mcp__samba__get_page'],
    abort: new AbortController()
  }

  it('고른 강도를 SDK effort 옵션으로 넘긴다', () => {
    expect(buildQueryOptions({ ...base, effort: 'high' }).effort).toBe('high')
    expect(buildQueryOptions({ ...base, effort: 'low' }).effort).toBe('low')
  })

  it('강도를 주지 않으면 보통으로 넘긴다', () => {
    expect(buildQueryOptions(base).effort).toBe('medium')
  })

  it('기존 안전 옵션(내장 도구 차단·MCP 격리)은 그대로 유지된다', () => {
    const o = buildQueryOptions({ ...base, effort: 'medium' })
    expect(o.tools).toEqual([])
    expect(o.disallowedTools).toContain('Bash')
    expect(o.strictMcpConfig).toBe(true)
    expect(o.settingSources).toEqual([])
    expect(o.permissionMode).toBe('default')
    expect(o.model).toBe('sonnet')
  })
})
