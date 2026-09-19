// 문자 인증번호 추출·점수·폴링 테스트.
// adb 는 가짜 구현(FakeAdb)만 쓰고 실제 프로세스를 절대 띄우지 않는다

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseSmsQuery,
  parseNotificationSms,
  isQueryBlocked,
  extractCodes,
  brandToken,
  scoreRow,
  pickAuthCode,
  watchSms,
  SMS_QUERY_ARGS,
  NOTIFICATION_DUMP_ARGS,
  type SmsRow
} from '../src/main/phone/sms'
import { AUTH_TIMEOUT_MS, SMS_POLL_INTERVAL_MS, SMS_RECENT_MS } from '../src/shared/phone'
import { FakeAdb } from './stubs/fake-adb'

const INBOX = readFileSync(resolve(__dirname, 'fixtures/sms-inbox.txt'), 'utf8')
const NOTIFICATIONS = readFileSync(resolve(__dirname, 'fixtures/sms-notification.txt'), 'utf8')
// 픽스처의 가장 최근 문자 시각
const NOW = 1758200000000

describe('parseSmsQuery', () => {
  it('content query 한 줄을 주소·본문·시각으로 나눈다', () => {
    const rows = parseSmsQuery(INBOX)
    expect(rows.length).toBe(4)
    expect(rows[0]).toEqual({
      address: '15881234',
      body: '[Web발신] 인증번호 [493028] 입력',
      dateMs: 1758200000000
    })
  })

  it('본문에 쉼표가 있어도 date= 앞까지를 본문으로 본다', () => {
    const rows = parseSmsQuery(INBOX)
    expect(rows[1].body).toBe('[TOSS] 인증번호는 285193 입니다, 타인에게 알려주지 마세요')
    expect(rows[1].dateMs).toBe(1758199970000)
  })

  it('Permission Denial 출력이면 빈 배열', () => {
    const denied =
      'Error while accessing provider:sms\njava.lang.SecurityException: Permission Denial: opening provider'
    expect(parseSmsQuery(denied)).toEqual([])
  })

  it('행이 하나도 없는 출력도 빈 배열', () => {
    expect(parseSmsQuery('No result found.')).toEqual([])
  })
})

describe('isQueryBlocked', () => {
  it('종료 코드가 0 이 아니거나 권한 거부 문구가 있으면 막힌 것으로 본다', () => {
    expect(isQueryBlocked({ code: 1, stdout: '', stderr: '' })).toBe(true)
    expect(isQueryBlocked({ code: 0, stdout: 'Permission Denial', stderr: '' })).toBe(true)
    expect(isQueryBlocked({ code: 0, stdout: '', stderr: 'SecurityException' })).toBe(true)
    expect(isQueryBlocked({ code: 0, stdout: INBOX, stderr: '' })).toBe(false)
  })
})

describe('extractCodes', () => {
  it('4~8자리 숫자만 뽑는다', () => {
    expect(extractCodes('인증번호 493028 입력')).toEqual(['493028'])
    expect(extractCodes('코드 12 는 짧고 123 도 짧다')).toEqual([])
  })

  it('전화번호(10자리 이상)와 하이픈 번호는 제외한다', () => {
    expect(extractCodes('문의 01012345678 로 연락')).toEqual([])
    expect(extractCodes('문의 010-1234-5678 로 연락')).toEqual([])
  })

  it('금액으로 보이는 숫자는 제외한다', () => {
    expect(extractCodes('12000원 할인')).toEqual([])
    expect(extractCodes('₩45000 결제')).toEqual([])
  })

  it('주문번호·운송장번호는 제외한다', () => {
    expect(extractCodes('주문번호 20240513 배송 시작')).toEqual([])
    expect(extractCodes('운송장번호: 55667788')).toEqual([])
  })
})

describe('brandToken', () => {
  it('host 의 첫 라벨을 브랜드 토큰으로 본다', () => {
    expect(brandToken('toss.im')).toBe('toss')
    expect(brandToken('www.payco.com')).toBe('payco')
    expect(brandToken('m.naver.com')).toBe('naver')
    expect(brandToken('')).toBe('')
  })
})

