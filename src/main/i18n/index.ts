// 메인 프로세스 문구 번역.
//
// 메인이 만든 오류·알림 문구는 렌더러가 그대로 화면에 띄운다(r.error 등).
// 그래서 문구를 만드는 시점에 앱 언어(설정 language)를 따라 고른다.
// 사전은 영역별 파일(messages/*)로 나누고, en 은 ko 와 같은 키를 모두 가져야 한다(타입으로 강제).
// 로그·AI 지시문은 대상이 아니다 — 사람이 화면에서 읽는 문구만 여기로 모은다.

import { captureMessages } from './messages/capture'
import { extensionMessages } from './messages/extensions'
import { ipcMessages } from './messages/ipc'
import { phoneMessages } from './messages/phone'
import { syncMessages } from './messages/sync'
import { vaultMessages } from './messages/vault'
import { workspaceMessages } from './messages/workspace'

export type MainLanguage = 'ko' | 'en'

const ko = {
  ...captureMessages.ko,
  ...extensionMessages.ko,
  ...ipcMessages.ko,
  ...phoneMessages.ko,
  ...syncMessages.ko,
  ...vaultMessages.ko,
  ...workspaceMessages.ko
}

export type MessageKey = keyof typeof ko

const en: Record<MessageKey, string> = {
  ...captureMessages.en,
  ...extensionMessages.en,
  ...ipcMessages.en,
  ...phoneMessages.en,
  ...syncMessages.en,
  ...vaultMessages.en,
  ...workspaceMessages.en
}

const dictionaries: Record<MainLanguage, Record<MessageKey, string>> = { ko, en }

// 설정을 읽기 전에도 문구가 필요할 수 있어 기본은 앱 기본 언어(ko)
let current: MainLanguage = 'ko'

/** 앱 언어를 바꾼다. 설정을 읽거나 바꿀 때 SettingsStore 가 부른다 */
export function setMainLanguage(language: MainLanguage): void {
  current = language
}

export function getMainLanguage(): MainLanguage {
  return current
}

/** 키에 맞는 문구. {name} 자리는 vars 값으로 채운다 */
export function tr(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[current][key] ?? ko[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}
