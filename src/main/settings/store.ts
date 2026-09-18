import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { Settings } from '../../shared/ipc'
import { DEFAULT_DANGER_WORDS } from '../../shared/danger'

const DEFAULTS: Settings = {
  model: 'sonnet',
  language: 'ko',
  panelWidth: 380,
  lastUrl: 'https://www.google.com',
  dangerWords: DEFAULT_DANGER_WORDS,
  maxToolCalls: 40
}

// %APPDATA%/samba-browser/config.json
export class SettingsStore {
  private file = join(app.getPath('userData'), 'config.json')
  private cache: Settings

  constructor() {
    this.cache = this.load()
  }

  private load(): Settings {
    try {
      if (existsSync(this.file))
        return { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, 'utf8')) }
    } catch (e) {
      console.error('설정 읽기 실패, 기본값 사용', e)
    }
    return { ...DEFAULTS }
  }

  get(): Settings {
    return this.cache
  }

  set(patch: Partial<Settings>): Settings {
    this.cache = { ...this.cache, ...patch }
    mkdirSync(join(this.file, '..'), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2))
    return this.cache
  }
}
