// 번역 배선 — IPC 채널 · 탭 우클릭 메뉴 · 자동 번역 도메인을 한 곳에 모은다.
// handlers.ts 는 이 함수를 한 번 부르기만 한다(추가 코드 최소화).

import { ipcMain, nativeImage, type WebContents } from 'electron'
import { join } from 'node:path'
import { IPC, type IpcResult, type Settings } from '../../shared/ipc'
import {
  isTranslateLang,
  shouldAutoTranslate,
  TRANSLATE_MAX_NODES,
  type ImageTranslateDto,
  type TranslateLang
} from '../../shared/translate'
import { resolveModel } from '../ai/models'
import type { ApiKeyStore } from '../ai/keys'
import { OcrEngine } from '../ocr/engine'
import type { OcrLine } from '../ocr/postprocess'
import { installContextMenu } from '../browser/context-menu'
import { ISOLATED_WORLD_ID } from '../browser/page-bridge'
import type { TabManager } from '../browser/tab-manager'
import { TranslateCache } from './cache'
import { createSdkAsk } from './ask'
import { AiTranslator, TranslateService, type Translator } from './service'
import { readImageTextBoxes, translateImage } from './image'

/** 격리 월드의 __sambaTranslate 를 호출한다. 결과 문자열은 진단용이다 */
async function callPage(wc: WebContents, code: string): Promise<string> {
  if (wc.isDestroyed()) return 'page is gone'
  try {
    const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }])
    return typeof raw === 'string' ? raw : ''
  } catch {
    // 오류 객체에 페이지 내용이 실릴 수 있어 사유는 남기지 않는다
    return 'page call failed'
  }
}

export interface RegisterTranslateDeps {
  /** handlers.ts 의 handleFromRenderer(발신자 검증 + {ok,data} 포장) */
  handle: <A extends unknown[], T>(channel: string, fn: (...args: A) => T | Promise<T>) => void
  tabs: TabManager
  settings: () => Settings
  apiKeys: ApiKeyStore
  userDataDir: string
}

export interface TranslateHandle {
  dispose: () => void
}

