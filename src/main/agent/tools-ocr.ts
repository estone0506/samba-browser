import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { OcrEngine } from '../ocr/engine'
import { clipText } from '../ocr/postprocess'
// 순환 import 를 피하려고 타입만 가져온다(런타임 코드는 남지 않는다)
import type { ToolContext } from './tools'
import { agentTargetOf } from './target'

// 응답 길이 상한 — 캡처 전체가 글자일 때 컨텍스트를 잡아먹지 않게 한다
const MAX_RESULT_CHARS = 4000
// 모델이 아직 없을 때 돌려줄 안내. 모델은 백그라운드로 내려받는다(최초 1회, 합계 약 18MB)
const DOWNLOADING = 'downloading ~18MB model once… call again in 30s'
// 설정에서 OCR 을 끈 경우
const OCR_DISABLED = 'refused: OCR is disabled in settings'
// UI 스텝 라벨
const STEP_LABEL = 'OCR'

// 모델·세션을 실행마다 다시 적재하지 않도록 프로세스 단위로 하나만 둔다
let engine: OcrEngine | null = null
// 설정(ocrEnabled) 반영값. 기본은 켬이고 IPC 핸들러가 설정 변경 때 갱신한다
let enabled = true
// 다운로드 실패 사유. 다음 호출에서 모델이 왜 없는지 알려 주기 위해 남긴다
let lastDownloadError = ''

/** 설정의 ocrEnabled 를 도구에 반영한다(앱 시작·설정 저장 시 호출) */
export function setOcrEnabled(value: boolean): void {
  enabled = value
}

function getEngine(): OcrEngine {
  if (!engine) engine = new OcrEngine()
  return engine
}

const regionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

// 도구 입력 스키마. 반환 타입을 명시하려고 별도 상수로 뺀다
const ocrInputSchema = { region: regionSchema.optional() }

/**
 * ocr 도구 — 활성 탭을 PNG 로 캡처해 로컬 PP-OCRv5 모델로 글자를 읽는다.
 *
 * 조회 전용이라 권한 모드(read_only 포함)와 무관하게 허용한다. 화면을 읽을 뿐
 * 페이지를 조작하지 않으며, 인식 결과는 screenshot 과 마찬가지로 "데이터"다.
 */
export function createOcrTool(ctx: ToolContext): SdkMcpToolDefinition<typeof ocrInputSchema> {
  return tool(
    'ocr',
    'Read text from the active tab locally (PP-OCRv5). Returns text lines with view-coordinate boxes. Use for captcha text, receipts, SMS codes, keypad digits - anything rendered as an image. Faster and cheaper than screenshot; use screenshot when you need to understand a picture rather than read it.',
    ocrInputSchema,
    async ({ region }) => {
      const over = ctx.tick()
      if (over) return textResult(over)
      if (!enabled) {
        ctx.onStep(STEP_LABEL, false)
        return textResult(OCR_DISABLED)
      }
      try {
        // 팝업(결제창·주소 검색창) 안의 캡차·키패드도 읽어야 하므로 활성 탭이 아니라 작업 대상을 본다
        const tab = agentTargetOf(ctx.tabs)
        const bounds = tab?.view.getBounds()
        // 웹뷰가 접힌 화면(설정·키마스터)에서는 bounds 가 0 이라 캡처 대상이 없다
        if (!tab || !bounds || bounds.width === 0 || bounds.height === 0) {
          ctx.onStep(STEP_LABEL, false)
          return textResult('no visible page')
        }

        const ocr = getEngine()
        if (!ocr.hasModels()) {
          // 첫 호출은 즉시 돌려주고 다운로드는 뒤에서 돈다(모델 합계 약 18MB)
          if (!ocr.isDownloading()) {
            lastDownloadError = ''
            void ocr.ensureModels().catch((e: unknown) => {
              lastDownloadError = e instanceof Error ? e.message : String(e)
            })
          }
          ctx.onStep(STEP_LABEL, false)
          return textResult(lastDownloadError ? `error: ${lastDownloadError}` : DOWNLOADING)
        }

        // region 은 뷰 기준 좌표. 화면 밖으로 나가지 않게 잘라 낸다
        const rect = region ? clampRect(region, bounds.width, bounds.height) : undefined
        if (rect && (rect.width < 1 || rect.height < 1)) {
          ctx.onStep(STEP_LABEL, false)
          return textResult('refused: region is outside the page')
        }
        const image = rect
          ? await tab.view.webContents.capturePage(rect)
          : await tab.view.webContents.capturePage()
        const { width, height } = image.getSize()
        if (width === 0 || height === 0) {
          ctx.onStep(STEP_LABEL, false)
          return textResult('no visible page')
        }

        const result = await ocr.recognize(image.toPNG())
        // 박스는 캡처 이미지 좌표라, region 캡처면 뷰 좌표로 되돌린다.
        // 캡처 이미지는 DPI 배율이 걸려 있을 수 있어 실제 폭/높이 비율로 환산한다
        const srcWidth = rect ? rect.width : bounds.width
        const srcHeight = rect ? rect.height : bounds.height
        const kx = srcWidth / width
        const ky = srcHeight / height
        const originX = rect ? rect.x : 0
        const originY = rect ? rect.y : 0
        const lines = result.lines.map((l) => ({
          text: l.text,
          box: [
            Math.round(originX + l.box[0] * kx),
            Math.round(originY + l.box[1] * ky),
            Math.round(l.box[2] * kx),
            Math.round(l.box[3] * ky)
          ] as [number, number, number, number],
          score: l.score
        }))

        ctx.onStep(STEP_LABEL, lines.length > 0)
        if (lines.length === 0) return textResult('no text found')
        return textResult(clipText(JSON.stringify({ lines }), MAX_RESULT_CHARS))
      } catch (e) {
        ctx.onStep(STEP_LABEL, false)
        return textResult(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )
}

/** region 을 뷰 크기 안으로 자른다 */
export function clampRect(
  region: { x: number; y: number; width: number; height: number },
  viewWidth: number,
  viewHeight: number
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(Math.round(region.x), viewWidth))
  const y = Math.max(0, Math.min(Math.round(region.y), viewHeight))
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(region.width), viewWidth - x)),
    height: Math.max(0, Math.min(Math.round(region.height), viewHeight - y))
  }
}

function textResult(t: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: t }] }
}
