// 키마스터 내보내기 — CSV(크롬 호환) / JSON 직렬화와 내보내기 절차.
//
// 비밀값 규칙
// - 평문은 "사용자가 고른 파일" 안에만 존재한다. 로그·IPC 응답에는 개수와 경로만 담는다
// - 잠금 해제 상태 + 마스터 비밀번호 재입력 검증을 모두 통과해야만 평문을 꺼낸다
// - 저장 다이얼로그를 취소하면 평문을 꺼내기 전에 중단한다(파일도 감사 로그도 없음)
// - 파일을 쓴 직후 평문 배열의 참조를 끊는다(rows.length = 0)
//
// Electron 의존성은 주입받는다(ExportDeps) — 테스트에서 파일 쓰기·다이얼로그를 대체한다.

import { chmod, writeFile } from 'node:fs/promises'
import { DEFAULT_FIELD_KEY } from './fields'
import type {
  ExportFormat,
  ExportRequest,
  ExportResult,
  VaultItemType,
  VaultState
} from '../../shared/vault'

export type { ExportFormat, ExportRequest, ExportResult }

/** 크롬·웨일·엣지 비밀번호 관리자와 호환되는 CSV 헤더(가져오기 파서와 대칭) */
export const EXPORT_CSV_HEADER = 'name,url,username,password,note'

/** JSON 내보내기 스키마 버전 */
export const EXPORT_JSON_VERSION = 1

/** 저장 다이얼로그에 고정으로 노출하는 경고 문구(파일에 평문이 들어간다) */
export const EXPORT_WARNING =
  '내보낸 파일에는 비밀번호가 평문으로 들어갑니다. 저장 후 안전한 곳으로 옮기고 원본은 지우세요.'

/**
 * 내보낼 항목 한 줄. 평문이 담기므로 메인 프로세스 밖으로 나가지 않는다.
 * fields 는 "필드 키 → 평문" 이며 secret 필드는 복호화된 값이 들어 있다
 */
export interface ExportRow {
  type: VaultItemType
  label: string
  host: string
  url: string
  username: string
  note: string
  fields: Record<string, string>
}

/** 저장 다이얼로그에 넘길 정보. message·nameFieldLabel 에 경고 문구가 고정으로 실린다 */
export interface ExportSavePrompt {
  defaultPath: string
  filters: { name: string; extensions: string[] }[]
  message: string
  nameFieldLabel: string
}

/** 내보내기가 금고에 요구하는 최소 인터페이스(VaultService 가 구조적으로 만족한다) */
export interface ExportVaultLike {
  state: () => VaultState
  verifyMaster: (master: string) => Promise<boolean>
  exportRows: () => ExportRow[]
  logAudit: (action: string, source: string) => void
}

export interface ExportDeps {
  vault: ExportVaultLike
  /** 저장 위치를 고른다. 사용자가 취소하면 undefined */
  showSaveDialog: (prompt: ExportSavePrompt) => Promise<string | undefined>
  writeFile: (filePath: string, content: string) => Promise<void>
  /** 테스트에서 고정 시각을 주입한다 */
  now?: () => number
}

const CSV_FILTERS = [{ name: 'CSV', extensions: ['csv'] }]
const JSON_FILTERS = [{ name: 'JSON', extensions: ['json'] }]

/** CSV 한 칸을 RFC4180 으로 escape 한다(쉼표·따옴표·개행이 있으면 따옴표로 감싸고 " 는 "" 로) */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** CSV 의 password 칸에 넣을 값 — 단일 값 항목의 기본 필드('value')만 대상으로 한다 */
export function csvPassword(row: ExportRow): string {
  return row.fields[DEFAULT_FIELD_KEY] ?? ''
}

/**
 * CSV 로 표현 가능한 행인지. username·password 가 모두 있어야 한다 —
 * 가져오기 파서(parsePasswordCsv)가 둘 중 하나라도 비면 건너뛰므로 왕복이 깨지기 때문이다
 */
export function isCsvExportable(row: ExportRow): boolean {
  return row.username.length > 0 && csvPassword(row).length > 0
}