export function registerTranslate(deps: RegisterTranslateDeps): TranslateHandle {
  const cache = new TranslateCache(join(deps.userDataDir, 'translate-cache.json'))
  const ask = createSdkAsk()
  let ocrEngine: OcrEngine | null = null

  // AI 연결이 없으면(내 API 키 경로인데 키가 없음) 호출하지 않고 안내로 떨어뜨린다
  const translator = (): Translator | null => {
    const s = deps.settings()
    if (s.aiProvider === 'api_key' && !deps.apiKeys.hasAny()) return null
    return new AiTranslator({
      ask,
      model: () => resolveModel(s.taskModels, 'fast', s.aiProvider)
    })
  }
  const service = new TranslateService({ translator, cache })

  const targetLang = (): TranslateLang => deps.settings().translateTargetLang

  // --- 격리 월드(탭 preload) 전용 게이트 ------------------------------------
  // 렌더러 창이나 다른 발신자의 요청은 받지 않는다. 탭 webContents 인 것만 통과시킨다
  const isTabSender = (sender: WebContents): boolean =>
    deps.tabs.list().some((t) => {
      const tab = deps.tabs.get(t.id)
      return !!tab && !tab.view.webContents.isDestroyed() && tab.view.webContents === sender
    })

  ipcMain.handle(IPC.pageTranslate, async (e, raw: unknown): Promise<IpcResult<string[]>> => {
    if (!isTabSender(e.sender)) return { ok: false, error: 'translate:forbidden' }
    const input = raw as { lang?: unknown; texts?: unknown } | null
    const lang = isTranslateLang(input?.lang) ? input.lang : targetLang()
    const texts = Array.isArray(input?.texts) ? input.texts : []
    if (texts.length > TRANSLATE_MAX_NODES || texts.some((t) => typeof t !== 'string')) {
      return { ok: false, error: 'translate:too-large' }
    }
    try {
      return { ok: true, data: await service.translate(texts as string[], lang) }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'translate:failed' }
    }
  })

  // --- 페이지 번역 / 원문 보기 ----------------------------------------------
  const runPage = (wc: WebContents, lang: TranslateLang): Promise<string> =>
    callPage(wc, `__sambaTranslate.run(${JSON.stringify(lang)})`)
  const restorePage = (wc: WebContents): Promise<string> =>
    callPage(wc, '__sambaTranslate.restore()')

  const activeContents = (): WebContents | null => {
    const tab = deps.tabs.active()
    return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null
  }

  deps.handle(IPC.translateRun, async (lang?: TranslateLang) => {
    const wc = activeContents()
    if (!wc) throw new Error('translate:no-tab')
    return runPage(wc, isTranslateLang(lang) ? lang : targetLang())
  })
  deps.handle(IPC.translateRestore, async () => {
    const wc = activeContents()
    if (!wc) throw new Error('translate:no-tab')
    return restorePage(wc)
  })
  deps.handle(IPC.translateCacheClear, () => {
    cache.clear()
    return true
  })

  // --- 이미지 번역 ----------------------------------------------------------
  const localOcr = async (png: Buffer): Promise<OcrLine[] | null> => {
    if (!deps.settings().ocrEnabled) return null
    if (!ocrEngine) ocrEngine = new OcrEngine()
    if (!ocrEngine.hasModels()) {
      // 첫 사용은 Visual 폴백으로 넘기고, 모델은 뒤에서 내려받는다(합계 약 18MB)
      if (!ocrEngine.isDownloading()) void ocrEngine.ensureModels().catch(() => undefined)
      return null
    }
    return (await ocrEngine.recognize(png)).lines
  }

  const imageTranslate = async (wc: WebContents, srcUrl: string): Promise<void> => {
    try {
      const response = await wc.session.fetch(srcUrl)
      if (!response.ok) return
      const bytes = Buffer.from(await response.arrayBuffer())
      // OCR·Visual 모두 PNG 만 다루므로 여기서 한 번 변환한다
      const image = nativeImage.createFromBuffer(bytes)
      const size = image.getSize()
      if (size.width === 0 || size.height === 0) return
      const png = image.toPNG()
      const lang = targetLang()
      const boxes = await translateImage(
        {
          ocr: localOcr,
          visual: (buf, s) =>
            readImageTextBoxes(
              {
                apiKey: () => deps.apiKeys.get('anthropic'),
                model: () => {
                  const st = deps.settings()
                  return resolveModel(st.taskModels, 'visual', st.aiProvider)
                }
              },
              buf,
              s
            ),
          translate: (texts, l) => service.translate(texts, l)
        },
        png,
        size,
        lang
      )
      if (boxes.length === 0) return
      const dto: ImageTranslateDto = {
        src: srcUrl,
        naturalWidth: size.width,
        naturalHeight: size.height,
        boxes
      }
      await callPage(wc, `__sambaTranslate.showImageOverlay(${JSON.stringify(dto)})`)
    } catch (err: unknown) {
      // 이미지 바이트·응답 본문이 실리지 않도록 메시지만 짧게 남긴다
      console.warn('이미지 번역 실패', err instanceof Error ? err.message : '')
    }
  }

  // --- 우클릭 메뉴 + 자동 번역 도메인 ---------------------------------------
  deps.tabs.setContextMenuHook((wc) => {
    installContextMenu(wc, {
      language: () => deps.settings().language,
      translateImage: (target, srcUrl) => void imageTranslate(target, srcUrl),
      translatePage: (target) => void runPage(target, targetLang()),
      restorePage: (target) => void restorePage(target)
    })
    // 자동 번역 목록에 있는 도메인은 로드가 끝나면 스스로 번역한다
    wc.on('did-finish-load', () => {
      const s = deps.settings()
      if (s.translateAutoDomains.length === 0) return
      let host = ''
      try {
        host = new URL(wc.getURL()).hostname
      } catch {
        return
      }
      if (!shouldAutoTranslate(host, s.translateAutoDomains)) return
      void runPage(wc, s.translateTargetLang)
    })
  })

  return {
    dispose: () => {
      cache.flush()
      ipcMain.removeHandler(IPC.pageTranslate)
    }
  }
}
