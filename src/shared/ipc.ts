import type { PageSnapshot } from './snapshot'

// 렌더러 ↔ 메인 IPC 채널 이름. 문자열 하드코딩 금지
export const IPC = {
  tabList: 'tab:list',
  tabCreate: 'tab:create',
  tabClose: 'tab:close',
  tabActivate: 'tab:activate',
  tabNavigate: 'tab:navigate',
  tabBack: 'tab:back',
  tabForward: 'tab:forward',
  tabReload: 'tab:reload',
  tabSetMobile: 'tab:setMobile',
  tabUpdated: 'tab:updated', // main → renderer 이벤트
  layoutSet: 'layout:set',
  agentRun: 'agent:run',
  agentStop: 'agent:stop',
  agentEvent: 'agent:event', // main → renderer 이벤트
  agentConfirmReply: 'agent:confirmReply',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set'
} as const

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

// agent:run 의 즉시 응답. 작업 완료 여부가 아니라 "시작을 받았다"는 뜻만 담는다
export interface AgentRunAck {
  started: boolean
}

export interface TabInfo {
  id: string
  url: string
  title: string
  profile: string
  mobile: boolean
  loading: boolean
  active: boolean
}

// 렌더러가 메인에 알려주는 웹뷰 영역(사이드바·패널 제외)
export interface Layout {
  x: number
  y: number
  width: number
  height: number
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; label: string; ok: boolean }
  | { type: 'confirm'; requestId: string; action: string }
  // 진행 상황만 알리는 이벤트(도구 호출 아님). 지금은 SDK 재시도 대기 표시에 쓴다
  | { type: 'progress'; kind: 'apiRetry'; attempt: number; reason: string }
  | {
      type: 'status'
      state: 'running' | 'done' | 'failed' | 'stopped'
      message?: string
      toolCalls?: number
    }

// Settings 는 shared/settings.ts 의 zod 스키마에서 파생된 타입 (z.infer)
export type { Settings } from './settings'

export type { PageSnapshot }
