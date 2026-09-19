import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcResult } from '../src/shared/ipc'
import type { PhoneAuthWaitingDto, PhoneDto } from '../src/shared/phone'

// 렌더러 전역 window.samba 스텁. 스토어는 순수 zustand 라 node 에서 그대로 돌릴 수 있다
let onUpdatedCb: ((list: PhoneDto[], warning?: string) => void) | null = null
let onAuthWaitingCb: ((dto: PhoneAuthWaitingDto) => void) | null = null

const list = vi.fn(async (): Promise<IpcResult<PhoneDto[]>> => ({ ok: true, data: [] }))
const refresh = vi.fn(async (): Promise<IpcResult<PhoneDto[]>> => ({ ok: true, data: [] }))
const recover = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
const assign = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
const connect = vi.fn(async (): Promise<IpcResult<{ ok: boolean; message: string }>> => ({
  ok: true,
  data: { ok: true, message: '연결했어요' }
}))

const win = {
  samba: {
    phone: {
      list,
      refresh,
      recover,
      assign,
      connect,
      onUpdated: (cb: (l: PhoneDto[], w?: string) => void) => {
        onUpdatedCb = cb
        return () => {
          onUpdatedCb = null
        }
      },
      onAuthWaiting: (cb: (dto: PhoneAuthWaitingDto) => void) => {
        onAuthWaitingCb = cb
        return () => {
          onAuthWaitingCb = null
        }
      }
    }
  }
}
Object.assign(globalThis, { window: win })

const { usePhoneStore } = await import('../src/renderer/src/stores/phoneStore')

function phone(over: Partial<PhoneDto> = {}): PhoneDto {
  return {
    id: 1,
    serial: 'A1',
    label: '가폰',
    country: 'KR',
    transport: 'usb',
    wifiAddress: null,
    model: 'SM-S911N',
    state: 'online',
    smsQueryOk: null,
    lastSeenAt: 0,
    screenMode: null,
    ...over
  }
}

const reset = (): void =>
  usePhoneStore.setState({
    list: [],
    loading: false,
    warning: null,
    error: null,
    authWaiting: null,
    expandedId: null,
    screenModes: {},
    assignSuggestion: null
  })

describe('phoneStore 목록', () => {
  beforeEach(() => {
    reset()
    refresh.mockClear()
  })

  it('불러온 목록은 연결 상태 순으로 정렬한다', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      data: [phone({ id: 1, label: '나', state: 'offline' }), phone({ id: 2, label: '가' })]
    })
    await usePhoneStore.getState().load()
    expect(usePhoneStore.getState().list.map((p) => p.id)).toEqual([2, 1])
  })

  it('실패하면 목록은 그대로 두고 오류만 남긴다', async () => {
    usePhoneStore.setState({ list: [phone()] })
    list.mockResolvedValueOnce({ ok: false, error: 'adb 없음' })
    await usePhoneStore.getState().load()
    expect(usePhoneStore.getState().error).toBe('adb 없음')
    expect(usePhoneStore.getState().list).toHaveLength(1)
  })
})

