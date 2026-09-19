import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Loader2, MessageSquare } from 'lucide-react'
import { isArmed, scheduleOf, type ScheduleResult, type ScheduleStatusDto } from '@shared/schedule'
import { useChatStore } from '@renderer/stores/chatStore'
import { usePlaybookStore } from '@renderer/stores/playbookStore'
import { useScheduleStore } from '@renderer/stores/scheduleStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { SecondaryButton } from '@renderer/components/settings/shared'
import { formatClock, relativeTime } from '@renderer/components/automation/schedule-view'
import { useNow } from '@renderer/lib/use-now'
import {
  TASK_PAGE_SIZE,
  chatRuns,
  hasMore,
  mergeTaskRuns,
  pageOf,
  scheduleRuns,
  type ChatRunInput,
  type TaskRun
} from '@renderer/lib/task-runs'
import { cn } from '@renderer/lib/utils'

/**
 * 작업 페이지 — "무엇이 돌고 있고, 뭐가 끝났나" 를 한 화면에 모은다.
 *
 *  1. 지금 실행 중: 채팅 러너 상태(진행 라벨·도구 횟수·n/N)와 [중단]
 *  2. 예약: 예약을 켠 플레이북의 다음 실행·상태, [지금 실행]·[일시정지/재개]
 *  3. 실행 이력: 예약 실행 기록과 채팅 기록을 시간 역순으로 합쳐 50건씩
 *
 * 데이터는 모두 이미 있는 경로를 다시 쓴다 — 예약은 schedule IPC, 이력의 채팅 쪽은
 * 기존 대화 목록·상세 IPC 다. 이 페이지 때문에 새로 저장되는 값은 없다
 */
