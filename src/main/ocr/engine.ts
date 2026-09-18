import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { PNG } from 'pngjs'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import {
  clipText,
  decodeCtc,
  findRegions,
  mergeLineText,
  sortLines,
  toImageBoxes,
  type BoxTuple,
  type OcrLine
} from './postprocess'

/**
 * 로컬 OCR 엔진 — PP-OCRv5 (검출 mobile det + 한국어 mobile rec) ONNX 모델을
 * onnxruntime-node 로 돌린다. 네트워크는 최초 1회 모델 내려받을 때만 쓴다.
 *
 * 모델 출처: https://huggingface.co/xberg-io/paddleocr-onnx-models (Apache-2.0)
 */

// 허깅페이스 저장소의 resolve/main 기준 경로
const HF_BASE = 'https://huggingface.co/xberg-io/paddleocr-onnx-models/resolve/main'

interface ModelFile {
  /** 로컬 파일명 */
  name: string
  /** HF 저장소 내부 경로 */
  remote: string
  /** 저장소 manifest.json 이 알려 주는 무결성 해시 */
  sha256: string
  /** 기대 바이트 수(존재 여부 빠른 확인용) */
  bytes: number
}

// 파일 목록은 저장소 manifest.json 의 sha256/size 를 그대로 옮긴 것이다
export const OCR_MODEL_FILES: readonly ModelFile[] = [
  {
    name: 'det.onnx',
    remote: 'v2/det/mobile.onnx',
    sha256: 'c8d9b07063420ce5365c74e42532de48238feeeedcdb7a330b195708bc38a93f',
    bytes: 4766440
  },
  {
    name: 'rec.onnx',
    remote: 'rec/korean/model.onnx',
    sha256: '322f140154c820fcb83c3d24cfe42c9ec70dd1a1834163306a7338136e4f1eaa',
    bytes: 13401252
  },
  {
    name: 'dict.txt',
    remote: 'rec/korean/dict.txt',
    sha256: '086835d8f64802da9214d24e7aea3fda477a72d2df4716e9769117ca081059bb',
    bytes: 47455
  }
]

// 검출 입력 긴 변 상한. 값이 클수록 작은 글자에 강하지만 느려진다
const DET_MAX_SIDE = 960
// 검출 모델은 입력 크기가 32의 배수여야 한다
const DET_STRIDE = 32
// 인식 모델 입력 높이(고정)
const REC_HEIGHT = 48
// 인식 입력 가로 길이 허용 범위
const REC_MIN_WIDTH = 16
const REC_MAX_WIDTH = 1600
// 이 확신도보다 낮은 줄은 잡음으로 보고 버린다
const REC_MIN_SCORE = 0.3
// 한 번에 처리할 검출 영역 수 상한(캡처 전체가 글자 덩어리일 때 폭주 방지)
const MAX_REGIONS = 64

// ImageNet 정규화(검출 모델)
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

export interface OcrProgress {
  /** 내려받는 중인 파일명 */
  file: string
  /** 전체 파일 중 몇 번째인지(1-base) */
  index: number
  count: number
  receivedBytes: number
  totalBytes: number
}

export interface OcrResult {
  lines: OcrLine[]
  /** 줄을 위→아래, 왼→오른쪽으로 합친 전체 텍스트 */
  text: string
}

interface DecodedImage {
  width: number
  height: number
  /** RGBA 8bit */
  data: Uint8Array
}

/** PNG 버퍼를 RGBA 픽셀로 푼다 */
function decodePng(buffer: Buffer): DecodedImage {
  const png = PNG.sync.read(buffer)
  return { width: png.width, height: png.height, data: png.data }
}

/** 최근접 이웃 샘플링 — 별도 네이티브 이미지 라이브러리 없이 축소/확대한다 */
function samplePixel(img: DecodedImage, x: number, y: number): { r: number; g: number; b: number } {
  const xi = Math.min(img.width - 1, Math.max(0, Math.round(x)))
  const yi = Math.min(img.height - 1, Math.max(0, Math.round(y)))
  const o = (yi * img.width + xi) * 4
  return { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] }
}

/**
 * 양선형(bilinear) 샘플링 — 인식 단계에서 쓴다.
 * 작은 글자를 48px 높이로 늘릴 때 최근접 이웃은 획이 계단처럼 깨져 오인식이 늘어난다.
 */
