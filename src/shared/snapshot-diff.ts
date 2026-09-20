// 스냅샷 직렬화 문자열의 라인 단위 diff(순수 함수).
//
// 페이지를 다시 읽을 때마다 전체 트리를 모델에게 보내면 토큰이 크게 낭비된다.
// 직전 읽기와 달라진 줄만 `@@ -a +b @@` 형식으로 추려 보낸다.

/** LCS 표를 만들 수 있는 최대 칸 수. 넘으면 블록 교체로 떨어뜨린다(100ms 예산) */
const LCS_CELL_BUDGET = 4_000_000

/** 변경 덩어리 사이에 이만큼 이하로 같은 줄이 끼면 한 덩어리로 묶는다 */
const HUNK_GAP = 2

type Op = { kind: 'same' | 'add' | 'del'; line: string }

/** 앞뒤로 같은 줄이 몇 개인지 센다 */
function commonEdges(a: string[], b: string[]): { head: number; tail: number } {
  const max = Math.min(a.length, b.length)
  let head = 0
  while (head < max && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  return { head, tail }
}

/** 두 줄 목록의 최장 공통 부분수열을 따라 연산 목록을 만든다 */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // table[i * (m + 1) + j] = a[i..], b[j..] 의 LCS 길이
  const table = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        a[i] === b[j]
          ? table[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
      ops.push({ kind: 'del', line: a[i] })
      i += 1
    } else {
      ops.push({ kind: 'add', line: b[j] })
      j += 1
    }
  }
  for (; i < n; i += 1) ops.push({ kind: 'del', line: a[i] })
  for (; j < m; j += 1) ops.push({ kind: 'add', line: b[j] })
  return ops
}

/** LCS 를 감당할 수 없을 만큼 크면 가운데를 통째로 교체한 것으로 본다 */
function blockOps(a: string[], b: string[]): Op[] {
  return [
    ...a.map((line): Op => ({ kind: 'del', line })),
    ...b.map((line): Op => ({ kind: 'add', line }))
  ]
}

/** 연산 목록을 덩어리(hunk)로 묶어 `@@ -a +b @@` 형식 문자열로 만든다 */
function formatHunks(ops: Op[], offset: number): string {
  const lines: string[] = []
  let oldLine = offset + 1
  let newLine = offset + 1
  let index = 0
  while (index < ops.length) {
    if (ops[index].kind === 'same') {
      oldLine += 1
      newLine += 1
      index += 1
      continue
    }
    // 덩어리 시작 — 같은 줄이 HUNK_GAP 개를 넘게 이어지면 끊는다
    const startOld = oldLine
    const startNew = newLine
    const body: string[] = []
    let gap = 0
    let cursor = index
    let lastChange = index
    while (cursor < ops.length && gap <= HUNK_GAP) {
      const op = ops[cursor]
      if (op.kind === 'same') {
        gap += 1
        oldLine += 1
        newLine += 1
      } else {
        gap = 0
        lastChange = cursor
        if (op.kind === 'del') {
          body.push(`-${op.line}`)
          oldLine += 1
        } else {
          body.push(`+${op.line}`)
          newLine += 1
        }
      }
      cursor += 1
    }
    // 덩어리 끝에 딸려 온 같은 줄들은 되돌린다(다음 덩어리가 다시 센다)
    for (let back = lastChange + 1; back < cursor; back += 1) {
      oldLine -= 1
      newLine -= 1
    }
    lines.push(`@@ -${startOld} +${startNew} @@`, ...body)
    index = lastChange + 1
  }
  return lines.join('\n')
}

/**
 * 두 문자열의 라인 diff. 같으면 빈 문자열을 돌려준다.
 * 추가된 줄은 `+`, 사라진 줄은 `-` 로 시작하고, 덩어리마다 `@@ -a +b @@` 머리글이 붙는다.
 */
export function diffLines(prev: string, next: string): string {
  if (prev === next) return ''
  const a = prev === '' ? [] : prev.split('\n')
  const b = next === '' ? [] : next.split('\n')
  const { head, tail } = commonEdges(a, b)
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const ops =
    midA.length * midB.length > LCS_CELL_BUDGET ? blockOps(midA, midB) : lcsOps(midA, midB)
  return formatHunks(ops, head)
}
