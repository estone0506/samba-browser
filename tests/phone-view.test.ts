import { describe, it, expect } from 'vitest'
import {
  PHONE_GRID_MAX,
  PHONE_PAD_KEYS,
  canRecover,
  countryBadge,
  isOverPhoneLimit,
  isPhoneDimmed,
  isSwipe,
  phoneStateDotClass,
  phoneStateLabelKey,
  phoneStateTone,
  screenBadgeKey,
  smsBadgeKey,
  sortPhones,
  toViewRatio,
  transportLabelKey
} from '../src/renderer/src/components/phone/phone-view'
import {
  PHONE_LIMIT_PRO,
  PHONE_STATES,
  PHONE_TRANSPORTS,
  type PhoneDto,
  type PhoneState
} from '../src/shared/phone'
import ko from '../src/renderer/src/i18n/ko.json'
import en from '../src/renderer/src/i18n/en.json'

// 테스트용 폰 한 대. 상태·별칭만 바꿔 가며 쓴다
function phone(over: Partial<PhoneDto> = {}): PhoneDto {
  return {
    id: 1,
    serial: 'R3CRA05HY3R',
    label: '업무폰',
    country: 'KR',
    transport: 'usb',
    wifiAddress: null,
    model: 'SM-S911N',
    state: 'online',
    smsQueryOk: true,
    lastSeenAt: 0,
    screenMode: null,
    ...over
  }
}

describe('폰 상태 배지 매핑', () => {
  it('연결됨만 강조하고 승인 대기는 경고로 본다', () => {
    expect(phoneStateTone('online')).toBe('strong')
    expect(phoneStateTone('unauthorized')).toBe('warn')
    expect(phoneStateTone('offline')).toBe('neutral')
    expect(phoneStateTone('disconnected')).toBe('neutral')
  })

  it('모든 상태에 색조·점 색·라벨 키가 있다', () => {
    for (const state of PHONE_STATES) {
      expect(['neutral', 'strong', 'warn']).toContain(phoneStateTone(state))
      expect(phoneStateDotClass(state)).not.toBe('')
      expect(phoneStateLabelKey(state)).toBe(`phone.state.${state}`)
    }
  })

  it('끊긴 폰만 회색 처리하고 재연결 버튼을 준다', () => {
    const dimmed: PhoneState[] = ['offline', 'disconnected']
    for (const state of PHONE_STATES) {
      expect(isPhoneDimmed(state)).toBe(dimmed.includes(state))
      expect(canRecover(state)).toBe(dimmed.includes(state))
    }
  })

  it('간이 화면일 때만 화면 배지를 단다', () => {
    expect(screenBadgeKey('still')).toBe('phone.badge.still')
    expect(screenBadgeKey('video')).toBeNull()
    expect(screenBadgeKey(null)).toBeNull()
  })

  it('문자 조회 배지는 시험 전이면 없다', () => {
    expect(smsBadgeKey(null)).toBeNull()
    expect(smsBadgeKey(true)).toBe('phone.badge.smsOk')
    expect(smsBadgeKey(false)).toBe('phone.badge.smsBlocked')
  })

  it('국가 배지는 코드 그대로 쓴다', () => {
    expect(countryBadge('KR')).toBe('KR')
    expect(countryBadge('JP')).toBe('JP')
  })
})

describe('폰 목록 정렬·상한', () => {
  it('연결된 폰이 먼저 오고 같은 상태면 별칭순이다', () => {
    const list = [
      phone({ id: 1, label: '나', state: 'disconnected' }),
      phone({ id: 2, label: '다', state: 'online' }),
      phone({ id: 3, label: '가', state: 'online' }),
      phone({ id: 4, label: '라', state: 'unauthorized' })
    ]
    expect(sortPhones(list).map((p) => p.id)).toEqual([3, 2, 4, 1])
  })

  it('원본 배열을 건드리지 않는다', () => {
    const list = [phone({ id: 1, state: 'offline' }), phone({ id: 2, state: 'online' })]
    sortPhones(list)
    expect(list.map((p) => p.id)).toEqual([1, 2])
  })

  it('카드 격자 수는 Pro 연결 상한과 같다', () => {
    expect(PHONE_GRID_MAX).toBe(PHONE_LIMIT_PRO)
    expect(isOverPhoneLimit(PHONE_LIMIT_PRO)).toBe(false)
    expect(isOverPhoneLimit(PHONE_LIMIT_PRO + 1)).toBe(true)
  })
})

describe('화면 좌표 환산', () => {
  it('뷰 크기에 대한 0~1 비율로 바꾼다', () => {
    expect(toViewRatio(50, 100, { width: 200, height: 400 })).toEqual({ rx: 0.25, ry: 0.25 })
  })

  it('뷰 밖 좌표는 0~1 로 자른다', () => {
    expect(toViewRatio(-10, 900, { width: 200, height: 400 })).toEqual({ rx: 0, ry: 1 })
  })

  it('크기가 0 이면 0 으로 떨어진다(0 나누기 방지)', () => {
    expect(toViewRatio(10, 10, { width: 0, height: 0 })).toEqual({ rx: 0, ry: 0 })
  })

  it('조금 움직인 건 탭, 많이 움직인 건 스와이프로 본다', () => {
    expect(isSwipe(10, 10, 12, 12)).toBe(false)
    expect(isSwipe(10, 10, 10, 200)).toBe(true)
  })
})

// 중첩 객체를 'a.b.c' 형태의 평탄한 키 목록으로 편다
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

describe('폰 i18n 키', () => {
  const koKeys = flatten(ko as Record<string, unknown>)
  const enKeys = flatten(en as Record<string, unknown>)

  it('상태·전송 방식·배지·패드 키가 두 파일에 모두 있다', () => {
    const keys = [
      ...PHONE_STATES.map(phoneStateLabelKey),
      ...PHONE_TRANSPORTS.map(transportLabelKey),
      'phone.badge.still',
      'phone.badge.smsOk',
      'phone.badge.smsBlocked',
      ...PHONE_PAD_KEYS.map((p) => p.labelKey)
    ]
    for (const key of keys) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })

  it('폰 화면·설정·매핑 키 묶음이 두 파일에 모두 있다', () => {
    for (const key of [
      'phone.title',
      'phone.proTitle',
      'phone.empty',
      'phone.recover',
      'phone.authWaiting',
      'phone.screen.openWindow',
      'phone.settings.detect',
      'phone.settings.paymentLimit',
      'phone.assign.title',
      'phone.assign.suggestion',
      'settingsPage.sections.phone'
    ]) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })
})
