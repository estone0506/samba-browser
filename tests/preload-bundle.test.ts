import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { IPC } from '../src/shared/ipc'
import { MAX_ELEMENTS } from '../src/shared/snapshot'
import {
  MAX_ELEMENTS as PAGE_MAX_ELEMENTS,
  PAGE_IPC,
  INTERNAL_PROTOCOL,
  GESTURE_ACTION_LABELS
} from '../src/preload/page-constants'
import { WEBSTORE_HOST as PAGE_WEBSTORE_HOST } from '../src/preload/page-webstore'
import { INTERNAL_SCHEME } from '../src/shared/url'
import { GESTURE_ACTIONS } from '../src/shared/gestures'
import { WEBSTORE_HOST } from '../src/shared/extensions'

// 웹페이지 preload 는 sandbox:true 로 주입되므로 다른 파일을 require() 할 수 없다.
// src/shared/* 의 값을 page.ts/page-core.ts 가 import 하면 renderer.ts 와 공유되어
// Rollup 이 out/preload/chunks/*.js 로 분리 → page.js 가 require() → preload 로드 실패
// → globalThis.__samba 미정의 → AI 의 get_page/login 전부 실패.
const BUNDLE = resolve(__dirname, '../out/preload/page.js')

describe('page-constants 는 shared 원본과 동기화되어야 한다', () => {
  it('MAX_ELEMENTS 가 shared/snapshot 과 같다', () => {
    expect(PAGE_MAX_ELEMENTS).toBe(MAX_ELEMENTS)
  })

  it('vaultCapture 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.vaultCapture).toBe(IPC.vaultCapture)
  })

  it('새 탭·새 창 알림 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.popupOpened).toBe(IPC.pagePopupOpened)
  })

  it('자동 채움 피커 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.vaultPickerAccounts).toBe(IPC.vaultPickerAccounts)
    expect(PAGE_IPC.vaultPickerFill).toBe(IPC.vaultPickerFill)
  })

  it('새 탭 페이지 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.newTabInit).toBe(IPC.newTabInit)
    expect(PAGE_IPC.newTabSearch).toBe(IPC.newTabSearch)
    expect(PAGE_IPC.newTabOpen).toBe(IPC.newTabOpen)
  })

  it('마우스 제스처 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.gesture).toBe(IPC.pageGesture)
    expect(PAGE_IPC.gestureConfig).toBe(IPC.pageGestureConfig)
  })

  it('제스처 동작 이름표가 shared/gestures 의 동작 목록을 빠짐없이 덮는다', () => {
    const expected = [...GESTURE_ACTIONS].sort()
    expect(Object.keys(GESTURE_ACTION_LABELS.ko).sort()).toEqual(expected)
    expect(Object.keys(GESTURE_ACTION_LABELS.en).sort()).toEqual(expected)
  })

  it('웹스토어 설치 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.webstoreInstall).toBe(IPC.pageWebstoreInstall)
    expect(PAGE_IPC.webstoreInstallResult).toBe(IPC.pageWebstoreInstallResult)
  })

  it('웹스토어 호스트 사본이 shared/extensions 와 같다', () => {
    expect(PAGE_WEBSTORE_HOST).toBe(WEBSTORE_HOST)
  })

  it('AI 프레임 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.agentCall).toBe(IPC.pageAgentCall)
    expect(PAGE_IPC.agentResult).toBe(IPC.pageAgentResult)
  })

  it('내부 스킴 상수가 shared/url 과 같다', () => {
    expect(INTERNAL_PROTOCOL).toBe(`${INTERNAL_SCHEME}:`)
  })
})

describe('out/preload/page.js 번들', () => {
  // 번들이 없다고 조용히 skip 하면 CI 가 이 검증 없이 그냥 통과해버린다.
  // 번들이 없으면 명시적으로 실패시켜 pnpm build 실행을 강제한다
  if (!existsSync(BUNDLE)) {
    it('번들이 존재해야 한다', () => {
      throw new Error('out/preload/page.js 번들이 없습니다. 먼저 pnpm build 를 실행하세요')
    })
  } else {
    it('공용 청크를 require 하지 않는다', () => {
      const code = readFileSync(BUNDLE, 'utf-8')
      expect(code).not.toMatch(/require\(["'][^"']*chunks/)
    })

    it("'electron' 외의 require 가 없다", () => {
      const code = readFileSync(BUNDLE, 'utf-8')
      const specifiers = Array.from(code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)).map(
        (m) => m[1]
      )
      expect(specifiers.filter((s) => s !== 'electron')).toEqual([])
    })
  }
})
