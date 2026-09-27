import { describe, it, expect, vi } from 'vitest'
import {
  accountLabelFor,
  addNeverSaveHost,
  autoSaveCapturedLogin,
  classifyCapture,
  neverSaveEntry,
  saveCapturedLogin,
  toCapturePrompt,
  LOGIN_ITEM_LABEL,
  type CaptureAutoSaveVault
} from '../src/main/vault/login-capture'
import { judgeLoginOutcome } from '../src/main/ipc/login-success'
import { isMachineSubmission, MACHINE_FILL_WINDOW_MS } from '../src/main/browser/human-activity'
import { maskUsername } from '../src/shared/vault'

const SECRET = 'n3w-Secret!pw'

describe('classifyCapture — 새 계정/비밀번호 변경/같은 값', () => {
  const accounts = [
    { id: 1, username: 'alice' },
    { id: 2, username: 'bob' }
  ]

  it('같은 아이디가 없으면 새 계정', () => {
    expect(classifyCapture(accounts, 'carol', false)).toEqual({ kind: 'new' })
  })

  it('같은 아이디가 있고 값이 다르면 업데이트', () => {
    expect(classifyCapture(accounts, 'bob', false)).toEqual({ kind: 'update', accountId: 2 })
  })

  it('같은 값이면 아무것도 묻지 않는다(same)', () => {
    expect(classifyCapture(accounts, 'alice', true)).toEqual({ kind: 'same', accountId: 1 })
  })

  it('아이디 앞뒤 공백은 무시한다', () => {
    expect(classifyCapture(accounts, '  bob ', false)).toEqual({ kind: 'update', accountId: 2 })
  })
})

describe('accountLabelFor — 탭 프로필을 계정 라벨로', () => {
  it('따로 만든 프로필이면 그 이름을 라벨로 쓴다(하네스 login 도구가 바로 고른다)', () => {
    expect(accountLabelFor('쇼핑1', 'www.musinsa.com', 'alice', [])).toBe('쇼핑1')
  })

  it('기본 프로필이거나 프로필을 모르면 호스트를 라벨로 쓴다', () => {
    expect(accountLabelFor('default', 'www.musinsa.com', 'alice', [])).toBe('www.musinsa.com')
    expect(accountLabelFor(undefined, 'www.musinsa.com', 'alice', [])).toBe('www.musinsa.com')
  })

  it('같은 사이트의 다른 계정이 그 라벨을 쓰고 있으면 겹치지 않게 아이디를 붙인다', () => {
    expect(accountLabelFor('쇼핑1', 'www.musinsa.com', 'alice', ['쇼핑1'])).toBe('쇼핑1 alice')
  })
})

describe("'이 사이트는 묻지 않기' 목록", () => {
  it('등록 도메인 단위로 넣는다', () => {
    expect(neverSaveEntry('https://login.example.com/a')).toBe('example.com')
    expect(neverSaveEntry('www.naver.com')).toBe('naver.com')
  })

  it('이미 있으면 다시 넣지 않는다', () => {
    expect(addNeverSaveHost(['example.com'], 'login.example.com')).toEqual(['example.com'])
    expect(addNeverSaveHost([], 'www.naver.com')).toEqual(['naver.com'])
  })
})

describe('값 비노출 — 렌더러로 가는 확인 바 정보', () => {
  it('비밀번호가 없고 아이디는 가린다', () => {
    const prompt = toCapturePrompt({
      host: 'www.shop.com',
      username: 'buyer02@naver.com',
      password: SECRET,
      isNew: true,
      locked: false,
      profile: '쇼핑1'
    })
    expect(prompt).toEqual({
      host: 'www.shop.com',
      username: 'ca*******t@naver.com',
      isNew: true,
      locked: false
    })
    const json = JSON.stringify(prompt)
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain('buyer02')
    expect(Object.keys(prompt)).not.toContain('password')
  })

  it('maskUsername 은 짧은 아이디·빈 값도 안전하게 가린다', () => {
    expect(maskUsername('alice')).toBe('al**e')
    expect(maskUsername('abc')).toBe('a**')
    expect(maskUsername('a')).toBe('a*')
    expect(maskUsername('')).toBe('')
    expect(maskUsername('010-1234-5678')).toBe('01**********8')
  })
})

// 저장 경로에 쓰는 가짜 금고. 비밀번호는 putItem/applyAutoPasswordUpdate 로만 들어온다
function fakeVault(
  accounts: { id: number; username: string; label: string }[] = [],
  sameSecret = false,
  items: Record<number, { type: string; label: string }[]> = {}
): CaptureAutoSaveVault & {
  upsertAccount: ReturnType<typeof vi.fn>
  putItem: ReturnType<typeof vi.fn>
  applyAutoPasswordUpdate: ReturnType<typeof vi.fn>
} {
  return {
    hasSameSecret: () => sameSecret,
    listAccounts: () => accounts,
    listItems: (id) => (id === null ? [] : (items[id] ?? [])),
    upsertAccount: vi.fn(() => ({ id: 99 })),
    putItem: vi.fn(),
    applyAutoPasswordUpdate: vi.fn(() => ({ undoToken: 'tok' }))
  }
}

