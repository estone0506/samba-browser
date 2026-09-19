// scrcpy 큰 창 테스트. 가짜 실행기만 쓰고 scrcpy 를 실행하지 않는다

import { describe, it, expect } from 'vitest'
import { ScrcpyWindows, scrcpyArgs } from '../src/main/phone/scrcpy'
import type { ProcessSpawner } from '../src/main/phone/process'

const SERIAL = 'R3CRA05HY3R'

interface FakeSpawn {
  spawn: ProcessSpawner
  calls: string[][]
  /** 창이 스스로 닫힌 상황(사용자가 X 를 누름)을 흉내 낸다 */
  endLast: () => void
  cancelled: number
}

function makeSpawn(): FakeSpawn {
  const calls: string[][] = []
  const ends: (() => void)[] = []
  const state = { cancelled: 0 }
  const spawn: ProcessSpawner = (args, _onData, onEnd) => {
    calls.push(args)
    ends.push(() => onEnd(0))
    return () => {
      state.cancelled += 1
    }
  }
  return {
    spawn,
    calls,
    endLast: () => ends[ends.length - 1]?.(),
    get cancelled() {
      return state.cancelled
    }
  }
}

function makeWindows(path = 'C:\\pt\\scrcpy.exe'): { w: ScrcpyWindows; s: FakeSpawn } {
  const s = makeSpawn()
  const w = new ScrcpyWindows({ spawn: s.spawn, path: () => path, size: () => 1080, fps: () => 30 })
  return { w, s }
}

describe('scrcpyArgs', () => {
  it('스펙대로 인자를 만든다', () => {
    expect(scrcpyArgs(SERIAL, 720, 15)).toEqual([
      '-s',
      SERIAL,
      '--video-codec=h264',
      '--max-size=720',
      '--max-fps=15',
      '--no-audio',
      '--stay-awake',
      '--video-bit-rate=2M'
    ])
  })
})

describe('ScrcpyWindows', () => {
  it('경로가 비어 있으면 던진다', () => {
    const { w } = makeWindows('')
    expect(() => w.open(SERIAL)).toThrow('scrcpy path is not set')
  })

  it('폰별로 창 하나만 띄운다', () => {
    const { w, s } = makeWindows()
    w.open(SERIAL)
    w.open(SERIAL)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toEqual(scrcpyArgs(SERIAL, 1080, 30))
    expect(w.isOpen(SERIAL)).toBe(true)
  })

  it('다른 폰은 각자 창을 갖는다', () => {
    const { w, s } = makeWindows()
    w.open(SERIAL)
    w.open('OTHER')
    expect(s.calls).toHaveLength(2)
    w.closeAll()
    expect(s.cancelled).toBe(2)
    expect(w.isOpen(SERIAL)).toBe(false)
  })

  it('창이 스스로 닫히면 다시 열 수 있다', () => {
    const { w, s } = makeWindows()
    w.open(SERIAL)
    s.endLast()
    expect(w.isOpen(SERIAL)).toBe(false)
    w.open(SERIAL)
    expect(s.calls).toHaveLength(2)
  })

  it('close 는 떠 있지 않은 폰에 안전하다', () => {
    const { w, s } = makeWindows()
    w.close(SERIAL)
    expect(s.cancelled).toBe(0)
  })
})
