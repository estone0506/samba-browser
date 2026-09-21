// vault_items.fields JSON 의 인코딩·디코딩 순수 함수 모음.
// DB 에는 "섹션 > 필드" 구조로 담기며, secret 필드만 개별 AES-256-GCM 으로 암호화된다.
// electron 의존이 없어 테스트·마이그레이션에서 그대로 쓸 수 있다.

import type { FieldKind, VaultField, VaultSection } from '../../shared/vault'

// DB 에 저장되는 secret 필드 한 개. 값은 base64 암호문으로만 존재한다
export interface StoredSecretField {
  key: string
  label: string
  kind: 'secret'
  // base64
  ciphertext: string
  iv: string
  // 이 암호문을 만들 때 쓴 AAD. 생략되면 `${itemId}:${key}` 로 본다.
  // v1 → v2 로 옮겨 온 값은 재암호화 없이 그대로 두므로 aad 가 `String(itemId)` 다
  aad?: string
}

// DB 에 저장되는 평문 필드 한 개(url·select 등)
export interface StoredPlainField {
  key: string
  label: string
  kind: Exclude<FieldKind, 'secret'>
  value?: string
}

export type StoredField = StoredSecretField | StoredPlainField

export interface StoredSection {
  key: string
  label: string
  fields: StoredField[]
}

// 단일 값 항목(v1 이월분·간단한 항목)이 쓰는 기본 섹션/필드 키
export const DEFAULT_SECTION_KEY = 'main'
export const DEFAULT_FIELD_KEY = 'value'

export function isSecretField(f: StoredField): f is StoredSecretField {
  return f.kind === 'secret'
}

/** fields JSON 문자열을 파싱한다. 깨져 있으면 빈 배열(항목 자체는 살린다) */
export function parseFields(raw: string | null | undefined): StoredSection[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isStoredSection)
  } catch {
    return []
  }
}

function isStoredSection(v: unknown): v is StoredSection {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Partial<StoredSection>
  if (typeof s.key !== 'string' || typeof s.label !== 'string') return false
  return Array.isArray(s.fields) && s.fields.every(isStoredField)
}

function isStoredField(v: unknown): v is StoredField {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Partial<StoredSecretField>
  if (typeof f.key !== 'string' || typeof f.label !== 'string') return false
  if (f.kind === 'secret') return typeof f.ciphertext === 'string' && typeof f.iv === 'string'
  return f.kind === 'text' || f.kind === 'url' || f.kind === 'date' || f.kind === 'select'
}

export function serializeFields(sections: StoredSection[]): string {
  return JSON.stringify(sections)
}

/** 렌더러·AI 에 내보낼 메타로 바꾼다 — secret 필드의 값은 절대 포함하지 않는다 */
export function toMetaSections(sections: StoredSection[]): VaultSection[] {
  return sections.map((s) => ({
    key: s.key,
    label: s.label,
    fields: s.fields.map((f): VaultField =>
      isSecretField(f)
        ? { key: f.key, label: f.label, kind: 'secret' }
        : {
            key: f.key,
            label: f.label,
            kind: f.kind,
            ...(f.value === undefined ? {} : { value: f.value })
          }
    )
  }))
}

/** 필드 키로 저장된 필드를 찾는다(섹션을 가로질러 첫 일치) */
export function findField(sections: StoredSection[], key: string): StoredField | null {
  for (const section of sections) {
    const found = section.fields.find((f) => f.key === key)
    if (found) return found
  }
  // 필드 키는 'identity.phone'·'card.number' 처럼 종류가 앞에 붙는다. AI 가 뒤쪽만('phone') 넘겨도
  // 그 뜻이 하나로 정해지면 받아 준다(실기: identity 의 field 를 'phone' 으로 불러 값이 있어도 못 찾았다)
  const tail = `.${key}`
  const loose = sections.flatMap((s) => s.fields).filter((f) => f.key.endsWith(tail))
  return loose.length === 1 ? loose[0] : null
}

/** 이 필드의 암호문에 쓸 AAD. 저장된 aad 가 있으면 그것을(v1 이월분) 그대로 쓴다 */
export function aadFor(itemId: number, field: StoredSecretField): string {
  return field.aad ?? `${itemId}:${field.key}`
}

/** 새로 암호화할 때 쓰는 AAD */
export function newAad(itemId: number, fieldKey: string): string {
  return `${itemId}:${fieldKey}`
}

/** 섹션 목록에 필드를 끼워 넣거나 교체한다(섹션이 없으면 만든다) */
export function upsertField(
  sections: StoredSection[],
  sectionKey: string,
  sectionLabel: string,
  field: StoredField
): StoredSection[] {
  const next = sections.map((s) => ({ ...s, fields: [...s.fields] }))
  let section = next.find((s) => s.key === sectionKey)
  if (!section) {
    section = { key: sectionKey, label: sectionLabel, fields: [] }
    next.push(section)
  }
  const idx = section.fields.findIndex((f) => f.key === field.key)
  if (idx >= 0) section.fields[idx] = field
  else section.fields.push(field)
  return next
}
