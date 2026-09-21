import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { parseSettings, type Settings } from '../../shared/settings'
import { SYNCED_SETTING_KEYS, type OutboxRecorder } from '../../shared/sync'
import { setMainLanguage } from '../i18n'

// %APPDATA%/samba-browser/config.json
export class SettingsStore {
  private file = join(app.getPath('userData'), 'config.json')
  private cache: Settings
  // 동기화 변경 로그 훅. 주입하지 않으면 아무 일도 하지 않는다(동기화를 끈 상태)
  private outbox: OutboxRecorder | null = null

  constructor() {
    this.cache = this.load()
    // 메인이 만드는 문구(오류·알림)도 앱 언어를 따른다
    setMainLanguage(this.cache.language)
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
    return this.apply(patch, true)
  }

  /**
   * 동기화로 내려받은 값을 적용한다. 변경 로그를 남기지 않으므로
   * 받은 값을 곧바로 되돌려 보내는 왕복(에코)이 생기지 않는다
   */
  setFromSync(patch: Partial<Settings>): Settings {
    return this.apply(patch, false)
  }

  private apply(patch: Partial<Settings>, record: boolean): Settings {
    const before = this.cache
    this.cache = parseSettings({ ...this.cache, ...patch })
    setMainLanguage(this.cache.language)
    // 동기화 대상 키가 실제로 바뀐 것만 변경 로그에 남긴다(기기 전용 값은 목록에 없다)
    if (record) {
      for (const key of SYNCED_SETTING_KEYS) {
        if (JSON.stringify(before[key]) === JSON.stringify(this.cache[key])) continue
        this.outbox?.('settings', key, 'upsert')
      }
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