function sampleBilinear(
  img: DecodedImage,
  x: number,
  y: number
): { r: number; g: number; b: number } {
  const cx = Math.min(img.width - 1, Math.max(0, x))
  const cy = Math.min(img.height - 1, Math.max(0, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(img.width - 1, x0 + 1)
  const y1 = Math.min(img.height - 1, y0 + 1)
  const fx = cx - x0
  const fy = cy - y0
  const at = (px: number, py: number, c: number): number => img.data[(py * img.width + px) * 4 + c]
  const mix = (c: number): number => {
    const top = at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx
    const bottom = at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx
    return top * (1 - fy) + bottom * fy
  }
  return { r: mix(0), g: mix(1), b: mix(2) }
}

/** 32의 배수로 맞춘 검출 입력 크기를 고른다 */
export function detInputSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height, 1)
  const scale = Math.min(1, DET_MAX_SIDE / longest)
  const round = (v: number): number =>
    Math.max(DET_STRIDE, Math.round((v * scale) / DET_STRIDE) * DET_STRIDE)
  return { width: round(width), height: round(height) }
}

/** 검출 입력 텐서(CHW, ImageNet 정규화)를 만든다 */
function buildDetInput(img: DecodedImage, w: number, h: number): Float32Array {
  const plane = w * h
  const out = new Float32Array(3 * plane)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = samplePixel(img, (x * img.width) / w, (y * img.height) / h)
      const i = y * w + x
      out[i] = (p.r / 255 - DET_MEAN[0]) / DET_STD[0]
      out[plane + i] = (p.g / 255 - DET_MEAN[1]) / DET_STD[1]
      out[2 * plane + i] = (p.b / 255 - DET_MEAN[2]) / DET_STD[2]
    }
  }
  return out
}

/** 검출된 사각형을 잘라 인식 입력 텐서(높이 48, [-1,1] 정규화)로 만든다 */
function buildRecInput(img: DecodedImage, box: BoxTuple): { data: Float32Array; width: number } {
  const [bx, by, bw, bh] = box
  const w = Math.max(
    REC_MIN_WIDTH,
    Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * bw) / Math.max(1, bh)))
  )
  const plane = w * REC_HEIGHT
  const out = new Float32Array(3 * plane)
  for (let y = 0; y < REC_HEIGHT; y++) {
    for (let x = 0; x < w; x++) {
      const p = sampleBilinear(img, bx + (x * bw) / w, by + (y * bh) / REC_HEIGHT)
      const i = y * w + x
      out[i] = p.r / 127.5 - 1
      out[plane + i] = p.g / 127.5 - 1
      out[2 * plane + i] = p.b / 127.5 - 1
    }
  }
  return { data: out, width: w }
}

/** 기본 모델 보관 위치 — %APPDATA%/SAMBA Browser/models/ocr */
export function defaultModelsDir(): string {
  return join(app.getPath('userData'), 'models', 'ocr')
}

export class OcrEngine {
  private readonly dir: string
  private downloading: Promise<void> | null = null
  private detSession: InferenceSession | null = null
  private recSession: InferenceSession | null = null
  private dict: string[] | null = null
  private loading: Promise<void> | null = null

  constructor(dir?: string) {
    // 테스트는 임시 폴더를 주입하고, 앱은 userData 아래를 쓴다
    this.dir = dir ?? defaultModelsDir()
  }

  modelsDir(): string {
    return this.dir
  }

  /** 세 파일이 모두 제자리에 있으면 true(해시 검사는 다운로드 시점에만 한다) */
  hasModels(): boolean {
    return OCR_MODEL_FILES.every((f) => existsSync(join(this.dir, f.name)))
  }

  /** 다운로드가 진행 중인지 */
  isDownloading(): boolean {
    return this.downloading !== null
  }

  /**
   * 모델이 없으면 허깅페이스에서 내려받는다. 동시에 여러 번 불러도 실제 다운로드는 한 번만 돈다.
   * 실패하면 부분 파일을 지우고 어떤 파일에서 왜 실패했는지 담은 오류를 던진다.
   */
  async ensureModels(onProgress?: (p: OcrProgress) => void): Promise<void> {
    if (this.hasModels()) return
    if (this.downloading) return this.downloading
    this.downloading = this.downloadAll(onProgress).finally(() => {
      this.downloading = null
    })
    return this.downloading
  }

  private async downloadAll(onProgress?: (p: OcrProgress) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const count = OCR_MODEL_FILES.length
    for (let index = 0; index < count; index++) {
      const file = OCR_MODEL_FILES[index]
      const target = join(this.dir, file.name)
      if (existsSync(target)) continue
      await this.downloadOne(file, target, (receivedBytes, totalBytes) =>
        onProgress?.({
          file: file.name,
          index: index + 1,
          count,
          receivedBytes,
          totalBytes
        })
      )
    }
  }

