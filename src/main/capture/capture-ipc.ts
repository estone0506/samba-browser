// 사진·영상 캡처 IPC 배선. handlers.ts 가 이 함수 하나만 부르면 되도록 묶어 두었다.
//
// 보안 규칙
// - 파일은 설정의 저장 폴더에만 쓴다(경로는 렌더러가 고르지 못한다 — 폴더 선택은 다이얼로그)
// - 요소 경계(capture:elementRect)는 관리 중인 탭 + 영역 선택 모드일 때만 받고,
//   값은 zod 스키마로 검증한 뒤 쓴다

import {
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type BrowserWindow,
  type NativeImage,
  type WebContents
} from 'electron'
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { IPC } from '../../shared/ipc'
import type { Settings } from '../../shared/settings'
import {
  captureExtension,
  clampRect,
  fullPageHeight,
  fullPageSteps,
  isCaptureMode,
  parseCaptureElementRect,
  type CaptureMode,
  type CaptureRect,
  type CaptureResultDto,
  type CaptureShortcutInput,
  type CaptureStillDto,
  type CaptureVideoSourceDto
} from '../../shared/capture'
import { captureShortcutMode } from '../../shared/capture'
import { resolveCaptureDir, uniqueCaptureFile } from './paths'
import { blitRows, createCanvas, decodePng, encodePng, toDeviceStep } from './stitch'
import type { TabManager } from '../browser/tab-manager'

// 미리보기 토스트에 넣을 썸네일 가로 크기(px). IPC 로 큰 이미지를 보내지 않기 위한 값
const PREVIEW_WIDTH = 280
// 스크롤 뒤 다시 그려질 때까지 기다리는 시간(ms)
const SCROLL_SETTLE_MS = 240

export interface CaptureIpcDeps {
  /** 렌더러 전용 invoke 채널 등록(발신자 검증 포함) */
  handle: <A extends unknown[], T>(channel: string, fn: (...args: A) => T | Promise<T>) => void
  /** main → renderer 통지 */
  send: (channel: string, payload: unknown) => void
  settings: () => Settings
  /** 설정 저장(저장 폴더 선택 결과 반영) */
  setSettings: (patch: Partial<Settings>) => void
  win: BrowserWindow
  tabs: TabManager
  /** 다운로드 폴더 경로 */
  downloadsDir: () => string
}

