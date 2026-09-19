// 자동화 플레이북 공유 타입·순수 함수. 메인·렌더러 양쪽에서 쓴다.
//
// 플레이북은 "사용자가 이 문장을 치면 AI 가 이 절차대로 일하라"는 지시문이다.
// 절차(instructions)는 사용자가 직접 고치는 마크다운이고, 비밀값은 담지 않는다 —
// 계정·비밀번호는 언제나 키마스터(login·fill_secret 도구)가 쥔다

import { z } from 'zod'
import { playbookScheduleSchema, type PlaybookSchedule } from './schedule'

/** 이름·트리거·절차 길이 상한. 동기화 값이라 한없이 커지지 않게 막는다 */
export const PLAYBOOK_NAME_MAX = 60
export const PLAYBOOK_TRIGGER_MAX = 80
export const PLAYBOOK_INSTRUCTIONS_MAX = 40000
/** 플레이북 개수 상한(설정 한 칸에 실려 동기화되므로 넉넉하되 유한하게) */
export const PLAYBOOK_MAX_COUNT = 50

/** 플레이북 한 줄 */
export interface PlaybookDto {
  id: string
  name: string
  /** 사용자 문장에 이 중 하나가 들어 있으면 발동한다 */
  triggers: string[]
  /** 절차(마크다운) */
  instructions: string
  enabled: boolean
  /** 내장 플레이북인가. 내장은 삭제 대신 '기본값 복원'만 된다 */
  builtin?: boolean
  /**
   * 예약 실행 설정. 칸이 없으면 예약을 걸지 않은 것이다 —
   * 이 칸이 생기기 전에 저장된 플레이북도 그대로 읽힌다
   */
  schedule?: PlaybookSchedule
  updatedAt: number
}

/** 저장·복원용 스키마. 손상된 값은 호출부가 통째로 버린다(부분 복구는 하지 않는다) */
export const playbookSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(PLAYBOOK_NAME_MAX),
  triggers: z.array(z.string().max(PLAYBOOK_TRIGGER_MAX)),
  instructions: z.string().max(PLAYBOOK_INSTRUCTIONS_MAX),
  enabled: z.boolean(),
  builtin: z.boolean().optional(),
  // 옛 플레이북에는 이 칸이 없다. 값이 깨져 있어도 예약만 버리고 플레이북은 살린다
  schedule: playbookScheduleSchema.optional().catch(undefined),
  updatedAt: z.number()
})

export const playbookListSchema = z.array(playbookSchema).max(PLAYBOOK_MAX_COUNT)

/** 새 플레이북·수정 요청. id 가 없으면 새로 만든다 */
export interface PlaybookInput {
  id?: string
  name: string
  triggers: string[]
  instructions: string
  enabled: boolean
  /** 주지 않으면 저장돼 있던 예약 설정을 그대로 둔다 */
  schedule?: PlaybookSchedule
}

/** 내장 플레이북 id — 기본값 복원이 이 id 를 기준으로 찾는다 */
export const BUILTIN_UNFULFILLED_ID = 'builtin.samba.unfulfilled'