describe('phoneStore 이벤트 구독', () => {
  beforeEach(() => {
    reset()
    onUpdatedCb = null
    onAuthWaitingCb = null
  })

  it('목록 통지의 warning 을 그대로 담는다', () => {
    const off = usePhoneStore.getState().subscribe()
    onUpdatedCb?.([phone()], '3대를 넘었어요')
    expect(usePhoneStore.getState().warning).toBe('3대를 넘었어요')
    onUpdatedCb?.([phone()])
    expect(usePhoneStore.getState().warning).toBeNull()
    off()
  })

  it('사라진 폰의 화면 모드 기록은 지운다', () => {
    usePhoneStore.setState({ screenModes: { A1: 'video', B2: 'still' } })
    const off = usePhoneStore.getState().subscribe()
    onUpdatedCb?.([phone({ serial: 'A1' })])
    expect(usePhoneStore.getState().screenModes).toEqual({ A1: 'video' })
    off()
  })

  it('메인이 보고한 화면 모드가 우선이다', () => {
    usePhoneStore.setState({ screenModes: { A1: 'video' } })
    const off = usePhoneStore.getState().subscribe()
    onUpdatedCb?.([phone({ serial: 'A1', screenMode: 'still' })])
    expect(usePhoneStore.getState().screenModes.A1).toBe('still')
    off()
  })

  it('목록에서 빠진 폰은 펼침 상태도 접는다', () => {
    usePhoneStore.setState({ expandedId: 9 })
    const off = usePhoneStore.getState().subscribe()
    onUpdatedCb?.([phone({ id: 1 })])
    expect(usePhoneStore.getState().expandedId).toBeNull()
    off()
  })

  it('인증 대기가 오면 그 폰 카드를 펼치고, 끝나면 접는다', () => {
    const off = usePhoneStore.getState().subscribe()
    onAuthWaitingCb?.({ waiting: true, kind: 'sms', siteHost: 'naver.com', phoneId: 7 })
    expect(usePhoneStore.getState().expandedId).toBe(7)
    expect(usePhoneStore.getState().authWaiting?.waiting).toBe(true)
    onAuthWaitingCb?.({ waiting: false, kind: 'sms', siteHost: 'naver.com', phoneId: 7 })
    expect(usePhoneStore.getState().expandedId).toBeNull()
    expect(usePhoneStore.getState().authWaiting).toBeNull()
    off()
  })

  it('배정 폰 없이 대기하면 펼침 상태를 건드리지 않는다', () => {
    usePhoneStore.setState({ expandedId: 3 })
    const off = usePhoneStore.getState().subscribe()
    onAuthWaitingCb?.({ waiting: true, kind: 'sms', siteHost: 'naver.com', phoneId: null })
    expect(usePhoneStore.getState().expandedId).toBe(3)
    off()
  })

  it('인증에 성공한 폰을 담당 폰으로 제안한다', () => {
    const off = usePhoneStore.getState().subscribe()
    onAuthWaitingCb?.({ waiting: false, kind: 'sms', siteHost: 'naver.com', phoneId: 7 })
    expect(usePhoneStore.getState().assignSuggestion).toEqual({ phoneId: 7, siteHost: 'naver.com' })
    off()
  })

  it('배정 폰이 없었으면 제안하지 않는다', () => {
    const off = usePhoneStore.getState().subscribe()
    onAuthWaitingCb?.({ waiting: false, kind: 'sms', siteHost: 'naver.com', phoneId: null })
    expect(usePhoneStore.getState().assignSuggestion).toBeNull()
    off()
  })
})

describe('phoneStore 조작', () => {
  beforeEach(() => {
    reset()
    assign.mockClear()
    refresh.mockClear()
  })

  it('카드 펼침은 같은 폰을 다시 누르면 접힌다', () => {
    usePhoneStore.getState().toggleExpand(5)
    expect(usePhoneStore.getState().expandedId).toBe(5)
    usePhoneStore.getState().toggleExpand(5)
    expect(usePhoneStore.getState().expandedId).toBeNull()
  })

  it('화면 모드를 null 로 두면 기록에서 지운다', () => {
    usePhoneStore.getState().setScreenMode('A1', 'still')
    expect(usePhoneStore.getState().screenModes.A1).toBe('still')
    usePhoneStore.getState().setScreenMode('A1', null)
    expect(usePhoneStore.getState().screenModes.A1).toBeUndefined()
  })

  it('담당 폰을 저장하면 제안 배너를 지운다', async () => {
    usePhoneStore.setState({ assignSuggestion: { phoneId: 7, siteHost: 'naver.com' } })
    const ok = await usePhoneStore.getState().assign(3, 7)
    expect(ok).toBe(true)
    expect(assign).toHaveBeenCalledWith(3, 7)
    expect(usePhoneStore.getState().assignSuggestion).toBeNull()
  })

  it('와이파이 연결에 성공하면 목록을 다시 읽고 안내 문구를 돌려준다', async () => {
    const message = await usePhoneStore.getState().connectWifi('192.168.0.5:5555')
    expect(message).toBe('연결했어요')
    expect(refresh).toHaveBeenCalled()
  })

  it('와이파이 연결에 실패하면 null 을 돌려주고 오류를 남긴다', async () => {
    connect.mockResolvedValueOnce({ ok: false, error: '주소가 틀렸어요' })
    const message = await usePhoneStore.getState().connectWifi('틀린주소')
    expect(message).toBeNull()
    expect(usePhoneStore.getState().error).toBe('주소가 틀렸어요')
    expect(refresh).not.toHaveBeenCalled()
  })
})
