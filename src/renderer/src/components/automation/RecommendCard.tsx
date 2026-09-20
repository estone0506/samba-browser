import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import type { RecommendDto } from '@shared/activity-patterns'
import { PrimaryButton, SecondaryButton } from '@renderer/components/settings/shared'
import { relativeTime, weekdayLabelKey } from './schedule-view'
import { actionKeyOf, sentenceOf, summaryOf } from './recommend-view'

/**
 * 추천 목록 — 설정 → 자동화 맨 위에만 그린다(채팅에는 넣지 않는다).
 * 후보가 없으면 호출부가 아예 그리지 않으므로 여기서 빈 목록은 다루지 않는다
 */
export function RecommendCard({
  items,
  failed,
  onApply,
  onDismiss
}: {
  items: RecommendDto[]
  failed: boolean
  onApply: (key: string) => void
  onDismiss: (key: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // "마지막 실행 10분 전" 이 멈춰 있지 않게 30초마다 시계를 다시 읽는다(예약 카드와 같은 방식)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-[var(--text2)]" />
        <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('recommend.title')}</h2>
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-[var(--text2)]">{t('recommend.desc')}</p>
      {failed && (
        <p className="mt-2 rounded-[9px] border border-[#b91c1c] px-2.5 py-2 text-[11.5px] text-[#b91c1c]">
          {t('recommend.failed')}
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-2.5">
        {items.map((item) => {
          const weekday = item.weekday === undefined ? '' : t(weekdayLabelKey(item.weekday))
          const sentence = sentenceOf(item, weekday)
          const summary = summaryOf(item, weekday)
          const last = relativeTime(item.lastAt, now)
          const actionKey = actionKeyOf(item)
          return (
            <li
              key={item.key}
              className="rounded-[11px] border border-[var(--line)] px-3 py-2.5 last:mb-0"
            >
              {/* 한 줄 요약(사용자 요청) — 아래 문장은 근거 설명 */}
              <p className="truncate text-[12.5px] font-medium text-[var(--text)]">
                {t(summary.key, summary.params)}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--text2)]">
                {t(sentence.key, sentence.params)}
              </p>
              <p className="mt-1 text-[11px] text-[var(--text2)]">
                {t('recommend.evidence', {
                  count: item.count,
                  days: item.spanDays,
                  last: t(last.key, last.params)
                })}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {actionKey !== null && (
                  <PrimaryButton onClick={() => onApply(item.key)}>{t(actionKey)}</PrimaryButton>
                )}
                <SecondaryButton onClick={() => onDismiss(item.key)}>
                  {t('recommend.action.dismiss')}
                </SecondaryButton>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
