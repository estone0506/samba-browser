// 전체 페이지 캡처의 이미지 이어붙이기. RGBA 버퍼만 다루는 순수 로직이라
// electron 없이 그대로 테스트할 수 있다

import { PNG } from 'pngjs'
import type { FullPageStep } from '../../shared/capture'

export interface RgbaImage {
  width: number
  height: number
  /** RGBA 8bit, width*height*4 바이트 */
  data: Uint8Array
}

/** 장 하나의 좌표(CSS 픽셀)를 실제 이미지 픽셀로 환산한다 */
export interface DeviceStep {
  sourceTop: number
  height: number
  destTop: number
}

export function toDeviceStep(step: FullPageStep, scale: number): DeviceStep {
  return {
    sourceTop: Math.round(step.sourceTop * scale),
    height: Math.round(step.height * scale),
    destTop: Math.round(step.destTop * scale)
  }
}

/**
 * src 의 [sourceTop, sourceTop+height) 가로줄을 dest 의 destTop 부터 복사한다.
 * 경계를 넘는 부분은 잘라 내고, 복사한 줄 수를 돌려준다
 */
export function blitRows(dest: RgbaImage, src: RgbaImage, step: DeviceStep): number {
  const width = Math.min(dest.width, src.width)
  if (width <= 0) return 0
  const sourceTop = Math.max(0, step.sourceTop)
  const destTop = Math.max(0, step.destTop)
  const rows = Math.min(step.height, src.height - sourceTop, dest.height - destTop)
  if (rows <= 0) return 0
  const rowBytes = width * 4
  for (let row = 0; row < rows; row += 1) {
    const from = (sourceTop + row) * src.width * 4
    const to = (destTop + row) * dest.width * 4
    dest.data.set(src.data.subarray(from, from + rowBytes), to)
  }
  return rows
}

/** 빈(투명 아닌 흰색) 캔버스를 만든다. 마지막 장이 짧아도 검은 띠가 남지 않는다 */
export function createCanvas(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  data.fill(255)
  return { width, height, data }
}

/** PNG 버퍼 → RGBA 이미지 */
export function decodePng(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer)
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

/** RGBA 이미지 → PNG 버퍼 */
export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height })
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  return PNG.sync.write(png)
}