  private async downloadOne(
    file: ModelFile,
    target: string,
    onBytes: (received: number, total: number) => void
  ): Promise<void> {
    const url = `${HF_BASE}/${file.remote}`
    const partial = `${target}.part`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      const body = res.body
      if (!body) throw new Error('empty response body')
      const total = Number(res.headers.get('content-length')) || file.bytes
      const chunks: Uint8Array[] = []
      let received = 0
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
        received += chunk.byteLength
        onBytes(received, total)
      }
      const buffer = Buffer.concat(chunks)
      const digest = createHash('sha256').update(buffer).digest('hex')
      if (digest !== file.sha256) {
        throw new Error(`checksum mismatch (expected ${file.sha256}, got ${digest})`)
      }
      await writeFile(partial, buffer)
      await rename(partial, target)
    } catch (e) {
      // 부분 파일이 남아 다음 시도에서 깨진 모델로 오인되지 않게 지운다
      await unlink(partial).catch(() => undefined)
      const reason = e instanceof Error ? e.message : String(e)
      throw new Error(`OCR 모델 다운로드 실패 (${file.name}, ${url}): ${reason}`)
    }
  }

  /** 세션과 사전을 한 번만 적재한다 */
  private async load(): Promise<void> {
    if (this.detSession && this.recSession && this.dict) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      // onnxruntime-node 는 28MB 네이티브 런타임을 끌어오므로 실제로 쓸 때만 적재한다
      const ort = await import('onnxruntime-node')
      const options: InferenceSession.SessionOptions = {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3
      }
      this.detSession = await ort.InferenceSession.create(join(this.dir, 'det.onnx'), options)
      this.recSession = await ort.InferenceSession.create(join(this.dir, 'rec.onnx'), options)
      const raw = await readFile(join(this.dir, 'dict.txt'), 'utf8')
      const lines = raw.split('\n')
      // 파일 끝 개행으로 생기는 빈 항목만 제거한다(사전 마지막 항목은 공백 문자라 함부로 trim 하면 안 된다)
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      this.dict = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /** 적재된 세션을 닫는다(설정에서 OCR 을 끄거나 앱을 종료할 때) */
  async dispose(): Promise<void> {
    await this.detSession?.release?.()
    await this.recSession?.release?.()
    this.detSession = null
    this.recSession = null
    this.dict = null
  }

  /**
   * PNG 버퍼에서 글자를 읽는다.
   * 좌표는 입력 이미지(= 캡처 영역) 기준 [x, y, width, height] 이다.
   */
  async recognize(imagePng: Buffer): Promise<OcrResult> {
    if (!this.hasModels()) {
      throw new Error('OCR 모델이 아직 준비되지 않았습니다. ensureModels 를 먼저 호출하세요.')
    }
    await this.load()
    const det = this.detSession
    const rec = this.recSession
    const dict = this.dict
    if (!det || !rec || !dict) throw new Error('OCR 세션 적재에 실패했습니다.')

    const ort = await import('onnxruntime-node')
    const img = decodePng(imagePng)
    if (img.width === 0 || img.height === 0) return { lines: [], text: '' }

    // 1) 검출 — DB 확률맵
    const size = detInputSize(img.width, img.height)
    const detInput = new ort.Tensor('float32', buildDetInput(img, size.width, size.height), [
      1,
      3,
      size.height,
      size.width
    ])
    const detOut = await det.run({ [det.inputNames[0]]: detInput })
    const prob = detOut[det.outputNames[0]] as Tensor
    const probHeight = Number(prob.dims[prob.dims.length - 2])
    const probWidth = Number(prob.dims[prob.dims.length - 1])
    const probData = prob.data as Float32Array

    // 2) 확률맵 → 사각형(원본 좌표)
    const regions = findRegions(probData, probWidth, probHeight)
    const boxes = toImageBoxes(regions, probWidth, probHeight, img.width, img.height)
      .filter((b) => b.box[2] > 2 && b.box[3] > 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_REGIONS)

    // 3) 잘라서 인식 — CTC 디코딩
    const lines: OcrLine[] = []
    for (const candidate of boxes) {
      const { data, width } = buildRecInput(img, candidate.box)
      const recInput = new ort.Tensor('float32', data, [1, 3, REC_HEIGHT, width])
      const recOut = await rec.run({ [rec.inputNames[0]]: recInput })
      const logits = recOut[rec.outputNames[0]] as Tensor
      const timeSteps = Number(logits.dims[1])
      const numClasses = Number(logits.dims[2])
      const { text, score } = decodeCtc(logits.data as Float32Array, timeSteps, numClasses, dict)
      const trimmed = text.trim()
      if (!trimmed || score < REC_MIN_SCORE) continue
      lines.push({ text: trimmed, box: candidate.box, score: Number(score.toFixed(3)) })
    }

    const ordered = sortLines(lines)
    return { lines: ordered, text: mergeLineText(ordered) }
  }
}

export { clipText }
export type { OcrLine, BoxTuple }

/** 모델 파일 크기 합계(안내 문구용) */
export async function modelsDiskUsage(dir: string): Promise<number> {
  let sum = 0
  for (const f of OCR_MODEL_FILES) {
    const s = await stat(join(dir, f.name)).catch(() => null)
    if (s) sum += s.size
  }
  return sum
}
