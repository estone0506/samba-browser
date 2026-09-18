// supabase-js 세션 저장소. refresh token 이 평문으로 디스크에 남지 않게
// safeStorage(Windows DPAPI)로 감싸 파일 하나에 보관한다.
// 어떤 값도 렌더러로 나가지 않는다

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export interface SessionStorageAdapter {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function createSessionStore(
  filePath: string,
  safeStorage?: SafeStorageLike
): SessionStorageAdapter {
  const canEncrypt = (): boolean => !!safeStorage && safeStorage.isEncryptionAvailable()

  const readAll = (): Record<string, string> => {
    if (!existsSync(filePath)) return {}
    try {
      const raw = readFileSync(filePath)
      // 암호화가 불가능한 환경이면 파일을 신뢰하지 않고 버린다(평문 저장은 하지 않는다)
      if (!canEncrypt()) return {}
      const json: unknown = JSON.parse(safeStorage!.decryptString(raw))
      if (typeof json !== 'object' || json === null) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    } catch {
      // 다른 PC 의 DPAPI 로 만든 파일 등 — 조용히 버리고 다시 로그인하게 둔다
      return {}
    }
  }

  const writeAll = (data: Record<string, string>): void => {
    if (!canEncrypt()) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, safeStorage!.encryptString(JSON.stringify(data)))
    } catch (e: unknown) {
      // 실패 사유만 남긴다 — 값은 절대 로그에 넣지 않는다
      console.error('세션 저장 실패', e instanceof Error ? e.message : String(e))
    }
  }

  return {
    getItem: (key) => readAll()[key] ?? null,
    setItem: (key, value) => {
      const data = readAll()
      data[key] = value
      writeAll(data)
    },
    removeItem: (key) => {
      const data = readAll()
      delete data[key]
      if (Object.keys(data).length === 0) {
        try {
          if (existsSync(filePath)) unlinkSync(filePath)
        } catch {
          // 파일이 이미 없으면 할 일 없음
        }
        return
      }
      writeAll(data)
    }
  }
}
