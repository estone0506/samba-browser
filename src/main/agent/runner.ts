import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent } from '../../shared/ipc'

// 에이전트 실행기 스텁. Task 8 에서 실제 구현으로 교체
/* eslint-disable @typescript-eslint/no-empty-function */
export class AgentRunner {
  constructor(_tabs: TabManager, _settings: SettingsStore, _emit: (e: AgentEvent) => void) {}
  async run(_prompt: string): Promise<void> {}
  stop(): void {}
  resolveConfirm(_id: string, _approved: boolean): void {}
}
/* eslint-enable @typescript-eslint/no-empty-function */
