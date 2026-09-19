import './index.css'
import './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useOverlayStore } from './stores/overlayStore'
import { useUiStore } from './stores/uiStore'
import { useCaptureStore } from './stores/captureStore'

// 개발 빌드에서만: 스토어를 전역에 노출해 CDP 로 상태를 들여다보고 되돌릴 수 있게 한다
if (import.meta.env.DEV) {
  Object.assign(window, {
    __sambaDebug: { overlay: useOverlayStore, ui: useUiStore, capture: useCaptureStore }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
