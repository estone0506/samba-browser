import type { WebContents } from 'electron'

// 갤럭시 기준 모바일 흉내: UA + 뷰포트 + 터치
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-F711N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

function attach(wc: WebContents): boolean {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    return true
  } catch (e) {
    console.error('디버거 연결 실패', e)
    return false
  }
}

export function applyMobileEmulation(wc: WebContents): void {
  if (!attach(wc)) return
  wc.setUserAgent(MOBILE_UA)
  void wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.6,
    mobile: true
  })
  void wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5
  })
  void wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
    userAgent: MOBILE_UA,
    platform: 'Android'
  })
}

export function clearMobileEmulation(wc: WebContents): void {
  if (!wc.debugger.isAttached()) return
  void wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
  void wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
  wc.setUserAgent('')
  wc.debugger.detach()
}
