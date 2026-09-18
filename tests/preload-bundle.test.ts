import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { IPC } from '../src/shared/ipc'
import { MAX_ELEMENTS } from '../src/shared/snapshot'
import {
  MAX_ELEMENTS as PAGE_MAX_ELEMENTS,
  PAGE_IPC,
  INTERNAL_PROTOCOL
} from '../src/preload/page-constants'
import { INTERNAL_SCHEME } from '../src/shared/url'

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

  it('자동 채움 피커 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.vaultPickerAccounts).toBe(IPC.vaultPickerAccounts)
    expect(PAGE_IPC.vaultPickerFill).toBe(IPC.vaultPickerFill)
  })

  it('새 탭 페이지 채널명이 shared/ipc 와 같다', () => {
    expect(PAGE_IPC.newTabInit).toBe(IPC.newTabInit)
    expect(PAGE_IPC.newTabSearch).toBe(IPC.newTabSearch)
    expect(PAGE_IPC.newTabOpen).toBe(IPC.newTabOpen)
  })

  it('내부 스킴 상수가 shared/url 과 같다', () => {
    expect(INTERNAL_PROTOCOL).toBe(`${INTERNAL_SCHEME}:`)
  })
})

describe('out/preload/page.js 번들', () => {
  it.skipIf(!existsSync(BUNDLE))('공용 청크를 require 하지 않는다', () => {
    const code = readFileSync(BUNDLE, 'utf-8')
    expect(code).not.toMatch(/require\(["'][^"']*chunks/)
  })

  it.skipIf(!existsSync(BUNDLE))("'electron' 외의 require 가 없다", () => {
    const code = readFileSync(BUNDLE, 'utf-8')
    const specifiers = Array.from(code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)).map(
      (m) => m[1]
    )
    expect(specifiers.filter((s) => s !== 'electron')).toEqual([])
  })
})