/** 행 목록을 크롬 호환 CSV 문자열로 만든다(줄바꿈은 RFC4180 의 CRLF) */
export function buildCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_CSV_HEADER]
  for (const row of rows) {
    lines.push(
      [row.label, row.url, row.username, csvPassword(row), row.note].map(escapeCsvCell).join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** 행 목록을 JSON 문자열로 만든다. url 은 fields.url 로 함께 보존한다 */
export function buildJson(rows: ExportRow[], now: number): string {
  const payload = {
    version: EXPORT_JSON_VERSION,
    exportedAt: new Date(now).toISOString(),
    items: rows.map((row) => ({
      type: row.type,
      label: row.label,
      host: row.host,
      username: row.username,
      // 계정 URL 은 별도 칸이 없으므로 같은 이름의 필드가 없을 때만 fields 에 얹는다
      fields:
        row.url && row.fields.url === undefined
          ? { url: row.url, ...row.fields }
          : { ...row.fields }
    }))
  }
  return JSON.stringify(payload, null, 2)
}

/** 확장자까지 붙인 기본 파일명(예: samba-keymaster-2026-09-19.csv) */
export function defaultExportFileName(format: ExportFormat, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10)
  return `samba-keymaster-${day}.${format}`
}

/**
 * 금고를 파일로 내보낸다.
 * 순서가 곧 안전장치다: 잠금 확인 → 마스터 재입력 검증 → 저장 위치 선택 → (여기서 처음)
 * 평문 복호화 → 파일 쓰기 → 평문 참조 해제 → 감사 로그.
 * 반환값에는 개수와 경로만 담고 값은 담지 않는다.
 */
export async function exportVault(deps: ExportDeps, req: ExportRequest): Promise<ExportResult> {
  if (deps.vault.state() !== 'unlocked') throw new Error('locked')
  if (!(await deps.vault.verifyMaster(req.master))) throw new Error('invalid-master')

  const now = deps.now?.() ?? Date.now()
  const filePath = await deps.showSaveDialog({
    defaultPath: defaultExportFileName(req.format, now),
    filters: req.format === 'csv' ? CSV_FILTERS : JSON_FILTERS,
    message: EXPORT_WARNING,
    nameFieldLabel: EXPORT_WARNING
  })
  if (!filePath) throw new Error('cancelled')

  const rows = deps.vault.exportRows()
  const selected = req.format === 'csv' ? rows.filter(isCsvExportable) : rows
  const content = req.format === 'csv' ? buildCsv(selected) : buildJson(selected, now)
  const itemCount = selected.length

  try {
    await deps.writeFile(filePath, content)
  } finally {
    // 평문이 담긴 배열은 파일 작성이 끝나는 즉시(실패해도) 비운다
    rows.length = 0
    selected.length = 0
  }

  deps.vault.logAudit('export', 'user')
  return { itemCount, filePath }
}

/** writeOwnerOnlyFile 이 쓰는 파일 조작(테스트에서 대체한다) */
export interface OwnerOnlyFs {
  writeFile: (
    filePath: string,
    content: string,
    options: { encoding: 'utf8'; mode: number }
  ) => Promise<void>
  chmod: (filePath: string, mode: number) => Promise<void>
}

/** 소유자만 읽고 쓸 수 있는 권한 */
const OWNER_ONLY_MODE = 0o600

/**
 * 평문이 담기는 파일을 소유자 전용 권한으로 쓴다.
 *
 * writeFile 의 mode 는 **파일을 새로 만들 때만** 적용된다 — 이미 있는 파일에 덮어쓰면
 * 예전 권한(예: 0o644)이 그대로 남는다. 그래서 쓴 뒤에 chmod 로 한 번 더 조인다.
 * Windows 처럼 POSIX 권한이 없는 곳에서는 chmod 가 의미가 없거나 실패할 수 있는데,
 * 그 때문에 내보내기 자체를 실패시키지는 않는다(파일은 이미 사용자가 고른 자리에 있다)
 */
export async function writeOwnerOnlyFile(
  filePath: string,
  content: string,
  fs: OwnerOnlyFs = { writeFile, chmod }
): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: OWNER_ONLY_MODE })
  try {
    await fs.chmod(filePath, OWNER_ONLY_MODE)
  } catch (e: unknown) {
    console.warn(
      '내보내기 파일 권한을 조이지 못했습니다',
      e instanceof Error ? e.message : String(e)
    )
  }
}
