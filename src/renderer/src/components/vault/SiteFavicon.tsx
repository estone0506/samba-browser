import { useEffect, useState } from 'react'
import type React from 'react'

// 파비콘은 메인 프로세스가 "사이트 자체"에서 받아 온 data: URL 로만 온다.
// 예전에는 구글(t0.gstatic.com)에 호스트를 보내 받아왔는데, 그러면 키마스터에 저장된
// 계정 도메인이 전부 제3자에게 넘어가므로 그 경로를 없앴다.

// 렌더러 메모리 캐시. 목록을 스크롤할 때마다 같은 호스트를 다시 묻지 않게 한다.
// undefined = 아직 모름, null = 파비콘 없음(첫 글자 폴백)
const cache = new Map<string, string | null>()
// 같은 호스트에 대한 동시 요청 합치기(목록에 같은 도메인이 여러 번 나올 수 있다)
const inFlight = new Map<string, Promise<string | null>>()

function loadFavicon(host: string): Promise<string | null> {
  const running = inFlight.get(host)
  if (running) return running
  const task = window.samba.favicon
    .get(host)
    .then((res) => (res.ok ? res.data.dataUrl : null))
    .catch(() => null)
    .then((dataUrl) => {
      cache.set(host, dataUrl)
      inFlight.delete(host)
      return dataUrl
    })
  inFlight.set(host, task)
  return task
}

interface Props {
  host: string
  // 시각적 크기(px)
  size?: number
}

/**
 * 사이트 파비콘. 먼저 첫 글자 폴백(검정 원)을 그리고, 파비콘을 받아오면 덮어쓴다.
 * 그래서 로딩이 늦거나 실패해도 빈 칸이 보이지 않는다.
 */
export function SiteFavicon({ host, size = 28 }: Props): React.JSX.Element {
  // 조회가 끝난 호스트와 결과. 캐시에 있으면 렌더 중에 바로 쓰고(상태 갱신 불필요),
  // 없을 때만 effect 가 받아 와서 여기에 넣는다
  const [resolved, setResolved] = useState<{ host: string; dataUrl: string | null } | null>(null)
  const cached = cache.get(host)
  const dataUrl = cached !== undefined ? cached : resolved?.host === host ? resolved.dataUrl : null

  useEffect(() => {
    if (cache.get(host) !== undefined) return
    // 언마운트 후 setState 를 막는다(목록 스크롤로 빠르게 사라질 수 있다)
    let alive = true
    void loadFavicon(host).then((value) => {
      if (alive) setResolved({ host, dataUrl: value })
    })
    return () => {
      alive = false
    }
  }, [host])

  const style = { width: size, height: size }
  return (
    <span
      style={style}
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--text)] text-[12px] font-bold text-white"
    >
      {!dataUrl && <span>{host.slice(0, 1).toUpperCase()}</span>}
      {dataUrl && (
        <img
          src={dataUrl}
          alt=""
          width={size}
          height={size}
          className="absolute inset-0 h-full w-full bg-white object-contain"
        />
      )}
    </span>
  )
}
