// 판정 리포트(md) 읽기 — 하네스의 GateResult.to_markdown 이 만든 표를 화면이 쓸 모양으로 바꾼다
import { describe, it, expect } from 'vitest'
import { GATE_RULES, parseGateReport } from '../src/shared/harness'

// samba-agent/src/samba_agent/ops/gate.py 의 GateResult.to_markdown 출력과 같은 모양
const REPORT = `# 판정 — v2026.09.22-ab12cd: **improve**

| 조건 | 결과 |
|---|---|
| observe | 통과 |
| accuracy | 미달 |
| regression | 통과 |
| dry_run | 통과 |
| review_queue | 통과 |
| approval | 미달 |

## 다음 할 일
- 데이터셋이 10건 미만이거나 비어 있다
- 사용자 승인이 없다(@삼바 승인 <버전> 또는 --approve)
`

describe('parseGateReport', () => {
  it('버전·판정·여섯 조건·다음 할 일을 읽는다', () => {
    const r = parseGateReport(REPORT)
    expect(r.version).toBe('v2026.09.22-ab12cd')
    expect(r.verdict).toBe('improve')
    expect(r.checks).toEqual({
      observe: true,
      accuracy: false,
      regression: true,
      dry_run: true,
      review_queue: true,
      approval: false
    })
    expect(r.reasons).toHaveLength(2)
    expect(r.reasons[0]).toContain('데이터셋')
  })

  it('promote 도 읽는다', () => {
    const r = parseGateReport(
      '# 판정 — v1: **promote**\n\n| 조건 | 결과 |\n|---|---|\n| observe | 통과 |\n'
    )
    expect(r.verdict).toBe('promote')
    expect(r.checks.observe).toBe(true)
    // 표에 없는 조건은 모름(null) — "통과"로 오해하지 않는다
    expect(r.checks.approval).toBeNull()
  })

  it('빈 글·엉뚱한 글이면 판정을 모른다고 답한다', () => {
    const r = parseGateReport('아직 판정 파일이 없습니다')
    expect(r.verdict).toBeNull()
    expect(r.version).toBe('')
    expect(Object.keys(r.checks).sort()).toEqual([...GATE_RULES].sort())
    for (const rule of GATE_RULES) expect(r.checks[rule]).toBeNull()
    expect(r.reasons).toEqual([])
  })
})
