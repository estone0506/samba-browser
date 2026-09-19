// 번역용 1회성 모델 호출. 설정된 AI 연결 경로(Claude 구독 / 내 API 키)를 그대로 쓴다.
//
// agent/provider.ts 의 runQuery 를 재사용하므로 평문 API 키를 이 파일이 만질 일이 없다.
// 도구는 하나도 붙이지 않는다 — 번역은 "프롬프트 한 덩어리 → 텍스트 한 덩어리" 호출이다.
//
// 이 모듈은 Claude Agent SDK 를 import 하므로, 테스트는 service.ts 쪽 가짜 ask 를 쓴다.

import { runQuery } from '../agent/provider'
import type { AskText } from './service'

// 한 배치(최대 30노드·1200자)의 번역에 주는 시간. 배치가 작아진 만큼 대기도 짧게 끊는다
const ASK_TIMEOUT_MS = 30_000

export function createSdkAsk(): AskText {
  return async ({ model, system, prompt }) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), ASK_TIMEOUT_MS)
    timer.unref?.()
    let text = ''
    try {
      const stream = runQuery({
        prompt,
        systemPrompt: system,
        model,
        mcpServers: {},
        allowedTools: [],
        abort
      })
      for await (const message of stream) {
        if (abort.signal.aborted) break
        if (message.type !== 'assistant') continue
        for (const block of message.message.content) {
          if (block.type === 'text') text += block.text
        }
      }
    } catch (e) {
      // 실패 사유에 원문이 실릴 수 있어 메시지만 짧게 남긴다
      console.warn('번역 호출 실패', e instanceof Error ? e.message : '')
      return null
    } finally {
      clearTimeout(timer)
    }
    return text.trim() || null
  }
}
