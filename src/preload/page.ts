import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import {
  buildSnapshot,
  textOf,
  performClick,
  performType,
  performSelect,
  performScroll,
  fillValue,
  findLoginFields,
  submitForm,
  installCaptureListener
} from './page-core'

// AI 실행기. contextIsolation 이 켜져 있으면 preload 는 격리 월드(WorldId 999)에서 실행되므로
// contextBridge 로 메인 월드에 노출하지 않고 격리 월드 전역에만 둔다.
// 메인 프로세스는 executeJavaScriptInIsolatedWorld(999, '__samba.snapshot()') 로 호출한다.
// → 적대 페이지가 __samba 를 가로채거나 프로토타입 오염으로 결과를 왜곡할 수 없다.
const api = {
  snapshot: () => buildSnapshot(),
  // 요소의 실제 텍스트 조회(위험 행동 판정용)
  textOf: (id: number) => textOf(id),
  click: (id: number) => performClick(id),
  type: (id: number, text: string, submit: boolean) => performType(id, text, submit),
  select: (id: number, value: string) => performSelect(id, value),
  scroll: (dir: 'up' | 'down') => performScroll(dir),
  // SECRET 허용 — 메인 프로세스만 호출(AI 텍스트 도구 경로가 아님)
  fillValue: (id: number, value: string) => fillValue(id, value),
  findLoginFields: () => findLoginFields(),
  submitForm: (id: number) => submitForm(id)
}

export type SambaPageApi = typeof api

// globalThis 에 직접 대입(any 없이 타입 안전하게)
Object.assign(globalThis, { __samba: api })

// 폼 제출 감지 → 메인의 vault:capture 로 전달(비밀번호는 이 채널로만, pendingCapture 에만 잠깐 머문다)
// 격리 월드 preload 는 contextIsolation 하에서도 ipcRenderer 를 직접 사용할 수 있다
// 옵션 없이 호출 → 합성(스크립트 생성) 이벤트는 무시하고 신뢰된(isTrusted) 사용자 이벤트만 처리한다
installCaptureListener((payload) => ipcRenderer.send(IPC.vaultCapture, payload))
