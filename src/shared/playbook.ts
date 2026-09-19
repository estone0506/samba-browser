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

SAMBA WAVE(https://samba-wave.vercel.app)의 미처리 판매 주문을 한 건씩 소싱처에서 대신 주문하고,
소싱주문번호·원가를 SAMBA WAVE에 되돌려 적고 저장을 검증한다.
(계정·사무실 주소·마진 기준 같은 내 값은 이 플레이북을 복사해 채우거나 채팅으로 알려 준다.)

## 절대 원칙
1. **결제하기 직전에는 반드시 사람 확인을 받는다.** 상품명·옵션·수량·금액·수령인을 한 줄로 요약해 묻는다.
2. **결제 비밀번호·PIN은 절대 내가 누르거나 타이핑하지 않는다.** 결제 비밀번호 화면에 도달하면
   \`fill_secret\`(itemType "password", provider: 사이트 자체 결제=site, 네이버페이=naver, 페이코=payco,
   토스페이=toss, 카카오페이=kakao)를 부른다. 앱이 넣지 못하면 사람에게 넘어간다 — 기다린다.
   키패드 화면에서 click/type/screenshot/ocr 은 거부되며 그것은 오류가 아니다.
3. 캡차·추가 본인인증은 풀지 않고 그 단계만 사용자에게 넘긴다. 비밀값은 어디에도 적지 않는다.
4. 결제가 끝나면 주문번호·원가를 반드시 SAMBA WAVE에 되돌려 적는다. 적지 못하면 실패로 보고한다.

## 도구 규칙
- 로그인은 \`list_accounts\` → \`login\`(키마스터). 아이디·비밀번호를 내가 타이핑하지 않는다.
- 요소가 목록에 없으면 \`find_elements\` 로 찾는다('255', '장바구니', '결제하기'). 팝업 결제창은 앱이
  새 창으로 열어 주니 \`list_tabs\` 로 찾아 \`switch_tab\` 한다. 팝업이 안 보이면 결제하기를 반복하지 않는다.
- 입력은 클릭 → \`type\` → Enter/Tab. 진행 중 \`progress\`, 끝나면 \`done\` 으로 보고한다.

## 1. 대상 선정
1. \`login\` 으로 SAMBA WAVE에 로그인(/samba/login)하고 주문 목록(/samba/orders)을 연다.
2. 사이트 필터로 **주문상태 = 주문접수**(또는 사용자가 말한 상태)와 소싱처를 맞추고 모든 페이지를 읽는다.
3. 제외: 소싱주문번호 있음, 취소/반품/교환, 가격X/재고X, 구매보류, 다른 작업자 처리중.
   결제됐는데 기록만 빠진 건은 기록 보완이 우선이다.
4. 행 번호가 아니라 **상품주문번호**로 식별한다. 새로고침·필터 변경 뒤 첫 행이 바뀔 수 있다.
5. 원문링크의 상품과 판매 주문의 품번·색상·옵션·수량을 대조한다. 불명확하면 보류한다.
6. 처리 전에 "대상 N건 중 M건 처리 시작" 을 알리고, 최신순으로 한 건씩 진행한다.

## 2. 재고 판정
- 재고X는 **정확한 요청 옵션에 품절·판매종료가 명시된 경우만**. 다른 옵션·추천상품 품절은 근거가 아니다.
- 구매 패널·옵션이 목록에 안 보이는 것은 품절이 아니다. \`find_elements\`·스크롤·\`screenshot\`·새로고침으로
  실제 옵션 목록을 확인한다. 확인 불가는 '재고 확인 불가'로 보류한다.

## 3. 계정·혜택 비교와 원가
- 사용자가 비교 계정을 정해 두었으면 같은 상품·옵션·수량·배송 조건의 **실제 주문서**를 계정별로 만들어
  쿠폰·등급할인·적립금 사용·선할인·신규 적립·배송비·결제수단별 최종 원가를 비교한다. 상품 페이지 예상가로 대체하지 않는다.
- 원가 = 실제 결제액 − 후기 제외 신규 적립 + 사용한 기존 적립금 + 결제액에 포함되지 않은 배송비.
  선할인은 결제액에 이미 반영됐으니 다시 빼지 않는다. 카드 할인율은 사용자가 확인한 값만 적용한다.
- 마진율 = (SAMBA 정산금 − 최종 원가) ÷ SAMBA 매출 × 100. 사용자가 정한 기준 미만이면 구매하지 않고
  간단메모에 \`관리자 금액확인필요\` 만 남긴다. 마진 미달 건에 가격X를 누르지 않는다.
- 잔액 부족은 충전·상품권 등록으로 해결하지 않는다(별도 승인). 비교 중에는 결제하지 않는다.

## 4. 주문서
1. 옵션(색상·사이즈)을 판매 주문과 똑같이 고르고 수량을 맞춘다. 추천상품·부가서비스를 붙이지 않는다.
2. 배송지: 사용자가 사무실 수령(까대기)을 정해 두었으면 그 기본 배송지를 유지하고 수정하지 않는다.
   아니면 **새 배송지 입력** 으로 판매 주문의 수령인·연락처·주소를 그대로 넣는다.
3. 배송 요청사항에는 고객메모를 넣는다. 화면을 다시 읽어 수령인·주소·옵션·수량·금액을 확인한다.

## 5. 결제 직전과 완료
1. SAMBA WAVE를 다시 조회해 같은 상품주문번호의 상태·소싱주문번호·다른 작업자 처리 여부를 재확인한다.
2. 최종 로그인 계정, 품목/옵션/수량, 쿠폰·적립·결제액, 배송지, 결제수단을 검증하고 사람 확인을 받는다.
3. 팝업 종료·잔액 감소만으로 성공을 보고하지 않는다. 소싱처 주문 상세에서 결제상태·주문번호·품목·옵션·수량·
   배송지·금액을 검증한다. 불명확하면 주문내역을 먼저 확인하고 재결제하지 않는다.
4. 누가 결제했는지(사용자/에이전트)를 구분해 보고한다.

## 6. SAMBA WAVE 기록과 검증
1. 그 행에서 **실제 구매 계정** 선택 → 저장 확인.
2. **소싱주문번호**를 화면 표시값 그대로 입력하고 입력을 끝낸다.
3. **배송비·간단메모**를 한 필드씩 저장한다(구매 완료 건은 계정·수단·실결제액·원가 한두 줄, 기존 메모 보존).
4. **실구매가**에 최종 원가를 숫자로 넣고 Enter/Tab 으로 확정한다. 원가는 마지막에 저장한다.
5. 사용자가 정한 플래그(예: 까대기)가 있으면 누른다. 미발급 송장번호를 만들지 않는다.
6. 새로고침 후 같은 상품주문번호를 재검색해 모든 칸이 유지되는지 확인하고 누락만 보완한다.
   각 필드는 독립 저장이라 메모 저장 성공이 원가 저장을 보증하지 않는다.
7. 채팅에 "n/N 완료: <상품명> → <주문번호>" 를 한 줄로 알린다.

## 7. 실패·회복
- 품절·옵션 없음·상품 못 찾음·로그인 실패·결제 거부·마진 미달은 그 행을 건너뛰고 사유를 모아 둔다.
- 탭이 응답하지 않으면 새 탭으로 다시 열고 로그인 상태부터 확인한다. '결제진행중' 으로 멈춘 주문서는 결제되지 않은 것이다.
- 마지막에 \`done\` 으로 대상/완료/보류/가격X/재고X/미처리 수와 실패 표(상품명 · 사유)를 보고한다.
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
