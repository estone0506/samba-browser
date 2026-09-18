// 비밀번호 관리자 CSV(크롬/웨일/엣지/비트워든/사파리/키퍼/파이어폭스) 가져오기 파서
// 순수 함수 — Electron 의존성 없음. 행 내용은 절대 로그로 남기지 않는다.

import Papa from 'papaparse'
import { normalizeHost } from '../../shared/host'

export interface ParsedLogin {
  name: string
  url: string
  host: string
  username: string
  password: string
  note: string
}

// 필드별 헤더 별칭(소문자 기준, 우선순위 순서)
const NAME_KEYS = ['name', 'title']
const URL_KEYS = ['url', 'login_uri']
const USERNAME_KEYS = ['username', 'login_username']
const PASSWORD_KEYS = ['password', 'login_password']
const NOTE_KEYS = ['note', 'notes']

// 공용 호스트 정규화 함수를 그대로 재수출한다(호출부 변경 없이 src/shared/host.ts 로 로직 이전)
export { normalizeHost }

/** 헤더 키(대소문자 무관)를 실제 파싱된 컬럼명으로 매핑한다 */
function buildKeyMap(fields: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const field of fields) {
    map.set(field.trim().toLowerCase(), field)
  }
  return map
}

/** candidates 순서대로 헤더 별칭을 찾아 값을 반환한다. 없으면 빈 문자열 */
function pickField(
  row: Record<string, string>,
  keyMap: Map<string, string>,
  candidates: string[]
): string {
  for (const candidate of candidates) {
    const originalKey = keyMap.get(candidate)
    if (originalKey === undefined) continue
    const value = row[originalKey]
    if (value !== undefined && value !== null) return value.trim()
  }
  return ''
}

/**
 * 비밀번호 CSV 텍스트를 파싱한다.
 * 따옴표로 감싼 쉼표·개행은 papaparse 가 처리한다.
 * username 또는 password 가 비어있는 행은 skipped 로 카운트하고 결과에서 제외한다.
 */
export function parsePasswordCsv(text: string): { rows: ParsedLogin[]; skipped: number } {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true
  })

  const fields = parsed.meta.fields ?? []
  const keyMap = buildKeyMap(fields)

  const rows: ParsedLogin[] = []
  let skipped = 0

  for (const raw of parsed.data) {
    const username = pickField(raw, keyMap, USERNAME_KEYS)
    const password = pickField(raw, keyMap, PASSWORD_KEYS)

    if (!username || !password) {
      skipped += 1
      continue
    }

    const url = pickField(raw, keyMap, URL_KEYS)
    const note = pickField(raw, keyMap, NOTE_KEYS)
    const host = normalizeHost(url)

    let name = pickField(raw, keyMap, NAME_KEYS)
    if (!name) name = host || url

    rows.push({ name, url, host, username, password, note })
  }

  return { rows, skipped }
}