export function TasksPage(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const openSettings = useUiStore((s) => s.openSettings)
  const status = useChatStore((s) => s.status)
  const currentLabel = useChatStore((s) => s.currentLabel)
  const toolCalls = useChatStore((s) => s.toolCalls)
  const taskProgress = useChatStore((s) => s.taskProgress)
  const playbooks = usePlaybookStore((s) => s.items)
  const loadPlaybooks = usePlaybookStore((s) => s.load)
  const scheduleById = useScheduleStore((s) => s.byId)
  const loadSchedules = useScheduleStore((s) => s.load)
  const runNow = useScheduleStore((s) => s.runNow)
  const setPaused = useScheduleStore((s) => s.setPaused)
  const [chats, setChats] = useState<ChatRunInput[] | null>(null)
  const [page, setPage] = useState(1)

  useEffect(() => {
    void loadPlaybooks()
    void loadSchedules()
  }, [loadPlaybooks, loadSchedules])
  // 메인이 예약 상태를 바꾸면(실행 시작·완료·자동 일시정지) 다시 읽는다
  useEffect(() => useScheduleStore.getState().subscribe(), [])

  // 채팅 이력은 한 쪽(50건)씩 늘려 읽는다. 작업이 끝나면 목록이 바뀌므로 status 도 본다
  useEffect(() => {
    let cancelled = false
    void loadChatRuns(page * TASK_PAGE_SIZE).then((rows) => {
      if (!cancelled) setChats(rows)
    })
    return () => {
      cancelled = true
    }
  }, [page, status])

  const nameOf = useCallback(
    (playbookId: string): string | undefined => playbooks.find((p) => p.id === playbookId)?.name,
    [playbooks]
  )

  const runs = useMemo(
    () => mergeTaskRuns(scheduleRuns(Object.values(scheduleById), nameOf), chatRuns(chats ?? [])),
    [scheduleById, nameOf, chats]
  )
  const shown = pageOf(runs, page)

  // 예약을 켠(수동이 아닌) 플레이북만 '예약' 칸에 세운다
  const scheduled = useMemo(() => {
    const rows: { id: string; name: string; status: ScheduleStatusDto }[] = []
    for (const playbook of playbooks) {
      const status = scheduleById[playbook.id]
      if (status !== undefined && isArmedOrPaused(status))
        rows.push({ id: playbook.id, name: playbook.name, status })
    }
    return rows
  }, [playbooks, scheduleById])

  const running = status === 'running'
  // 예약이 돌린 실행이면 어떤 플레이북인지 함께 보여 준다
  const runningName = Object.values(scheduleById).find((s) => s.state === 'running')?.playbookId
  const openChat = (chatId: number): void => {
    void useChatStore.getState().openChat(chatId)
    const ui = useUiStore.getState()
    ui.setView('browser')
    if (ui.panelCollapsed) ui.setPanelCollapsed(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 p-6">
        <header>
          <h1 className="text-[15px] font-semibold text-[var(--text)]">{t('tasks.title')}</h1>
          <p className="mt-1 text-[11.5px] leading-snug text-[var(--text2)]">{t('tasks.desc')}</p>
        </header>

        {/* 1. 지금 실행 중 */}
        <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
          <h2 className="text-[13px] font-semibold text-[var(--text)]">
            {t('tasks.running.title')}
          </h2>
          {running ? (
            <div className="mt-2.5 flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text2)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] text-[var(--text)]">
                  {currentLabel || t('chat.thinking')}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text3)]">
                  {runningName !== undefined && (
                    <span className="rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
                      {t('tasks.running.scheduled')} · {nameOf(runningName) ?? runningName}
                    </span>
                  )}
                  {taskProgress && (
                    <span className="tabular-nums">
                      {taskProgress.done}/{taskProgress.total}
                    </span>
                  )}
                  <span className="tabular-nums">{t('tasks.running.steps', { n: toolCalls })}</span>
                </p>
              </div>
              <SecondaryButton onClick={() => void useChatStore.getState().stop()}>
                {t('tasks.running.stop')}
              </SecondaryButton>
            </div>
          ) : (
            <p className="mt-2 text-[11.5px] text-[var(--text3)]">{t('tasks.running.empty')}</p>
          )}
        </section>

        {/* 2. 예약된 것 */}
        <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
          <h2 className="text-[13px] font-semibold text-[var(--text)]">
            {t('tasks.scheduled.title')}
          </h2>
          {scheduled.length === 0 ? (
            <p className="mt-2 text-[11.5px] text-[var(--text3)]">{t('tasks.scheduled.empty')}</p>
          ) : (
            <ul className="mt-2 flex flex-col">
              {scheduled.map((row) => (
                <ScheduledRow
                  key={row.id}
                  name={row.name}
                  status={row.status}
                  runDisabled={running}
                  onOpen={() => openSettings('automation')}
                  onRunNow={() => void runNow(row.id)}
                  onTogglePause={() => void setPaused(row.id, !row.status.schedule.paused)}
                />
              ))}
            </ul>
          )}
        </section>

        {/* 3. 실행 이력 */}
        <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
          <h2 className="text-[13px] font-semibold text-[var(--text)]">
            {t('tasks.history.title')}
          </h2>
          {chats === null ? (
            <p className="mt-2 text-[11.5px] text-[var(--text3)]">{t('tasks.history.loading')}</p>
          ) : shown.length === 0 ? (
            <p className="mt-2 text-[11.5px] text-[var(--text3)]">{t('tasks.history.empty')}</p>
          ) : (
            <ul className="mt-2 flex flex-col">
              {shown.map((run) => (
                <HistoryRow
                  key={run.key}
                  run={run}
                  locale={i18n.language}
                  onOpen={() =>
                    run.chatId === null ? openSettings('automation') : openChat(run.chatId)
                  }
                />
              ))}
            </ul>
          )}
          {chats !== null && hasMore(runs, page) && (
            <div className="mt-2.5 flex justify-center">
              <SecondaryButton onClick={() => setPage(page + 1)}>
                {t('tasks.history.more')}
              </SecondaryButton>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ScheduledRow({
  name,
  status,
  runDisabled,
  onOpen,
  onRunNow,
  onTogglePause
}: {
  name: string
  status: ScheduleStatusDto
  runDisabled: boolean
  onOpen: () => void
  onRunNow: () => void
  onTogglePause: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 상대 시간("2시간 후")이 멈춰 있지 않도록 예약 카드와 같은 시계를 쓴다
  const now = useNow()
  const when = status.nextRunAt === null ? null : relativeTime(status.nextRunAt, now)
  return (
    <li className="flex items-center gap-2 border-b border-[var(--line)] py-2 last:border-b-0">
      <button
        type="button"
        // 줄을 누르면 설정 → 자동화로 간다(그 카드에서 시각·모델·권한을 고친다)
        onClick={onOpen}
        title={t('tasks.scheduled.open')}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <span className="block truncate text-[12.5px] text-[var(--text)]">{name}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[var(--text3)]">
          {t(`schedule.state.${status.state}`)}
          {status.pauseReason !== undefined &&
            ` · ${t(`schedule.pauseReason.${status.pauseReason}`)}`}
          {when !== null && ` · ${t('schedule.next', { when: t(when.key, when.params) })}`}
        </span>
      </button>
      <SecondaryButton disabled={runDisabled} onClick={onRunNow}>
        {t('schedule.action.runNow')}
      </SecondaryButton>
      <SecondaryButton onClick={onTogglePause}>
        {t(status.schedule.paused ? 'schedule.action.resume' : 'schedule.action.pause')}
      </SecondaryButton>
    </li>
  )
}

function HistoryRow({
  run,
  locale,
  onOpen
}: {
  run: TaskRun
  locale: string
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = run.source === 'schedule' ? CalendarClock : MessageSquare
  return (
    <li className="border-b border-[var(--line)] last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-start gap-2.5 py-2 text-left hover:bg-black/[.03]"
      >
        <span className="w-[76px] shrink-0 pt-0.5 text-[11px] tabular-nums text-[var(--text3)]">
          {formatClock(run.at, locale)}
        </span>
        <Icon
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text3)]"
          aria-label={t(`tasks.source.${run.source}`)}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-[var(--text)]">
            {run.title || t('tasks.untitled')}
          </span>
          {run.summary !== '' && (
            <span className="mt-0.5 block truncate text-[11px] text-[var(--text3)]">
              {run.summary}
            </span>
          )}
        </span>
        {run.result !== null && (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px]',
              resultTone(run.result)
            )}
          >
            {t(`schedule.result.${run.result}`)}
          </span>
        )}
      </button>
    </li>
  )
}

