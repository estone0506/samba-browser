// 캡처 저장 폴더·파일명 결정. fs 는 주입받아 테스트할 수 있게 남긴다

import { join, resolve } from 'node:path'
import { captureFileName, DEFAULT_CAPTURE_FOLDER_NAME } from '../../shared/capture'

export interface CapturePathFs {
  exists: (path: string) => boolean
  mkdir: (path: string) => void
}

export interface CaptureDirInput {
  /** 설정의 저장 폴더. 비어 있으면 다운로드 폴더 아래 기본 폴더를 쓴다 */
  configured: string
  /** 사용자의 다운로드 폴더 */
  downloads: string
}

/**
 * 저장 폴더를 정하고 없으면 만든다.
 * 설정 값이 있어도 만들 수 없으면(권한·잘못된 경로) 기본 폴더로 되돌린다 —
 * 캡처가 통째로 실패하는 것보다 낫다
 */
export function resolveCaptureDir(input: CaptureDirInput, fs: CapturePathFs): string {
  const fallback = join(input.downloads, DEFAULT_CAPTURE_FOLDER_NAME)
  const configured = input.configured.trim()
  if (configured) {
    try {
      if (!fs.exists(configured)) fs.mkdir(configured)
      return configured
    } catch {
      // 아래 기본 폴더로 떨어진다
    }
  }
  if (!fs.exists(fallback)) fs.mkdir(fallback)
  return fallback
}

/**
 * 두 경로가 같은 폴더를 가리키는가.
 *
 * 문자열 비교만 하면 `C:\a\b` 와 `C:/a/b/`, `c:\a\b` 가 서로 달라 보여
 * 자기 캡처 폴더 안의 파일인데도 "폴더 밖" 으로 거절당한다.
 * 구분자·끝 구분자·대소문자(윈도우)를 맞춰 견준다
 */
export function samePath(
  a: string,
  b: string,
  caseInsensitive = process.platform === 'win32'
): boolean {
  const normalize = (p: string): string => {
    const unified = resolve(p).replace(/[\\/]+$/, '')
    return caseInsensitive ? unified.toLowerCase() : unified
  }
  if (!a || !b) return false
  return normalize(a) === normalize(b)
}

export interface CaptureFileTarget {
  filePath: string
  fileName: string
}

/**
 * `YYYYMMDD-HHmmss.<ext>`. 같은 초에 이미 파일이 있으면 `-2`, `-3` … 을 붙여
 * 기존 캡처를 덮어쓰지 않는다
 */
export function uniqueCaptureFile(
  dir: string,
  date: Date,
  extension: string,
  exists: (path: string) => boolean
): CaptureFileTarget {
  // 같은 초에 100장을 넘기는 일은 없지만, 무한 루프는 만들지 않는다
  for (let seq = 1; seq <= 100; seq += 1) {
    const fileName = captureFileName(date, extension, seq)
    const filePath = join(dir, fileName)
    if (!exists(filePath)) return { filePath, fileName }
  }
  const fileName = captureFileName(date, extension, Date.now() % 100000)
  return { filePath: join(dir, fileName), fileName }
}