describe('saveCapturedLogin — 확인 바에서 저장을 누른 뒤', () => {
  it('새 계정은 프로필 라벨로 계정을 만들고 로그인 항목을 넣는다', () => {
    const v = fakeVault()
    const result = saveCapturedLogin(v, {
      host: 'www.shop.com',
      username: 'alice',
      password: SECRET,
      profile: '쇼핑1'
    })
    expect(result).toBe('saved')
    // 호스트는 정규화한 값(www. 제거)으로 저장한다
    expect(v.upsertAccount).toHaveBeenCalledWith({
      host: 'shop.com',
      label: '쇼핑1',
      username: 'alice'
    })
    expect(v.putItem).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 99,
        type: 'login',
        label: LOGIN_ITEM_LABEL,
        value: SECRET
      })
    )
  })

  it('기존 계정은 계정 라벨을 건드리지 않고 항목 이름도 그대로 두고 값만 바꾼다', () => {
    const v = fakeVault([{ id: 5, username: 'alice', label: '내 계정' }], false, {
      5: [{ type: 'login', label: '무신사 비번' }]
    })
    expect(
      saveCapturedLogin(v, { host: 'www.shop.com', username: 'alice', password: SECRET })
    ).toBe('updated')
    expect(v.upsertAccount).not.toHaveBeenCalled()
    expect(v.putItem).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 5, label: '무신사 비번', value: SECRET })
    )
  })

  it('누른 시점에 같은 값이면 아무것도 쓰지 않는다', () => {
    const v = fakeVault([{ id: 5, username: 'alice', label: 'x' }], true)
    expect(
      saveCapturedLogin(v, { host: 'www.shop.com', username: 'alice', password: SECRET })
    ).toBe('same')
    expect(v.putItem).not.toHaveBeenCalled()
  })
})

describe('autoSaveCapturedLogin — 묻지 않고 자동 저장(설정 켜짐)', () => {
  it('되돌리기 토큰을 남기며 저장하고, 새 계정이면 saved', () => {
    const v = fakeVault()
    const r = autoSaveCapturedLogin(v, {
      host: 'www.shop.com',
      username: 'alice',
      password: SECRET
    })
    expect(r).toEqual({ result: 'saved', undoToken: 'tok' })
    expect(v.applyAutoPasswordUpdate).toHaveBeenCalledWith({
      accountId: 99,
      username: 'alice',
      value: SECRET
    })
  })

  it('기존 계정이면 updated, 같은 값이면 same', () => {
    const v = fakeVault([{ id: 5, username: 'alice', label: 'x' }])
    expect(
      autoSaveCapturedLogin(v, { host: 'www.shop.com', username: 'alice', password: SECRET }).result
    ).toBe('updated')
    const same = fakeVault([{ id: 5, username: 'alice', label: 'x' }], true)
    expect(
      autoSaveCapturedLogin(same, { host: 'www.shop.com', username: 'alice', password: SECRET })
    ).toEqual({ result: 'same' })
    expect(same.applyAutoPasswordUpdate).not.toHaveBeenCalled()
  })
})

describe('isMachineSubmission — 자동화·자동 채움 제출 제외', () => {
  const now = 1_000_000

  it('기계 입력이 없으면 사람 제출', () => {
    expect(isMachineSubmission(undefined, now - 1000, now)).toBe(false)
  })

  it('기계 입력 직후의 제출은 기계 제출', () => {
    expect(isMachineSubmission(now - 5000, undefined, now)).toBe(true)
    // 기계 입력이 보낸 늦은 키 이벤트(1.5초 안)는 사람 입력으로 치지 않는다
    expect(isMachineSubmission(now - 5000, now - 4000, now)).toBe(true)
  })

  it('자동 채움 뒤 사람이 다시 쳤으면 사람 제출', () => {
    expect(isMachineSubmission(now - 10_000, now - 2000, now)).toBe(false)
  })

  it('기계 입력이 오래전이면 사람 제출', () => {
    expect(isMachineSubmission(now - MACHINE_FILL_WINDOW_MS, undefined, now)).toBe(false)
  })
})

describe('judgeLoginOutcome — 제출 뒤 로그인 성공 판정', () => {
  const prevUrl = 'https://nid.example.com/login'

  it('로그인 경로를 벗어나 이동했으면 성공', () => {
    expect(
      judgeLoginOutcome({
        prevUrl,
        url: 'https://www.example.com/',
        text: '환영합니다',
        passwordVisible: false
      })
    ).toBe('success')
  })

  it('주소가 그대로여도 비밀번호 칸이 사라졌으면 성공(레이어·SPA 로그인)', () => {
    expect(
      judgeLoginOutcome({ prevUrl, url: prevUrl, text: '마이페이지', passwordVisible: false })
    ).toBe('success')
  })

  it('실패 문구가 보이면 실패', () => {
    expect(
      judgeLoginOutcome({
        prevUrl,
        url: prevUrl,
        text: '아이디 또는 비밀번호가 일치하지 않습니다',
        passwordVisible: true
      })
    ).toBe('failure')
  })

  it('비밀번호 칸이 그대로고 주소도 그대로면 아직 모름', () => {
    expect(judgeLoginOutcome({ prevUrl, url: prevUrl, text: '', passwordVisible: true })).toBe(
      'unknown'
    )
    // 화면을 읽지 못했으면 성공으로 단정하지 않는다
    expect(judgeLoginOutcome({ prevUrl, url: prevUrl, text: '', passwordVisible: undefined })).toBe(
      'unknown'
    )
  })
})
