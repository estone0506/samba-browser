// 실행기(createSpawner)의 실패 경로 테스트.
// adb·scrcpy 를 절대 부르지 않는다 — 경로를 비우거나 없는 파일을 가리켜
// "프로세스를 못 띄웠다" 를 반드시 onEnd 로 알리는지만 본다

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSpawner } from '../src/main/phone/process'

/** onEnd 가 불릴 때까지 기다린다(안 불리면 타임아웃으로 실패한다) */
function waitEnd(spawner: ReturnType<typeof createSpawner>): Promise<number | null> {
  return new Promise((resolve) => {
    spawner(['--version'], () => {}, resolve)
  })
}

describe('createSpawner', () => {
  it('경로가 비어 bin() 이 던지면 종료로 알린다(영원히 기다리지 않는다)', async () => {
    const spawner = createSpawner(() => {
      throw new Error('adb path is not set')
    })
    await expect(waitEnd(spawner)).resolves.toBeNull()
  })

  it('실행 파일이 없으면 error 이벤트를 받아 종료로 알린다', async () => {
    const missing = join(tmpdir(), 'samba-no-such-binary-xyz.exe')
    const spawner = createSpawner(() => missing)
    await expect(waitEnd(spawner)).resolves.toBeNull()
  })

  it('종료 통지는 한 번만 간다', async () => {
    const missing = join(tmpdir(), 'samba-no-such-binary-xyz.exe')
    const spawner = createSpawner(() => missing)
    let count = 0
    await new Promise<void>((resolve) => {
      spawner(
        ['-s'],
        () => {},
        () => {
          count += 1
          setTimeout(resolve, 20)
        }
      )
    })
    expect(count).toBe(1)
  })

  it('취소 함수를 부르면 종료 콜백이 오지 않는다', async () => {
    const spawner = createSpawner(() => join(tmpdir(), 'samba-no-such-binary-xyz.exe'))
    let ended = false
    const cancel = spawner(
      ['-s'],
      () => {},
      () => {
        ended = true
      }
    )
    cancel()
    await new Promise((r) => setTimeout(r, 30))
    expect(ended).toBe(false)
  })
})
