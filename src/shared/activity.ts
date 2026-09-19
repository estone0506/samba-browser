// 활동 기록 공유 타입·순수 함수. 메인(기록·읽기)과 분석기(patterns)가 함께 쓴다.
//
// 무엇을 적지 않는가가 이 파일의 핵심이다.
//  - 지시문은 **마스킹을 거친 뒤** 앞부분만 적는다(shared/notify 의 maskSecrets 를 그대로 쓴다).
//  - 사이트는 **호스트만** 적는다. 전체 URL·검색어·페이지 제목·본문·폼 입력은 적지 않는다.
//  - 파일은 이 기기의 userData 안에만 있고 동기화 대상이 아니다.
//
// 저장 형식은 월별 JSONL 이다. 한 줄이 깨져도 그 줄만 버리면 되고, 오래된 달은
// 파일 하나를 지우는 것으로 만료된다(90일).

import { z } from 'zod'
import { maskSecrets } from './notify'

/** 기록에 남기는 지시문 앞부분 길이. 분석에 쓸 만큼만 남기고 자른다 */
export const ACTIVITY_PROMPT_MAX = 200
/** 이 일수가 지난 달의 파일은 통째로 지운다 */
export const ACTIVITY_RETENTION_DAYS = 90
/** 호스트 한 칸의 길이 상한(이상한 값이 들어와도 파일이 부풀지 않게) */
export const ACTIVITY_HOST_MAX = 120

export const DAY_MS = 86_400_000

/** AI 에게 내린 지시 한 건과 그 결과 */
export interface ActivityRunRecord {
  t: 'run'
  /** 실행이 끝난 시각 */
  at: number
  /** 마스킹·절단된 사용자 지시 */
  prompt: string
  ok: boolean
  /** 걸린 시간(ms) */
  ms: number
  /** 이 실행에 적용된 플레이북 이름(있을 때만) */
  playbook?: string
}

/** 탭에 머문 사이트 한 건. 호스트와 머문 시간(분)만 남는다 */
export interface ActivityVisitRecord {
  t: 'visit'
  /** 탭이 활성화된 시각 */
  at: number
  host: string
  /** 머문 시간(분 단위 반올림) */
  minutes: number
}

export type ActivityRecord = ActivityRunRecord | ActivityVisitRecord

export const activityRunSchema = z.object({
  t: z.literal('run'),
  at: z.number(),
  prompt: z.string().max(ACTIVITY_PROMPT_MAX),
  ok: z.boolean(),
  ms: z.number().min(0),
  playbook: z.string().max(200).optional()
})

export const activityVisitSchema = z.object({
  t: z.literal('visit'),
  at: z.number(),
  host: z.string().min(1).max(ACTIVITY_HOST_MAX),
  minutes: z.number().int().min(0)
})

export const activityRecordSchema = z.union([activityRunSchema, activityVisitSchema])

/**
 * 기록에 남길 지시문으로 다듬는다.
 * 마스킹 → 공백 정리 → 자르기 순서를 지킨다. 자른 뒤에 마스킹하면
 * 잘린 자리에서 비밀값이 살아남을 수 있다
 */
export function sanitizePrompt(raw: string): string {
  const masked = maskSecrets(raw).replace(/\s+/g, ' ').trim()
  return masked.slice(0, ACTIVITY_PROMPT_MAX)
}

/** ms → 분 단위 반올림(음수는 0) */
export function toMinutes(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.round(ms / 60_000)
}

/** 그 시각이 속한 달의 파일 이름(로컬 시각 기준) */
export function activityFileName(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${month}.jsonl`
}

const FILE_NAME_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])\.jsonl$/

export function isActivityFileName(name: string): boolean {
  return FILE_NAME_PATTERN.test(name)
}

/**
 * 90일이 지나 지워야 할 파일 이름들.
 * 그 달의 **마지막 순간**을 기준으로 재므로, 달 안의 마지막 기록까지 90일을 보장한다
 */
export function expiredActivityFiles(names: readonly string[], now: number): string[] {
  const limit = now - ACTIVITY_RETENTION_DAYS * DAY_MS
  return names.filter((name) => {
    const m = FILE_NAME_PATTERN.exec(name)
    if (!m) return false
    // 다음 달 1일 0시 = 이 달의 끝
    const end = new Date(Number(m[1]), Number(m[2]), 1).getTime()
    return end <= limit
  })
}

/** JSONL 한 줄 → 기록. 깨진 줄은 null(그 줄만 버린다) */
export function parseActivityLine(line: string): ActivityRecord | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const parsed = activityRecordSchema.safeParse(JSON.parse(trimmed))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** 기록 → JSONL 한 줄(줄바꿈 포함) */
export function serializeActivityRecord(record: ActivityRecord): string {
  return `${JSON.stringify(record)}\n`
}

/** 여러 줄을 한꺼번에 읽는다(깨진 줄은 조용히 버린다) */
export function parseActivityLines(text: string): ActivityRecord[] {
  const out: ActivityRecord[] = []
  for (const line of text.split('\n')) {
    const record = parseActivityLine(line)
    if (record) out.push(record)
  }
  return out
}
