// [규칙 — 절대 어기지 말 것]
// 이 파일은 탭 WebContentsView 에 `sandbox: true` 로 주입되는 preload 다.
// sandbox preload 는 **다른 파일을 require() 할 수 없다**. 따라서 번들 결과
// out/preload/page.js 는 `require('electron')` 외에 어떤 require 도 있어선 안 된다.
//
// page.ts / page-core.ts 에서 src/shared/* 의 **값(value)** 을 import 하면
// renderer.ts 도 같은 모듈을 쓰기 때문에 Rollup 이 out/preload/chunks/*.js 로 공통 청크를
// 분리하고, page.js 가 그것을 require() 하게 된다 → preload 로드 실패
// → globalThis.__samba 미정의 → AI 의 get_page/login 이 전부 실패한다.
//
// 규칙: shared 에서는 `import type` 만(타입은 번들에 남지 않는다).
//       상수/채널명 등 값은 ./page-constants.ts 에 복제해서 쓴다.
//       relative import(./page-core 등)는 같은 엔트리에 인라인되므로 안전하다.
// 회귀 방지 테스트: tests/preload-bundle.test.ts
import { contextBridge, ipcRenderer } from 'electron'
import {
  GESTURE_ACTION_LABELS,
  INTERNAL_PROTOCOL,
  PAGE_IPC,
  PICKER_LABELS,
  WEBSTORE_LABELS
} from './page-constants'
import { installGestureRecognizer, type GestureConfig } from './page-gesture'
import type { IpcResult, Settings } from '../shared/ipc'
import {
  buildSnapshot,
  textOf,
  performClick,
  performType,
  performSelect,
  performScroll,
  fillValue,
  findLoginFields,
  signedInHint,
  captchaHint,
  checkKeepSignedIn,
  submitForm,
  isSecretField,
  installCaptureListener
} from './page-core'
import {
  installAutofillPicker,
  type PickerAccountsResponse,
  type PickerFillResponse
} from './page-picker'
import { installRegionPicker, REGION_HINTS } from './page-capture'
import { installWebstoreHook, isWebstoreHost, type WebstoreInstallResult } from './page-webstore'
import type { NewTabInitDto } from '../shared/newtab'
import { installPageTranslate, type ImageOverlayDto } from './page-translate'

