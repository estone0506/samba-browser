import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Square, X } from 'lucide-react'
import { useChatStore } from '@renderer/stores/chatStore'
import { imageFilesOf, readAgentImage } from '@renderer/lib/paste-image'
import {
  addToHistory,
  draftCursor,
  loadInputHistory,
  saveInputHistory,
  stepHistory,
  type HistoryCursor
} from '@renderer/lib/input-history'
import { AGENT_IMAGE_MAX_COUNT, agentImageDataUrl, type AgentImage } from '@shared/agent-image'
import { PermissionMenu } from './PermissionMenu'
import { ModelEffortMenu } from './ModelEffortMenu'

export function ChatInput(): React.JSX.Element {
  const { t } = useTranslation()
  const { send, status, stop } = useChatStore()
  const [text, setText] = useState('')
  // 클립보드에서 붙여 넣은 이미지. 보내면 비운다
  const [images, setImages] = useState<AgentImage[]>([])
  const [note, setNote] = useState('')
  // 보낸 문장 이력 — ↑/↓ 로 다시 꺼낸다(터미널과 같은 동작)
  const [history, setHistory] = useState<string[]>(loadInputHistory)
  const [cursor, setCursor] = useState<HistoryCursor>(() => draftCursor(loadInputHistory()))
  const submit = (): void => {
    const v = text.trim()
    // 그림만 붙이고 글이 없어도 보낼 수 있다(모델이 그림을 보고 묻게)
    if (!v && images.length === 0) return
    const nextHistory = addToHistory(history, v)
    setHistory(nextHistory)
    setCursor(draftCursor(nextHistory))
    saveInputHistory(nextHistory)
    setText('')
    setImages([])
    setNote('')
    void send(v, undefined, images.length > 0 ? images : undefined)
  }
  // 붙여넣기에 이미지가 들어 있으면 글 대신 그림으로 받는다(텍스트 붙여넣기는 그대로)
  const onPaste = async (e: React.ClipboardEvent<HTMLInputElement>): Promise<void> => {
    const files = imageFilesOf(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    const room = AGENT_IMAGE_MAX_COUNT - images.length
    if (room <= 0) {
      setNote(t('chat.imageTooMany', { max: AGENT_IMAGE_MAX_COUNT }))
      return
    }
    const added: AgentImage[] = []
    let error = ''
    for (const file of files.slice(0, room)) {
      const r = await readAgentImage(file)
      if (typeof r === 'string') {
        error = r === 'too-large' ? t('chat.imageTooLarge') : ''
        continue
      }
      added.push(r)
    }
    if (files.length > room) error = t('chat.imageTooMany', { max: AGENT_IMAGE_MAX_COUNT })
    setImages((prev) => [...prev, ...added])
    setNote(error)
  }
  return (
    <div className="border-t border-black/5 p-3">
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img
                src={agentImageDataUrl(img)}
                alt=""
                className="h-14 w-14 rounded-lg border border-[var(--line)] object-cover"
              />
              <button
                type="button"
                aria-label={t('chat.imageRemove')}
                onClick={() => setImages((prev) => prev.filter((_, k) => k !== i))}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--text)] text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <span className="text-[11px] text-[var(--text2)]">
            {t('chat.imagePasted', { n: images.length })}
          </span>
        </div>
      )}
      {note && <p className="mb-1.5 text-[11px] text-[#b91c1c]">{note}</p>}
      <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // 직접 고치기 시작하면 그 글이 새 '쓰던 글'이다
            setCursor(draftCursor(history))
          }}
          onPaste={(e) => void onPaste(e)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') return submit()
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            const step = stepHistory(history, cursor, e.key === 'ArrowUp' ? 'older' : 'newer', text)
            if (!step) return
            e.preventDefault()
            setCursor(step.cursor)
            setText(step.value)
          }}
          placeholder={t('chat.placeholder')}
          disabled={status === 'running'}
          className="flex-1 bg-transparent outline-none"
        />
        {status === 'running' ? (
          // 실행 중에는 보내기 자리에 중단 버튼 — 위쪽 진행 바가 안 보여도 여기서 멈출 수 있다
          <button
            onClick={() => void stop()}
            aria-label={t('chat.stop')}
            title={t('chat.stop')}
            className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-[var(--text)] text-white"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        ) : (
          <button
            onClick={submit}
            className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-[var(--text)] text-white disabled:opacity-40"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {/* 권한 모드 옆에 모델 · 추론 강도 선택(Aside 하단 줄과 같은 자리) */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PermissionMenu />
        <ModelEffortMenu />
      </div>
    </div>
  )
}