/** 결과 배지 색 — 성공만 눈에 띄게 하고 나머지는 조용히 둔다 */
function resultTone(result: ScheduleResult): string {
  if (result === 'ok') return 'bg-[#e8f5ec] text-[#166534]'
  if (result === 'failed') return 'bg-[#fdeaea] text-[#b91c1c]'
  return 'bg-[var(--bg)] text-[var(--text2)]'
}

/** 예약 칸에 세울 줄인가(예약을 켰다면 일시정지 중이어도 보여 준다) */
function isArmedOrPaused(status: ScheduleStatusDto): boolean {
  const schedule = scheduleOf(status.schedule)
  return isArmed(schedule) || (schedule.enabled && schedule.kind !== 'manual')
}

/**
 * 채팅 기록을 이력 줄의 재료로 읽는다.
 * 목록 IPC 로 대화를 고르고, 대화마다 상세를 읽어 첫 사용자 지시와 마지막 AI 응답만 꺼낸다
 */
async function loadChatRuns(limit: number): Promise<ChatRunInput[]> {
  const list = await window.samba.chats?.list(limit)
  if (!list?.ok) return []
  const details = await Promise.all(list.data.map((chat) => window.samba.chats.get(chat.id)))
  return list.data.map((chat, i) => {
    const detail = details[i]
    const messages = detail?.ok && detail.data !== null ? detail.data.messages : []
    const prompt = messages.find((m) => m.role === 'user')?.content ?? chat.title
    const lastText = [...messages].reverse().find((m) => m.role !== 'user')?.content ?? ''
    return { id: chat.id, at: chat.updatedAt, prompt, lastText }
  })
}
