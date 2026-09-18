import { contextBridge } from 'electron'
import { buildSnapshot, performClick, performType, performSelect, performScroll } from './page-core'

// AI 실행기. 메인 프로세스가 executeJavaScript('window.__samba.snapshot()')로 호출
contextBridge.exposeInMainWorld('__samba', {
  snapshot: () => buildSnapshot(),
  click: (id: number) => performClick(id),
  type: (id: number, text: string, submit: boolean) => performType(id, text, submit),
  select: (id: number, value: string) => performSelect(id, value),
  scroll: (dir: 'up' | 'down') => performScroll(dir)
})
