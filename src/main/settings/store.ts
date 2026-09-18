import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { parseSettings, type Settings } from '../../shared/settings'
import { SYNCED_SETTING_KEYS, type OutboxRecorder } from '../../shared/sync'

// %APPDATA%/samba-browser/config.json
export class SettingsStore {
  private file = join(app.getPath('userData'), 'config.json')
  private cache: Settings
  // 동기화 변경 로그 훅. 주입하지 않으면 아무 일도 하지 않는다(동기화를 끈 상태)
  private outbox: OutboxRecorder | null = null

  constructor() {
    this.cache = this.load()
  }

  /** 변경 로그 훅을 붙인다(로그인 상태에서만) */
  setOutboxRecorder(recorder: OutboxRecorder | null): void {
    this.outbox = recorder
  }

  private load(): Settings {
    let raw: unknown = {}
    try {
      if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (e) {
      console.error('설정 읽기 실패, 기본값 사용', e)
    }
    // 손상·조작된 값은 parseSettings 가 필드별로 기본값으로 되돌린다
    return parseSettings(raw)
  }

  get(): Settings {
    return this.cache
  }

  set(patch: Partial<Settings>): Settings {
    const before = this.cache
    this.cache = parseSettings({ ...this.cache, ...patch })
    // 동기화 대상 키가 실제로 바뀐 것만 변경 로그에 남긴다(기기 전용 값은 목록에 없다)
    for (const key of SYNCED_SETTING_KEYS) {
      if (JSON.stringify(before[key]) === JSON.stringify(this.cache[key])) continue
      this.outbox?.('settings', key, 'upsert')
    }
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.cache, null, 2))
    } catch (e) {
      console.error('설정 저장 실패', e)
    }
    return this.cache
  }
}