// 이 preload 는 세션 단위(registerPreloadScript type:'frame')로 등록돼 모든 프레임에서 돈다.
// 탭의 webPreferences.preload 로만 걸면 window.open 으로 열린 팝업(결제창 등)에는 붙지 않기 때문이다.
// iframe 에서는 아무것도 설치하지 않는다 — AI 스냅샷·제스처·번역·계정 선택기는 최상위 문서만 다룬다
if (window.self === window.top) {
  // AI 실행기. contextIsolation 이 켜져 있으면 preload 는 격리 월드(WorldId 999)에서 실행되므로
  // contextBridge 로 메인 월드에 노출하지 않고 격리 월드 전역에만 둔다.
  // 메인 프로세스는 executeJavaScriptInIsolatedWorld(999, '__samba.snapshot()') 로 호출한다.
  // → 적대 페이지가 __samba 를 가로채거나 프로토타입 오염으로 결과를 왜곡할 수 없다.
  const api = {
    snapshot: () => buildSnapshot(),
    // 요소의 실제 텍스트 조회(위험 행동 판정용)
    textOf: (id: number) => textOf(id),
    click: (id: number) => performClick(id),
    type: (id: number, text: string, submit: boolean) => performType(id, text, submit),
    select: (id: number, value: string) => performSelect(id, value),
    scroll: (dir: 'up' | 'down') => performScroll(dir),
    // SECRET 허용 — 메인 프로세스만 호출(AI 텍스트 도구 경로가 아님)
    fillValue: (id: number, value: string) => fillValue(id, value),
    findLoginFields: () => findLoginFields(),
    // 이미 로그인돼 있는지 힌트(로그인 폼이 없을 때만 의미가 있다)
    signedInHint: () => signedInHint(),
    // 캡차·2FA 징후. 사용자에게 넘기기 위한 감지 전용이다
    captchaHint: () => captchaHint(),
    // 제출 직전 "로그인 상태 유지" 체크박스 켜기
    checkKeepSignedIn: (anchorId?: number) => checkKeepSignedIn(anchorId),
    submitForm: (id: number) => submitForm(id),
    // 최신 스냅샷 기준으로 요소가 비밀 입력칸(type=password)인지 확인(fill_secret 대상 검증용)
    isSecretField: (id: number) => isSecretField(id)
  }

  // globalThis 에 직접 대입(any 없이 타입 안전하게)
  Object.assign(globalThis, { __samba: api })

  // 폼 제출 감지 → 메인의 vault:capture 로 전달(비밀번호는 이 채널로만, pendingCapture 에만 잠깐 머문다)
  // 격리 월드 preload 는 contextIsolation 하에서도 ipcRenderer 를 직접 사용할 수 있다
  // 옵션 없이 호출 → 합성(스크립트 생성) 이벤트는 무시하고 신뢰된(isTrusted) 사용자 이벤트만 처리한다
  installCaptureListener((payload) => ipcRenderer.send(PAGE_IPC.vaultCapture, payload))

  // 페이지 내 자동 채움 피커. 계정 목록에는 값이 없고, 채우기는 메인이 수행한다.
  // 문구는 페이지 언어가 아니라 앱 언어를 따라야 하므로, settings:get 으로 현재 언어를
  // 물어본 뒤 page-constants 의 ko/en 표에서 골라 쓴다(격리 월드에는 i18n 모듈을 쓸 수 없다).
  // 응답이 늦거나 실패해도 피커는 즉시 동작해야 하므로 기본은 한국어로 두고 설치한다
  let appLanguage: 'ko' | 'en' = 'ko'
  void ipcRenderer
    .invoke(PAGE_IPC.settingsGet)
    .then((r: IpcResult<Settings>) => (r.ok && r.data.language === 'en' ? 'en' : 'ko'))
    .catch(() => 'ko' as const)
    .then((language: 'ko' | 'en') => {
      appLanguage = language
      installAutofillPicker({
        listAccounts: (host) =>
          ipcRenderer.invoke(PAGE_IPC.vaultPickerAccounts, host) as Promise<PickerAccountsResponse>,
        fill: (accountId) =>
          ipcRenderer.invoke(PAGE_IPC.vaultPickerFill, {
            accountId
          }) as Promise<PickerFillResponse>,
        labels: PICKER_LABELS[language]
      })
    })

  // === 마우스 제스처 ===================================================
  // 켜짐 여부와 시퀀스→동작 매핑은 메인이 밀어 준다(page:gestureConfig).
  // 아직 못 받았으면 꺼진 것으로 보고 궤적도 그리지 않는다
  let gestureConfig: GestureConfig = { enabled: false, language: 'ko', mapping: {} }

  ipcRenderer.on(PAGE_IPC.gestureConfig, (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return
    const next = raw as Partial<GestureConfig>
    gestureConfig = {
      enabled: next.enabled === true,
      language: next.language === 'en' ? 'en' : 'ko',
      mapping: typeof next.mapping === 'object' && next.mapping !== null ? next.mapping : {}
    }
  })

  installGestureRecognizer({
    send: (sequence) => ipcRenderer.send(PAGE_IPC.gesture, sequence),
    config: () => gestureConfig,
    labelOf: (sequence) => {
      if (!sequence) return ''
      const action = gestureConfig.mapping[sequence]
      if (typeof action !== 'string' || action === 'none') return ''
      const labels: Record<string, string> = GESTURE_ACTION_LABELS[gestureConfig.language]
      return labels[action] ?? ''
    }
  })
  // === 마우스 제스처 끝 =======================================================
  // === 화면 번역 · 이미지 번역 ================================================
  // 원문 배열 → 같은 순서의 번역 배열. 메인이 캐시와 AI 호출을 담당한다.
  // 이 채널에는 입력값·비밀번호가 실리지 않는다(DOM 텍스트 노드만 모은다)
  const translateApi = installPageTranslate({
    translate: async (texts, lang) => {
      const reply = (await ipcRenderer.invoke(PAGE_IPC.pageTranslate, { lang, texts })) as
        IpcResult<string[]> | undefined
      if (!reply) return { ok: false, error: 'translate:failed' }
      return reply.ok ? { ok: true, texts: reply.data } : { ok: false, error: reply.error }
    },
    // 진행률에는 개수와 오류 코드만 담긴다(원문·번역문은 이 채널로 나가지 않는다)
    progress: (p) => ipcRenderer.send(PAGE_IPC.pageTranslateProgress, p)
  })

  // 메인이 격리 월드에서 직접 호출한다(주소창 팝오버 · 이미지 우클릭 메뉴)
  Object.assign(globalThis, {
    __sambaTranslate: {
      run: (lang: string): Promise<string> => translateApi.run(lang),
      restore: (): string => translateApi.restore(),
      active: (): boolean => translateApi.active(),
      showImageOverlay: (dto: ImageOverlayDto): string => translateApi.showImageOverlay(dto),
      hideImageOverlay: (): void => translateApi.hideImageOverlay()
    }
  })
  // === 화면 번역 끝 ===========================================================
  // === 캡처 · 영역 선택(요소 단위) ============================================
  // 메인이 모드를 켤 때만 하이라이트가 붙고, 클릭한 요소의 경계 네 값만 되돌려 보낸다.
  // 페이지가 스스로 켤 수는 없다(메인이 활성 탭에만 모드를 보낸다)
  const regionPicker = installRegionPicker({
    send: (rect) => ipcRenderer.send(PAGE_IPC.captureElementRect, rect)
  })
  ipcRenderer.on(
    PAGE_IPC.captureRegionMode,
    (_event, payload: { active?: boolean } | undefined) => {
      if (payload?.active) regionPicker.start(REGION_HINTS[appLanguage])
      else regionPicker.stop()
    }
  )
  // === 캡처 끝 ================================================================

  // === 크롬 웹스토어 "Chrome에 추가" ==========================================
  // 웹스토어 호스트에서만 건다. 원래 버튼은 Electron 에서 "설치 불가" 안내만 띄우므로
  // 캡처 단계에서 클릭을 가로채고, 메인이 crx 를 내려받아 설치한다.
  // SPA 라 주소가 바뀌어도 리스너는 document 에 한 번만 걸려 있으면 된다
  if (isWebstoreHost(location.host)) {
    const webstore = installWebstoreHook({
      install: (id) => ipcRenderer.send(PAGE_IPC.webstoreInstall, id),
      labels: () => WEBSTORE_LABELS[appLanguage]
    })
    ipcRenderer.on(PAGE_IPC.webstoreInstallResult, (_event, payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return
      const result = payload as Partial<WebstoreInstallResult>
      if (typeof result.id !== 'string') return
      webstore.finish({ id: result.id, ok: result.ok === true })
    })
  }
  // === 크롬 웹스토어 끝 =======================================================

  // === 자체 새 탭 페이지 브리지 ===============================================
  // 내부 스킴(samba:) 문서에서만 메인 월드에 노출한다. 웹 페이지는 protocol 이 http(s) 라
  // 이 분기에 들어올 수 없고, 메인도 발신자 URL 을 다시 검증한다
  if (location.protocol === INTERNAL_PROTOCOL) {
    contextBridge.exposeInMainWorld('sambaNewTab', {
      init: (): Promise<NewTabInitDto> =>
        ipcRenderer.invoke(PAGE_IPC.newTabInit) as Promise<NewTabInitDto>,
      search: (input: string): void => ipcRenderer.send(PAGE_IPC.newTabSearch, input),
      open: (url: string): void => ipcRenderer.send(PAGE_IPC.newTabOpen, url)
    })
  }
  // === 새 탭 페이지 브리지 끝 =================================================
}
