// @vitest-environment jsdom
// 웹스토어가 크롬 전용 설치 기능이 없는 브라우저에서 'Chrome에 추가'를 disabled 로 막는다 — 훅이 다시 켠다
import { describe, it, expect } from 'vitest'
import { installWebstoreHook } from '../src/preload/page-webstore'

describe('installWebstoreHook — 막힌 추가 버튼 다시 켜기', () => {
  it('Chrome에 추가 버튼만 켜고, 페이지가 다시 막아도 다시 켠다', async () => {
    document.body.innerHTML =
      '<button id="add" disabled><span>Chrome에 추가</span></button><button id="other" disabled>공유</button>'
    installWebstoreHook({ install: () => {}, labels: () => ({ installing: '', done: '', failed: '' }) })
    const add = document.getElementById('add') as HTMLButtonElement
    expect(add.disabled).toBe(false)
    expect((document.getElementById('other') as HTMLButtonElement).disabled).toBe(true)
    add.disabled = true
    await new Promise((r) => setTimeout(r, 0))
    expect(add.disabled).toBe(false)
  })
})
