// vitest 용 electron 모듈 스텁. tab-manager.ts 가 import 하는 이름만 빈 값으로 내보냄
export const session = {}
export class WebContentsView {}
export class BrowserWindow {}
export const shell = {}
// ocr/engine.ts 가 모델 보관 위치를 계산할 때 쓴다(테스트는 경로를 직접 주입한다)
export const app = { getPath: (_name: string): string => '' }