export interface CaptureIpc {
  /** 창 안 키 입력 처리기. 캡처 단축키를 먹었으면 true */
  handleShortcut: (input: CaptureShortcutInput) => boolean
  dispose: () => void
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function registerCaptureIpc(deps: CaptureIpcDeps): CaptureIpc {
  // 영역 선택 모드를 켠 탭. 여기 없는 발신자의 요소 경계 메시지는 버린다
  const regionTargets = new Set<WebContents>()

  const activeWebContents = (): WebContents => {
    const tab = deps.tabs.active()
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('활성 탭이 없습니다')
    return tab.view.webContents
  }

  /** 렌더러 뷰포트(=창 콘텐츠) 좌표계에서의 웹뷰 영역 */
  const webviewRect = (): CaptureRect => {
    const tab = deps.tabs.active()
    if (!tab) throw new Error('활성 탭이 없습니다')
    const b = tab.view.getBounds()
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  }

  // --- 저장 ---------------------------------------------------------------
  const targetDir = (): string =>
    resolveCaptureDir(
      { configured: deps.settings().captureDir, downloads: deps.downloadsDir() },
      {
        exists: (p) => existsSync(p),
        mkdir: (p) => mkdirSync(p, { recursive: true })
      }
    )

  const encodeImage = (image: NativeImage): Buffer =>
    deps.settings().captureFormat === 'jpg' ? image.toJPEG(92) : image.toPNG()

  const previewOf = (image: NativeImage): string => {
    const size = image.getSize()
    if (size.width <= PREVIEW_WIDTH) return image.toDataURL()
    return image.resize({ width: PREVIEW_WIDTH, quality: 'good' }).toDataURL()
  }

  /** 이미지를 저장하고 완료 이벤트를 쏜다. 설정에 따라 클립보드에도 복사한다 */
  const saveImage = (mode: CaptureMode, image: NativeImage): CaptureResultDto => {
    const size = image.getSize()
    if (size.width <= 0 || size.height <= 0) throw new Error('빈 이미지는 저장하지 않습니다')
    const settings = deps.settings()
    const dir = targetDir()
    const target = uniqueCaptureFile(
      dir,
      new Date(),
      captureExtension(mode, settings.captureFormat),
      (p) => existsSync(p)
    )
    writeFileSync(target.filePath, encodeImage(image))
    if (settings.captureCopyToClipboard) clipboard.writeImage(image)
    const dto: CaptureResultDto = {
      mode,
      filePath: target.filePath,
      fileName: target.fileName,
      previewDataUrl: previewOf(image),
      width: size.width,
      height: size.height
    }
    deps.send(IPC.captureDone, dto)
    return dto
  }

  // --- 이미지 캡처 방식별 구현 --------------------------------------------
  /** 영역 선택: 페이지에 요소 하이라이트 모드를 켠다(클릭하면 경계가 돌아온다) */
  const startRegionMode = (): void => {
    const wc = activeWebContents()
    regionTargets.add(wc)
    wc.send(IPC.captureRegionMode, { active: true })
    wc.once('destroyed', () => regionTargets.delete(wc))
  }

  const stopRegionMode = (wc: WebContents): void => {
    regionTargets.delete(wc)
    if (!wc.isDestroyed()) wc.send(IPC.captureRegionMode, { active: false })
  }

  /** 전체 페이지: 스크롤하며 찍은 장들을 이어붙인다 */
  const captureFullPage = async (): Promise<CaptureResultDto> => {
    const wc = activeWebContents()
    const metrics = (await wc.executeJavaScript(FULL_PAGE_METRICS_JS, true)) as {
      totalHeight: number
      viewportHeight: number
      headerHeight: number
      scrollY: number
    }
    const steps = fullPageSteps(metrics)
    if (steps.length === 0) throw new Error('페이지 크기를 읽지 못했습니다')

    // 첫 장으로 배율을 잰다(고해상도 화면에서 이미지 픽셀 ≠ CSS 픽셀)
    let canvas: ReturnType<typeof createCanvas> | null = null
    let scale = 1
    for (const step of steps) {
      await wc.executeJavaScript(`window.scrollTo(0, ${step.scrollY})`, true)
      await delay(SCROLL_SETTLE_MS)
      const shot = await wc.capturePage()
      const png = decodePng(shot.toPNG())
      if (!canvas) {
        scale = png.width / Math.max(1, shot.getSize().width)
        canvas = createCanvas(png.width, Math.round(fullPageHeight(steps) * scale))
      }
      blitRows(canvas, png, toDeviceStep(step, scale))
    }
    // 원래 스크롤 위치로 돌려 놓는다
    await wc.executeJavaScript(`window.scrollTo(0, ${metrics.scrollY})`, true)
    if (!canvas) throw new Error('전체 페이지 캡처에 실패했습니다')
    return saveImage('fullPage', nativeImage.createFromBuffer(encodePng(canvas)))
  }

  /** 주 모니터 화면 소스. 비디오·전체 화면 캡처가 함께 쓴다 */
  const primaryScreenSource = async (): Promise<{
    id: string
    image: NativeImage
    bounds: Electron.Rectangle
    scaleFactor: number
  }> => {
    const display = screen.getPrimaryDisplay()
    const scaleFactor = display.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scaleFactor),
        height: Math.round(display.size.height * scaleFactor)
      }
    })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source) throw new Error('화면 소스를 찾지 못했습니다')
    return { id: source.id, image: source.thumbnail, bounds: display.bounds, scaleFactor }
  }

  const captureFullScreen = async (): Promise<CaptureResultDto> => {
    const source = await primaryScreenSource()
    return saveImage('fullScreen', source.image)
  }

  // --- 렌더러 채널 --------------------------------------------------------
  // 직접 지정: 웹뷰를 먼저 한 장 찍어 렌더러 오버레이에 띄운다(웹뷰는 렌더러가 접는다)
  deps.handle(IPC.captureStill, async (): Promise<CaptureStillDto> => {
    const wc = activeWebContents()
    const image = await wc.capturePage()
    const size = image.getSize()
    const rect = webviewRect()
    return {
      dataUrl: image.toDataURL(),
      rect,
      scale: rect.width > 0 ? size.width / rect.width : 1
    }
  })

  deps.handle(IPC.captureRun, async (rawMode: unknown): Promise<boolean> => {
    if (!isCaptureMode(rawMode)) throw new Error('알 수 없는 캡처 방식')
    if (rawMode === 'region') {
      startRegionMode()
      return true
    }
    if (rawMode === 'fullPage') {
      await captureFullPage()
      return true
    }
    if (rawMode === 'fullScreen') {
      await captureFullScreen()
      return true
    }
    // direct·비디오는 렌더러가 주도한다(오버레이·MediaRecorder)
    return false
  })

  // 렌더러가 잘라낸 이미지(직접 지정). data URL 외의 값은 받지 않는다
  deps.handle(IPC.captureSaveImage, (rawDataUrl: unknown): void => {
    if (typeof rawDataUrl !== 'string' || !rawDataUrl.startsWith('data:image/')) {
      throw new Error('이미지 데이터가 올바르지 않습니다')
    }
    const image = nativeImage.createFromDataURL(rawDataUrl)
    if (image.isEmpty()) throw new Error('이미지를 읽지 못했습니다')
    saveImage('direct', image)
  })

  // 녹화용 화면 소스. videoDirect 면 웹뷰 영역을 화면 좌표로 환산해 크롭 정보를 함께 준다
  deps.handle(IPC.captureVideoSource, async (rawMode: unknown): Promise<CaptureVideoSourceDto> => {
    if (!isCaptureMode(rawMode)) throw new Error('알 수 없는 캡처 방식')
    const source = await primaryScreenSource()
    const size = source.image.getSize()
    if (rawMode !== 'videoDirect') {
      return {
        sourceId: source.id,
        width: size.width,
        height: size.height,
        crop: null,
        viewport: null,
        scaleFactor: source.scaleFactor
      }
    }
    const content = deps.win.getContentBounds()
    const view = webviewRect()
    const wanted: CaptureRect = {
      x: content.x + view.x - source.bounds.x,
      y: content.y + view.y - source.bounds.y,
      width: view.width,
      height: view.height
    }
    const clamped = clampRect(wanted, {
      x: 0,
      y: 0,
      width: source.bounds.width,
      height: source.bounds.height
    })
    // 화면 픽셀(= width/height 와 같은 좌표계)로 돌려준다
    const toDevice = (r: CaptureRect): CaptureRect => ({
      x: Math.round(r.x * source.scaleFactor),
      y: Math.round(r.y * source.scaleFactor),
      width: Math.round(r.width * source.scaleFactor),
      height: Math.round(r.height * source.scaleFactor)
    })
    return {
      sourceId: source.id,
      width: size.width,
      height: size.height,
      crop: clamped ? toDevice(clamped) : null,
      // 선택 영역은 잘리기 전 웹뷰 왼쪽 위를 원점으로 재므로 자르지 않은 값도 함께 준다
      viewport: toDevice(wanted),
      scaleFactor: source.scaleFactor
    }
  })

  deps.handle(IPC.captureSaveVideo, (rawBytes: unknown, rawMode: unknown): void => {
    const mode: CaptureMode = isCaptureMode(rawMode) ? rawMode : 'videoScreen'
    const bytes =
      rawBytes instanceof Uint8Array
        ? rawBytes
        : rawBytes instanceof ArrayBuffer
          ? new Uint8Array(rawBytes)
          : null
    if (!bytes || bytes.byteLength === 0) throw new Error('녹화 데이터가 비어 있습니다')
    const dir = targetDir()
    const target = uniqueCaptureFile(dir, new Date(), 'webm', (p) => existsSync(p))
    writeFileSync(target.filePath, bytes)
    deps.send(IPC.captureDone, {
      mode,
      filePath: target.filePath,
      fileName: target.fileName,
      previewDataUrl: '',
      width: 0,
      height: 0
    } satisfies CaptureResultDto)
  })

  // --- 녹화 스트리밍 저장: 시작 때 파일을 열고 청크를 바로 이어 쓴다 ----------
  // MediaRecorder(webm) 청크는 순서대로 이어 붙이면 그대로 재생 가능한 파일이 된다.
  // 렌더러가 죽거나 앱이 크래시해도 마지막 청크까지는 디스크에 남는다
  let streaming: { fd: number; filePath: string; fileName: string } | null = null
  // 렌더러는 웹뷰에 가려 '보이지 않는 창' 으로 취급되어 타이머·rAF 가 초당 한두 번으로
  // 묶인다. 녹화 중에는 크롭 캔버스를 그 속도로 그리면 영상이 뚝뚝 끊기므로 잠시 풀어 준다
  const setThrottling = (allowed: boolean): void => {
    if (!deps.win.isDestroyed()) deps.win.webContents.setBackgroundThrottling(allowed)
  }
  deps.handle(IPC.captureBeginVideo, (): string => {
    if (streaming) {
      closeSync(streaming.fd)
      streaming = null
    }
    const dir = targetDir()
    const target = uniqueCaptureFile(dir, new Date(), 'webm', (p) => existsSync(p))
    const fd = openSync(target.filePath, 'w')
    streaming = { fd, filePath: target.filePath, fileName: target.fileName }
    setThrottling(false)
    return target.fileName
  })
  deps.handle(IPC.captureAppendVideo, (rawBytes: unknown): void => {
    if (!streaming) return
    const bytes =
      rawBytes instanceof Uint8Array
        ? rawBytes
        : rawBytes instanceof ArrayBuffer
          ? new Uint8Array(rawBytes)
          : null
    if (!bytes || bytes.byteLength === 0) return
    writeSync(streaming.fd, bytes)
  })
  deps.handle(IPC.captureEndVideo, (rawMode: unknown): void => {
    const mode: CaptureMode = isCaptureMode(rawMode) ? rawMode : 'videoScreen'
    setThrottling(true)
    if (!streaming) return
    const { fd, filePath, fileName } = streaming
    streaming = null
    closeSync(fd)
    deps.send(IPC.captureDone, {
      mode,
      filePath,
      fileName,
      previewDataUrl: '',
      width: 0,
      height: 0
    } satisfies CaptureResultDto)
  })

  // 저장이 끝난 파일만 다룬다 — 임의 경로 열기를 막기 위해 저장 폴더 밖이면 거절한다
  const assertInCaptureDir = (rawPath: unknown): string => {
    if (typeof rawPath !== 'string' || !rawPath) throw new Error('경로가 비어 있습니다')
    if (dirname(rawPath) !== targetDir()) throw new Error('캡처 폴더 밖의 파일입니다')
    if (!existsSync(rawPath)) throw new Error('파일을 찾을 수 없습니다')
    return rawPath
  }

  deps.handle(IPC.captureOpenFile, async (rawPath: unknown) => {
    const message = await shell.openPath(assertInCaptureDir(rawPath))
    if (message) throw new Error(message)
  })
  deps.handle(IPC.captureOpenFolder, async (rawPath: unknown) => {
    // 파일을 주지 않으면(메뉴의 '열기') 저장 폴더 자체를 연다
    if (rawPath === undefined || rawPath === null || rawPath === '') {
      const message = await shell.openPath(targetDir())
      if (message) throw new Error(message)
      return
    }
    shell.showItemInFolder(assertInCaptureDir(rawPath))
  })
  deps.handle(IPC.captureDir, (): string => targetDir())
  deps.handle(IPC.captureCopyImage, (rawPath: unknown) => {
    const image = nativeImage.createFromPath(assertInCaptureDir(rawPath))
    if (image.isEmpty()) throw new Error('이미지를 읽지 못했습니다')
    clipboard.writeImage(image)
  })

  deps.handle(IPC.capturePickDir, async (): Promise<string | null> => {
    const picked = await dialog.showOpenDialog(deps.win, { properties: ['openDirectory'] })
    if (picked.canceled || picked.filePaths.length === 0) return null
    deps.setSettings({ captureDir: picked.filePaths[0] })
    return picked.filePaths[0]
  })

  // --- 페이지(격리 월드) → 메인: 요소 경계 ---------------------------------
  const onElementRect = (e: Electron.IpcMainEvent, raw: unknown): void => {
    const wc = e.sender
    // 관리 중인 탭 + 영역 선택 모드를 켠 탭에서 온 것만 받는다
    if (!deps.tabs.hasWebContents(wc) || !regionTargets.has(wc)) return
    stopRegionMode(wc)
    const rect = parseCaptureElementRect(raw)
    if (!rect) return
    void (async () => {
      try {
        const image = await wc.capturePage(rect)
        saveImage('region', image)
      } catch (err: unknown) {
        console.error('영역 캡처 실패', err instanceof Error ? err.message : String(err))
      }
    })()
  }
  ipcMain.on(IPC.captureElementRect, onElementRect)

  // --- 단축키 -------------------------------------------------------------
  const handleShortcut = (input: CaptureShortcutInput): boolean => {
    const mode = captureShortcutMode(input, deps.settings().captureShortcuts)
    if (mode === null) return false
    // 실행은 렌더러가 메뉴를 눌렀을 때와 똑같은 경로를 타게 한다
    deps.send(IPC.captureShortcut, { mode })
    return true
  }

  return {
    handleShortcut,
    dispose: () => {
      setThrottling(true)
      ipcMain.removeListener(IPC.captureElementRect, onElementRect)
      for (const wc of regionTargets) {
        if (!wc.isDestroyed()) wc.send(IPC.captureRegionMode, { active: false })
      }
      regionTargets.clear()
    }
  }
}

// 페이지에서 잴 값들. 고정(fixed/sticky) 헤더는 화면 맨 위 요소들 중에서 찾는다
const FULL_PAGE_METRICS_JS = `(() => {
  const doc = document.documentElement
  const body = document.body
  const totalHeight = Math.max(
    doc ? doc.scrollHeight : 0,
    body ? body.scrollHeight : 0,
    window.innerHeight
  )
  let headerHeight = 0
  try {
    const found = document.elementsFromPoint(Math.floor(window.innerWidth / 2), 2) || []
    for (const el of found) {
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
      const r = el.getBoundingClientRect()
      if (r.top <= 2 && r.bottom > headerHeight && r.bottom < window.innerHeight / 2) {
        headerHeight = r.bottom
      }
    }
  } catch (e) {
    headerHeight = 0
  }
  return {
    totalHeight: Math.round(totalHeight),
    viewportHeight: Math.round(window.innerHeight),
    headerHeight: Math.round(headerHeight),
    scrollY: Math.round(window.scrollY)
  }
})()`
