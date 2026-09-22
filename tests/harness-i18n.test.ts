// 처리 흐름·판정 카드 문구 — ko·en 키가 같고, 자리표시자도 같다
import { describe, it, expect } from 'vitest'
import ko from '../src/renderer/src/i18n/ko.json'
import en from '../src/renderer/src/i18n/en.json'
import { GATE_RULES, HARNESS_STAGES } from '../src/shared/harness'

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value }
  if (value === null || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flatten(child, prefix === '' ? key : `${prefix}.${key}`))
  }
  return out
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
}

const koFlat = flatten((ko as Record<string, unknown>).automation)
const enFlat = flatten((en as Record<string, unknown>).automation)

describe('하네스 화면 문구', () => {
  it('automation 아래 ko·en 키가 같다', () => {
    expect(Object.keys(enFlat).sort()).toEqual(Object.keys(koFlat).sort())
  })

  it('빈 문구가 없고 자리표시자가 같다', () => {
    for (const key of Object.keys(koFlat)) {
      expect(koFlat[key].trim(), key).not.toBe('')
      expect(enFlat[key].trim(), key).not.toBe('')
      expect(placeholders(enFlat[key]), key).toEqual(placeholders(koFlat[key]))
    }
  })

  it('단계·판정 조건 문구가 코드의 값과 하나씩 짝을 이룬다', () => {
    for (const stage of HARNESS_STAGES) {
      expect(koFlat[`harness.stage.${stage}`], stage).toBeTypeOf('string')
      expect(enFlat[`harness.stage.${stage}`], stage).toBeTypeOf('string')
    }
    for (const rule of GATE_RULES) {
      expect(koFlat[`harness.verdict.rule.${rule}`], rule).toBeTypeOf('string')
      expect(enFlat[`harness.verdict.rule.${rule}`], rule).toBeTypeOf('string')
    }
  })

  it('en 문구에는 한글이 없다', () => {
    for (const [key, text] of Object.entries(enFlat)) {
      expect(text, key).not.toMatch(/[가-힣]/)
    }
  })
})