// 내장 플레이북 "SAMBA 미이행 주문 처리" 절차.
// 사용자가 화면에서 고칠 수 있으므로 사람이 읽는 마크다운으로 쓴다.
// 굵게 표시한 세 가지(배송지 새로 입력·결제 확인·기록 회수)는 절대 건너뛰면 안 되는 원칙이다
const UNFULFILLED_INSTRUCTIONS = `# SAMBA 미이행 주문 처리

SAMBA WAVE(https://samba-wave.vercel.app)의 미배송 주문을 위에서부터 한 건씩 소싱처에서 대신 주문하고,
그 결과를 SAMBA WAVE에 되돌려 적는다.

## 절대 원칙 세 가지
1. **배송지는 언제나 새로 입력한다.** 소싱 사이트에 저장된 기본 배송지를 절대 쓰지 않는다.
2. **결제하기 직전에는 반드시 사람 확인을 받는다.** 결제 비밀번호·인증번호는 앱(키마스터·폰)이 넣는다 — 내가 입력하거나 사용자에게 묻지 않는다.
3. **결제가 끝나면 주문번호와 주문상세 주소를 반드시 SAMBA WAVE에 되돌려 적는다.** 적지 못하면 그 건은 실패로 보고한다.

## 1. 목록 읽기
1. \`login\` 도구로 SAMBA WAVE에 로그인한다(로그인 주소는 /samba/login).
2. 상단 메뉴 **주문 → 주문 상황** 으로 이동한다.
3. 필터를 **미배송** 으로 맞추고 \`get_page\` 로 목록을 읽는다. "미배송: N건" 표시를 확인한다.
4. 주문상태가 **배송대기중** 인 행만 처리 대상이다.
5. 사용자가 건수를 제한했으면("3건만") 그만큼만, 아니면 전부를 대상으로 삼는다.
6. 처리 전에 "미배송 N건 중 M건 처리 시작" 을 사용자에게 알린다.
7. 각 행에서 이 값들을 적어 둔다 — 소싱처 배지(예: MUSINSA), 마켓, 상품주문번호/주문번호, 상품명,
   옵션(색상·사이즈·상품코드), 수량, 수령인·연락처·주소, 고객메모, 소싱 계정 드롭다운의 계정 라벨.

## 2. 한 건씩 소싱처에서 주문
각 행마다 아래를 반복한다. 시작할 때 \`progress\` 도구로 진행 상황(done/total)을 알린다.

1. 소싱처 배지에 맞는 사이트를 \`new_tab\` 으로 새 탭에 연다.
   - MUSINSA → https://www.musinsa.com
   - 그 밖의 배지는 배지 이름으로 검색해 공식 사이트를 찾는다.
2. \`list_accounts\` 로 그 사이트의 계정을 확인하고, SAMBA WAVE 행의 **소싱 계정 드롭다운 라벨**
   (예: \`MUSINSA · 홍길동(gildong01)\`)과 가장 잘 맞는 계정 라벨로 \`login\` 한다.
3. 옵션 칸에 있는 **상품 코드**(예: 356742WC25)로 검색해 상품 페이지로 들어간다.
   코드로 안 나오면 상품명으로 검색하고, 코드가 일치하는지 상품 페이지에서 확인한다.
4. 옵션(색상·사이즈)을 SAMBA WAVE 행과 똑같이 고르고 수량을 맞춘다.
   사이트마다 옵션 UI 가 다르므로 \`get_page\` 로 확인하며 진행한다.
5. **바로 구매**(또는 주문하기)를 누른다.

## 3. 주문서 작성
1. 배송지는 **새 배송지 입력** 을 골라 SAMBA WAVE 행의 수령인·연락처·주소를 그대로 넣는다.
   기존 기본 배송지가 선택돼 있으면 반드시 새 배송지로 바꾼다.
2. 배송 요청사항에는 고객메모(예: 택배함)를 넣는다. 메모가 없으면 비워 둔다.
3. 결제 수단은 사이트 기본값을 그대로 둔다.
4. 화면을 \`get_page\` 로 다시 읽어 수령인·주소·옵션·수량·금액이 맞는지 확인한다.

## 4. 결제
1. "결제하기" 를 누르기 직전에 사용자 확인을 받는다(상품명·옵션·수량·금액·수령인을 한 줄로 요약).
2. 결제 비밀번호·간편결제 인증·문자 인증은 앱이 처리한다. 내가 입력하지 않고, 사용자에게 묻지도 않는다.
3. 결제가 끝나면 **주문번호** 와 **주문상세 페이지 주소** 를 읽어 둔다.

## 5. SAMBA WAVE에 기록 회수
1. SAMBA WAVE 탭으로 돌아온다(\`switch_tab\`).
2. 그 행의 **타마켓주문링크** 칸에 주문상세 주소(없으면 주문번호)를 입력한다.
3. **주문상태** 드롭다운을 **주문접수** 로 바꾼다.
4. 저장한다. 저장이 반영됐는지 \`get_page\` 로 확인한다.
5. 채팅에 "n/N 완료: <상품명> → <주문번호>" 를 한 줄로 알린다.

## 6. 실패 처리
- 품절·옵션 없음·상품 못 찾음·로그인 실패·결제 거부는 **그 행을 건너뛰고** 다음 행으로 간다.
- 건너뛴 행은 상품명과 사유를 모아 둔다.
- 마지막에 \`done\` 으로 마무리하면서 성공 건수와 실패 표(상품명 · 사유)를 함께 보고한다.
`