describe('scoreRow', () => {
  const ctx = { now: NOW, siteHost: 'toss.im' }

  it('3분 지난 문자는 버린다', () => {
    const old: SmsRow = {
      address: '15881234',
      body: '인증번호 493028',
      dateMs: NOW - SMS_RECENT_MS - 1
    }
    expect(scoreRow(old, ctx)).toBeNull()
    expect(scoreRow({ ...old, dateMs: NOW - 1000 }, ctx)).not.toBeNull()
  })

  it('숫자가 없는 문자는 후보가 아니다', () => {
    expect(scoreRow({ address: '15881234', body: '배송 완료', dateMs: NOW }, ctx)).toBeNull()
  })

  it('사이트 브랜드 토큰이 본문에 있으면 점수가 높다', () => {
    const withBrand = scoreRow(
      { address: '15881234', body: '[TOSS] 인증번호 285193', dateMs: NOW },
      ctx
    )
    const without = scoreRow(
      { address: '15881234', body: '[국민] 인증번호 285193', dateMs: NOW },
      ctx
    )
    expect(withBrand?.score ?? 0).toBeGreaterThan(without?.score ?? 0)
  })

  it('인증 문구가 있으면 가점을 준다', () => {
    const plain = scoreRow({ address: '15881234', body: '숫자 493028', dateMs: NOW }, ctx)
    const ko = scoreRow({ address: '15881234', body: '인증번호 493028', dateMs: NOW }, ctx)
    const en = scoreRow({ address: '15881234', body: 'verification code 493028', dateMs: NOW }, ctx)
    expect(ko?.score ?? 0).toBeGreaterThan(plain?.score ?? 0)
    expect(en?.score ?? 0).toBeGreaterThan(plain?.score ?? 0)
  })

  it('발신번호는 뒷 4자리만 남긴다', () => {
    const c = scoreRow({ address: '01055667788', body: '인증번호 493028', dateMs: NOW }, ctx)
    expect(c?.senderTail).toBe('7788')
  })
})

describe('pickAuthCode', () => {
  const ctx = { now: NOW, siteHost: 'toss.im' }

  it('점수가 가장 높은 문자를 고른다', () => {
    const picked = pickAuthCode(parseSmsQuery(INBOX), ctx)
    expect(picked?.code).toBe('285193')
    expect(picked?.senderTail).toBe('7788')
  })

  it('점수가 같으면 더 최근 문자를 고른다', () => {
    const rows: SmsRow[] = [
      { address: '15881111', body: '인증번호 111111', dateMs: NOW - 60_000 },
      { address: '15882222', body: '인증번호 222222', dateMs: NOW - 10_000 }
    ]
    expect(pickAuthCode(rows, ctx)?.code).toBe('222222')
  })

  it('결과에 문자 본문이 없다', () => {
    const picked = pickAuthCode(parseSmsQuery(INBOX), ctx)
    expect(Object.keys(picked ?? {}).sort()).toEqual(['code', 'dateMs', 'score', 'senderTail'])
    expect(JSON.stringify(picked)).not.toContain('타인에게')
  })

  it('후보가 없으면 null', () => {
    expect(pickAuthCode([], ctx)).toBeNull()
  })
})

describe('parseNotificationSms', () => {
  it('문자 앱 알림에서만 제목·본문·시각을 뽑는다', () => {
    const rows = parseNotificationSms(NOTIFICATIONS)
    expect(rows.length).toBe(2)
    expect(rows[0]).toEqual({
      address: '15881234',
      body: '[Web발신] 인증번호 [493028] 입력하세요',
      dateMs: 1758199980000
    })
    // 카카오톡 알림은 문자 앱이 아니라 제외한다
    expect(rows.some((r) => r.body.includes('내일 7시'))).toBe(false)
  })
})

// --- watchSms -------------------------------------------------------------

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

function makeClock(start: number): Clock {
  let t = start
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    }
  }
}

