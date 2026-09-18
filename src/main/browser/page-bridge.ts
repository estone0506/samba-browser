import type { WebContents } from 'electron'
import { z } from 'zod'
import type { PageSnapshot } from '../../shared/snapshot'
import type { Tab } from './tab-manager'

// preload 가 실행되는 격리 월드 id. Electron 의 WorldId.ISOLATED_WORLD = 999
export const ISOLATED_WORLD_ID = 999

// 페이지에서 돌아온 값은 전부 신뢰하지 않는다. AI 에 넘기기 전에 스키마로 검증한다
const elementSchema = z.object({
  id: z.number().int(),
  tag: z.string(),
  role: z.string(),
  text: z.string(),
  name: z.string().optional(),
  href: z.string().optional(),
  inputType: z.string().optional(),
  isSecret: z.boolean()
})

const snapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  elements: z.array(elementSchema)
})

// 행동 도구(click/type/select/scroll/textOf)는 결과가 항상 문자열이어야 한다
const resultSchema = z.string()

// 탭 안 preload(격리 월드의 __samba)를 호출하고 결과를 스키마로 검증한다
async function call<T>(wc: WebContents, expr: string, schema: z.ZodType<T>): Promise<T> {
  if (wc.isDestroyed()) throw new Error('page is gone')
  // webContents.executeJavaScriptInIsolatedWorld 는 메인 프레임의 지정 월드에서 실행한다
  const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
    { code: expr }
  ])
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`unexpected page result for ${expr}`)
  return parsed.data
}

export const pageBridge = {
  snapshot: (tab: Tab): Promise<PageSnapshot> =>
    call(tab.view.webContents, '__samba.snapshot()', snapshotSchema),
  // 요소 [id] 의 실제 페이지 텍스트. 없으면 빈 문자열
  textOf: (tab: Tab, id: number): Promise<string> =>
    call(tab.view.webContents, `__samba.textOf(${id})`, resultSchema),
  click: (tab: Tab, id: number): Promise<string> =>
    call(tab.view.webContents, `__samba.click(${id})`, resultSchema),
  type: (tab: Tab, id: number, text: string, submit: boolean): Promise<string> =>
    call(
      tab.view.webContents,
      `__samba.type(${id}, ${JSON.stringify(text)}, ${submit})`,
      resultSchema
    ),
  select: (tab: Tab, id: number, value: string): Promise<string> =>
    call(tab.view.webContents, `__samba.select(${id}, ${JSON.stringify(value)})`, resultSchema),
  scroll: (tab: Tab, dir: 'up' | 'down'): Promise<string> =>
    call(tab.view.webContents, `__samba.scroll(${JSON.stringify(dir)})`, resultSchema),
  waitForLoad: (tab: Tab, timeoutMs = 10000): Promise<void> =>
    new Promise<void>((resolve) => {
      const wc = tab.view.webContents
      if (!wc.isLoading()) {
        resolve()
        return
      }
      const t = setTimeout(done, timeoutMs)
      function done(): void {
        clearTimeout(t)
        wc.off('did-stop-loading', done)
        resolve()
      }
      wc.on('did-stop-loading', done)
    })
}