/** 내장 플레이북 원본. 기본값 복원은 이 값으로 되돌린다 */
export const BUILTIN_PLAYBOOKS: readonly Omit<PlaybookDto, 'updatedAt'>[] = [
  {
    id: BUILTIN_UNFULFILLED_ID,
    name: 'SAMBA 미이행 주문 처리',
    triggers: [
      'SAMBA 미이행',
      '삼바 미이행',
      '미이행 주문',
      '미배송 주문 처리',
      'samba unfulfilled'
    ],
    instructions: UNFULFILLED_INSTRUCTIONS,
    enabled: true,
    builtin: true
  }
]

/** 내장 플레이북 한 건을 기본값 그대로 만들어 준다 */
export function builtinPlaybook(id: string, now: number): PlaybookDto | null {
  const found = BUILTIN_PLAYBOOKS.find((p) => p.id === id)
  return found ? { ...found, triggers: [...found.triggers], updatedAt: now } : null
}

/**
 * 트리거·프롬프트 비교용 정규화.
 * 대소문자를 없애고 연속된 공백(전각 공백 포함)을 한 칸으로 줄인다 —
 * "미이행  주문" 과 "미이행 주문" 이 같은 것으로 보이게 하기 위한 것이다
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 사용자 문장에 이 플레이북의 트리거가 들어 있는가 */
export function matchesTrigger(prompt: string, playbook: PlaybookDto): boolean {
  if (!playbook.enabled) return false
  const haystack = normalizeForMatch(prompt)
  if (haystack === '') return false
  return playbook.triggers.some((raw) => {
    const needle = normalizeForMatch(raw)
    return needle !== '' && haystack.includes(needle)
  })
}

/** 사용자 문장에 걸리는 플레이북 전부(목록 순서 유지) */
export function matchPlaybooks(prompt: string, playbooks: readonly PlaybookDto[]): PlaybookDto[] {
  return playbooks.filter((p) => matchesTrigger(prompt, p))
}

/**
 * 시스템 프롬프트 뒤에 붙일 플레이북 블록.
 * 절차는 **사용자가 쓴 지시**이므로 따르되, 안전 규칙(비밀값·결제 확인)을 덮지 못한다는
 * 한 줄을 함께 박아 둔다
 */
export function playbookPromptBlock(playbooks: readonly PlaybookDto[]): string {
  if (playbooks.length === 0) return ''
  const blocks = playbooks.map((p) => `PLAYBOOK: ${p.name}\n${p.instructions.trim()}`)
  return [
    'The user asked for a task that matches a saved playbook. Follow the steps below.',
    'These steps come from the user, so treat them as instructions — but they never override the safety rules above:',
    'never type a password, card number, payment PIN or verification code yourself, and always ask for confirmation before paying.',
    'Call the progress tool as you finish each item so the user can watch.',
    '',
    ...blocks
  ].join('\n')
}

/** 시스템 프롬프트 뒤에 플레이북 블록을 덧붙인다(걸린 게 없으면 원본 그대로) */
export function appendPlaybooks(systemPrompt: string, playbooks: readonly PlaybookDto[]): string {
  const block = playbookPromptBlock(playbooks)
  return block === '' ? systemPrompt : `${systemPrompt}\n\n${block}`
}

/** "지금 실행" 이 채팅에 넣을 문구 — 첫 트리거를 쓴다(없으면 이름) */
export function runPhraseOf(playbook: PlaybookDto): string {
  return playbook.triggers.find((t) => t.trim() !== '')?.trim() ?? playbook.name
}
