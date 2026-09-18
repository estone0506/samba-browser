// 내부 페이지 스킴(samba://) 경로 처리 — 개발 서버 전달과 디렉터리 탈출 차단

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { devTarget, safeJoin } from '../src/main/browser/internal-protocol'

const ROOT = resolve('out/renderer')

describe('devTarget', () => {
  it('루트 요청은 페이지 파일로 바꾸고 쿼리는 그대로 넘긴다', () => {
    expect(devTarget('http://localhost:5173/', 'newtab.html', '/', '?import')).toBe(
      'http://localhost:5173/newtab.html?import'
    )
  })

  it('자원 경로는 그대로 넘긴다', () => {
    expect(devTarget('http://localhost:5173', 'newtab.html', '/assets/app.js')).toBe(
      'http://localhost:5173/assets/app.js'
    )
  })
})

describe('safeJoin', () => {
  it('문서 루트 안의 경로만 돌려준다', () => {
    expect(safeJoin(ROOT, '/newtab.html')).toBe(resolve(ROOT, 'newtab.html'))
  })

  it('상위 디렉터리로 빠져나가는 경로는 거부한다', () => {
    expect(safeJoin(ROOT, '../package.json')).toBeNull()
    expect(safeJoin(ROOT, '%2e%2e/package.json')).toBeNull()
  })

  it('앞에 슬래시가 붙은 ../ 는 정규화 단계에서 루트로 접힌다', () => {
    expect(safeJoin(ROOT, '/../../package.json')).toBe(resolve(ROOT, 'package.json'))
  })

  it('잘못된 퍼센트 인코딩은 예외 대신 거부로 처리한다(403)', () => {
    expect(safeJoin(ROOT, '/%ZZ')).toBeNull()
    expect(safeJoin(ROOT, '/%')).toBeNull()
  })
})
