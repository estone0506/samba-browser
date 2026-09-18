import { useState } from 'react'
import type React from 'react'

// 구글 파비콘 서비스. 실패하거나 로딩이 늦으면 첫 글자 폴백을 그대로 보여 준다
function faviconUrl(host: string, size: number): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`
}

interface Props {
  host: string
  // 시각적 크기(px). 요청 크기는 32 로 고정한다
  size?: number
}

/**
 * 사이트 파비콘. 먼저 첫 글자 폴백(검정 원)을 그리고, 이미지가 실제로 로드되면 덮어쓴다.
 * 그래서 로딩이 늦거나 실패해도 빈 칸이 보이지 않는다.
 */
export function SiteFavicon({ host, size = 28 }: Props): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const style = { width: size, height: size }
  return (
    <span
      style={style}
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--text)] text-[12px] font-bold text-white"
    >
      {!loaded && <span>{host.slice(0, 1).toUpperCase()}</span>}
      <img
        src={faviconUrl(host, 32)}
        alt=""
        width={size}
        height={size}
        onLoad={() => setLoaded(true)}
        className={loaded ? 'absolute inset-0 h-full w-full bg-white object-contain' : 'hidden'}
      />
    </span>
  )
}
