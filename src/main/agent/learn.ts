// 자동 학습 — 실행이 끝나면 그 실행에서 통한 run_js 코드를 모아 AI 에게 되돌려 주고,
// 다음부터 run_script 한 번으로 재생할 스크립트로 저장하게 한다.
//
// 왜 필요한가
//  - 모델에게 "통하면 save_script 로 저장하라"고만 해 두면 실제로는 저장하지 않는다(실기: 수십 회 실행에 0건).
//    실행 중에는 눈앞의 주문을 끝내는 데 집중하고, 그때 쓴 코드는 요소 번호가 박혀 있어 그대로는 다시 못 쓴다.
//  - 그래서 학습을 실행기가 강제한다: 실행이 끝난 직후 별도 턴으로, 통한 코드 전문과 눌렀던 요소의 글자를 주고
//    "글자로 찾는 재생용 스크립트로 바꿔 저장하라"고 시킨다. 사람이 시키지 않아도 매 실행 뒤에 돈다.
//  - 실패로 끝난 실행도 배운다 — 성공한 구간까지는 다음에 그대로 재생할 수 있어야 한다.

/** 학습 턴의 지시문 머리. 이 머리로 시작하는 실행은 다시 학습을 부르지 않는다 */
export const LEARN_PROMPT_PREFIX = '[자동 학습]'

/** 통한 run_js 가 이만큼은 있어야 배울 거리가 있다고 본다 */
export const LEARN_MIN_SNIPPETS = 2
const LEARN_MAX_SNIPPETS = 16
const LEARN_SNIPPET_MAX = 1400
const LEARN_STEPS_MAX = 60

export interface LearnedRunJs {
  code: string
  ok: boolean
  url: string
  /** 코드 안에서 번호로 누른 요소: "번호=글자" */
  clicked: string[]
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function shouldLearn(prompt: string, runs: readonly LearnedRunJs[]): boolean {
  if (prompt.startsWith(LEARN_PROMPT_PREFIX)) return false
  return runs.filter((r) => r.ok).length >= LEARN_MIN_SNIPPETS
}

/** 학습 턴에 줄 지시문을 만든다(순수 함수) */
export function buildLearnPrompt(input: {
  userPrompt: string
  runs: readonly LearnedRunJs[]
  steps: readonly { label: string; ok: boolean }[]
  savedScripts: readonly { name: string; description: string }[]
}): string {
  const snippets = input.runs
    .filter((r) => r.ok)
    .slice(-LEARN_MAX_SNIPPETS)
    .map((r, i) => {
      const code =
        r.code.length > LEARN_SNIPPET_MAX ? `${r.code.slice(0, LEARN_SNIPPET_MAX)}\n// …(잘림)` : r.code
      const clicked = r.clicked.length > 0 ? `\n// 번호로 누른 요소의 글자: ${r.clicked.join(', ')}` : ''
      return `--- #${i + 1} (${hostOf(r.url)})${clicked}\n${code}`
    })
    .join('\n\n')
  const steps = input.steps
    .slice(0, LEARN_STEPS_MAX)
    .map((st) => `${st.ok ? '✓' : '✗'} ${st.label}`)
    .join('\n')
  const saved =
    input.savedScripts.length === 0
      ? '(없음)'
      : input.savedScripts.map((sc) => `- ${sc.name}: ${sc.description}`).join('\n')
  return [
    `${LEARN_PROMPT_PREFIX} 방금 끝난 작업에서 통한 절차를 다음부터 run_script 한 번으로 재생할 수 있게 저장해.`,
    '',
    `방금 작업의 지시문: ${input.userPrompt.slice(0, 300)}`,
    '',
    '규칙',
    '- 아래 "통한 코드"를 구간별로 묶어(예: 목록에서 주문 찾기 / 상품 옵션 고르고 주문서 열기 / 배송지 고르기 / 결제수단 고르고 금액 읽기 / 기록 입력) 구간마다 스크립트 하나로 만들어 save_script 로 저장한다.',
    '- 요소 번호(page.click(47) 같은 숫자)는 페이지를 읽을 때마다 바뀐다. 스크립트 안에서는 반드시 글자로 찾는다: page.clickText("구매하기"), page.idOf("수정", 1), page.get({ selector }). 위 "번호로 누른 요소의 글자"를 보고 바꿔 쓴다.',
    '- 주문마다 달라지는 값(주문번호·옵션·금액·이름)은 코드에 박지 말고 args 로 받는다. 결과는 작은 JSON 으로 return 한다.',
    '- 같은 일을 하는 스크립트가 이미 있으면 같은 이름으로 고쳐 저장한다(이번에 그 스크립트가 안 통해 직접 했다면 특히).',
    '- 판단(마진·결제수단 선택), 비밀값 입력, 폰 승인은 스크립트에 넣지 않는다. 실패한 시도(✗)는 배우지 않는다.',
    '- **지금은 저장만 한다.** 주문·결제·취소·기록 저장 버튼은 누르지 않고, 새 주문서를 만들지도 않는다. 열려 있는 페이지를 읽기만 하는 스크립트(목록 검색·행 읽기)만 run_script 로 한 번 돌려 확인해도 된다.',
    '- 끝나면 저장한 스크립트 이름과 각각이 몇 단계를 줄이는지만 짧게 done 으로 보고한다.',
    '',
    '이미 저장된 스크립트',
    saved,
    '',
    '방금 작업의 단계 기록',
    steps || '(없음)',
    '',
    '통한 코드',
    snippets
  ].join('\n')
}
