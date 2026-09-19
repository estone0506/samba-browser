import { describe, it, expect } from 'vitest'
import { maskSecrets, summarize, PROMPT_LIMIT, TEXT_LIMIT } from '../src/shared/notify'
import { buildNotifyMessage, buildTestMessage, NOTIFY_PREFIX } from '../src/main/notify/message'

describe('비밀값 마스킹', () => {
  it('키워드 뒤에 붙은 값을 지운다', () => {
    expect(maskSecrets('쿠팡 비밀번호: hunter2 로 로그인해 줘')).toBe(
      '쿠팡 비밀번호 *** 로 로그인해 줘'
    )
    expect(maskSecrets('pw=abcdefg')).toBe('pw ***')
    expect(maskSecrets('token abcdefg')).toBe('token ***')
  })

  it('이어진 긴 숫자열(인증번호·카드번호)을 지운다', () => {
    expect(maskSecrets('인증번호 483927 입력')).toBe('인증번호 *** 입력')
    expect(maskSecrets('카드 4111111111111111')).toBe('카드 ***')
  })

  it('짧은 숫자(수량·가격 앞자리)는 그대로 둔다', () => {
    expect(maskSecrets('3개 담아 줘')).toBe('3개 담아 줘')
    expect(maskSecrets('12345 원')).toBe('12345 원')
  })

  it('뒤따르는 말이 한글뿐이면 설명으로 보고 남겨 둔다', () => {
    // 비밀값에는 영문·숫자·기호가 반드시 섞인다. 설명까지 지우면 알림이 쓸모없어진다
    expect(maskSecrets('결제 비밀번호 키패드')).toBe('결제 비밀번호 키패드')
    expect(maskSecrets('비밀번호 abc가')).toBe('비밀번호 ***')
  })

  it('합성어·단어 속 키워드는 건드리지 않는다', () => {
    expect(maskSecrets('암호화폐 시세 알려 줘')).toBe('암호화폐 시세 알려 줘')
    expect(maskSecrets('pwd 명령 실행')).toBe('pwd 명령 실행')
  })
})

describe('요약 자르기', () => {
  it('마스킹을 먼저 하고 자른다 — 잘린 자리에 비밀값이 남지 않는다', () => {
    const long = `비밀번호 ${'s'.repeat(300)} 로 로그인`
    const out = summarize(long, TEXT_LIMIT)
    expect(out).not.toContain('ssss')
    expect(out.startsWith('비밀번호 ***')).toBe(true)
  })

  it('줄바꿈·연속 공백을 한 칸으로 줄인다', () => {
    expect(summarize('한\n\n  줄로', 80)).toBe('한 줄로')
  })

  it('상한을 넘으면 말줄임표를 붙인다', () => {
    const out = summarize('가'.repeat(200), PROMPT_LIMIT)
    expect(out).toHaveLength(PROMPT_LIMIT + 1)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('알림 메시지 조립', () => {
  it('완료는 작업 요약과 결과 한 줄을 담는다', () => {
    const msg = buildNotifyMessage({
      event: 'done',
      prompt: '쿠팡에서 생수 주문해 줘',
      text: '장바구니에 담고 결제까지 끝냈어요',
      lang: 'ko'
    })
    expect(msg).toBe(
      [
        `${NOTIFY_PREFIX} 작업 완료`,
        '작업: 쿠팡에서 생수 주문해 줘',
        '결과: 장바구니에 담고 결제까지 끝냈어요'
      ].join('\n')
    )
  })

  it('실패는 이유 줄이 더 붙는다', () => {
    const msg = buildNotifyMessage({
      event: 'failed',
      prompt: '로그인해 줘',
      text: '',
      reason: 'auth:missing',
      lang: 'ko'
    })
    expect(msg).toContain('작업 실패')
    expect(msg).toContain('이유: auth:missing')
  })

  it('확인 필요는 무엇을 확인해야 하는지만 담는다', () => {
    const msg = buildNotifyMessage({
      event: 'attention',
      prompt: '페이코로 결제해 줘',
      reason: '결제 비밀번호 키패드',
      lang: 'ko'
    })
    expect(msg.split('\n')).toEqual([
      `${NOTIFY_PREFIX} 확인 필요`,
      '작업: 페이코로 결제해 줘',
      '확인: 결제 비밀번호 키패드'
    ])
  })

  it('지시문에 든 비밀번호는 메시지에 실리지 않는다', () => {
    const msg = buildNotifyMessage({
      event: 'done',
      prompt: '아이디 me, 비밀번호 hunter2 로 로그인해 줘',
      text: '인증번호 483927 를 넣었어요',
      lang: 'ko'
    })
    expect(msg).not.toContain('hunter2')
    expect(msg).not.toContain('483927')
  })

  it('빈 값이면 그 줄 자체를 넣지 않는다', () => {
    expect(buildNotifyMessage({ event: 'done', prompt: '', lang: 'ko' })).toBe(
      `${NOTIFY_PREFIX} 작업 완료`
    )
  })

  it('영어 설정이면 영어로 만든다', () => {
    const msg = buildNotifyMessage({ event: 'done', prompt: 'buy water', text: 'ok', lang: 'en' })
    expect(msg).toContain('Task done')
    expect(msg).toContain('Result: ok')
  })

  it('테스트 메시지에도 꼬리표가 붙는다', () => {
    expect(buildTestMessage('ko').startsWith(NOTIFY_PREFIX)).toBe(true)
    expect(buildTestMessage('en').startsWith(NOTIFY_PREFIX)).toBe(true)
  })
})