describe('watchSms', () => {
  it('3대를 1초 주기로 돌고 먼저 후보를 낸 폰의 serial 을 함께 돌려준다', async () => {
    const adb = new FakeAdb()
    adb.reply('-s PHONE_C', INBOX)
    const clock = makeClock(NOW)
    const res = await watchSms({
      adb,
      serials: () => ['PHONE_A', 'PHONE_B', 'PHONE_C'],
      siteHost: 'toss.im',
      now: clock.now,
      sleep: clock.sleep
    })
    expect(res?.serial).toBe('PHONE_C')
    expect(res?.code).toBe('285193')
    // 세 대 모두에게 같은 문자함 조회를 보냈다
    const queried = adb.calls.filter((c) => c.join(' ').includes(SMS_QUERY_ARGS.join(' ')))
    expect(queried.length).toBe(3)
  })

  it('3분이 지나면 null 이고 폴링 주기만큼 쉰다', async () => {
    const adb = new FakeAdb()
    const clock = makeClock(NOW)
    const res = await watchSms({
      adb,
      serials: () => ['PHONE_A'],
      siteHost: 'toss.im',
      now: clock.now,
      sleep: clock.sleep
    })
    expect(res).toBeNull()
    expect(clock.now() - NOW).toBeGreaterThanOrEqual(AUTH_TIMEOUT_MS)
    expect(adb.calls.length).toBe(AUTH_TIMEOUT_MS / SMS_POLL_INTERVAL_MS)
  })

  it('cancelled() 가 true 가 되면 즉시 null', async () => {
    const adb = new FakeAdb()
    adb.reply('-s PHONE_A', INBOX)
    const clock = makeClock(NOW)
    const res = await watchSms({
      adb,
      serials: () => ['PHONE_A'],
      siteHost: 'toss.im',
      now: clock.now,
      sleep: clock.sleep,
      cancelled: () => true
    })
    expect(res).toBeNull()
    expect(adb.calls.length).toBe(0)
  })

  it('감시 시작 한참 전에 온 문자는 무시한다', async () => {
    const adb = new FakeAdb()
    adb.reply('-s PHONE_A', INBOX)
    // 픽스처 문자보다 1시간 뒤에 감시를 시작한다
    const clock = makeClock(NOW + 60 * 60 * 1000)
    const res = await watchSms({
      adb,
      serials: () => ['PHONE_A'],
      siteHost: 'toss.im',
      now: clock.now,
      sleep: clock.sleep
    })
    expect(res).toBeNull()
  })

  it('문자함 조회가 막히면 알림 로그로 폴백한다', async () => {
    const adb = new FakeAdb()
    adb.reply(SMS_QUERY_ARGS.join(' '), 'java.lang.SecurityException: Permission Denial', 1)
    adb.reply(NOTIFICATION_DUMP_ARGS.join(' '), NOTIFICATIONS)
    const clock = makeClock(NOW)
    const res = await watchSms({
      adb,
      serials: () => ['PHONE_A'],
      siteHost: 'toss.im',
      now: clock.now,
      sleep: clock.sleep
    })
    expect(res?.code).toBe('771204')
    expect(res?.serial).toBe('PHONE_A')
  })

  it('알림 로그도 막히면 화면 폴백 훅을 부른다', async () => {
    const adb = new FakeAdb()
    adb.reply(SMS_QUERY_ARGS.join(' '), 'Permission Denial', 1)
    adb.reply(NOTIFICATION_DUMP_ARGS.join(' '), 'Permission Denial', 1)
    const clock = makeClock(NOW)
    const seen: string[] = []
    const res = await watchSms({
      adb,
      serials: () => ['PHONE_A'],
      siteHost: 'toss.im',
      now: clock.now,
      sleep: clock.sleep,
      screenFallback: (serial) => {
        seen.push(serial)
        return Promise.resolve({ code: '556677', senderTail: '1234', score: 3, dateMs: NOW })
      }
    })
    expect(seen).toEqual(['PHONE_A'])
    expect(res?.code).toBe('556677')
  })

  it('연결된 폰이 없으면 조회 없이 null', async () => {
    const adb = new FakeAdb()
    const clock = makeClock(NOW)
    const res = await watchSms({
      adb,
      serials: () => [],
      siteHost: 'toss.im',
      now: clock.now,
      sleep: clock.sleep
    })
    expect(res).toBeNull()
    expect(adb.calls.length).toBe(0)
  })
})
