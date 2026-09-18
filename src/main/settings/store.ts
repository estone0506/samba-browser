import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { parseSettings, type Settings } from '../../shared/settings'

// %APPDATA%/samba-browser/config.json
export class SettingsStore {
  private file = join(app.getPath('userData'), 'config.json')
  private cache: Settings

  constructor() {
    this.cache = this.load()
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
    this.cache = parseSettings({ ...this.cache, ...patch })
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.cache, null, 2))
    } catch (e) {
      console.error('설정 저장 실패', e)
    }
    return this.cache
  }
}
