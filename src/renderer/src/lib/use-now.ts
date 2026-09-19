import { useEffect, useState } from 'react'

/**
 * 상대 시간("2시간 후")이 멈춰 있지 않도록 30초마다 지금 시각을 다시 잡는다.
 * 예약 카드와 작업 페이지가 같은 시계를 써야 두 화면의 문구가 어긋나지 않는다
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
