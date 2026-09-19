// 웹페이지 preload(page.ts) 전용 상수 사본.
//
// [중요] 여기의 값들은 src/shared/* 의 원본과 **수동으로 동기화해야 한다**.
//   - MAX_ELEMENTS      ← src/shared/snapshot.ts 의 MAX_ELEMENTS
//   - PAGE_IPC.vaultCapture ← src/shared/ipc.ts 의 IPC.vaultCapture
//   - PAGE_IPC.vaultPickerAccounts/vaultPickerFill ← 같은 파일의 IPC 동명 채널
//   - PAGE_IPC.settingsGet ← 같은 파일의 IPC.settingsGet
//   - PAGE_IPC.newTabInit/newTabSearch/newTabOpen ← 같은 파일의 IPC 동명 채널
//   - PAGE_IPC.gesture/gestureConfig ← 같은 파일의 IPC.pageGesture/pageGestureConfig
//   - GESTURE_ACTION_LABELS 의 키 집합 ← src/shared/gestures.ts 의 GESTURE_ACTIONS
//   - PAGE_IPC.pageTranslate/pageTranslateProgress ← 같은 파일의 IPC 동명 채널
//   - TRANSLATE_MAX_NODES/TRANSLATE_MAX_CHARS/TRANSLATE_CONCURRENCY ← src/shared/translate.ts 의 동명 상수
//   - PAGE_IPC.captureRegionMode/captureElementRect ← 같은 파일의 IPC 동명 채널
//   - INTERNAL_PROTOCOL ← src/shared/url.ts 의 INTERNAL_SCHEME + ':'
//
// 왜 복제하는가:
// page.ts 는 sandbox:true 로 주입되는 preload 라 다른 파일을 require() 할 수 없다.
// page.ts 와 renderer.ts 가 src/shared/* 의 **값(value)** 을 함께 import 하면
// Rollup 이 공통 모듈을 out/preload/chunks/*.js 로 분리하고, 빌드 결과
// out/preload/page.js 에 require("./chunks/…") 가 생겨 preload 로드가 실패한다.
// (→ globalThis.__samba 미정의 → AI 의 get_page/login 전부 실패)
//
// 값이 어긋나면 tests/preload-bundle.test.ts 가 실패한다.

// 스냅샷에 담는 최대 요소 수
export const MAX_ELEMENTS = 150

// preload(격리 월드) → 메인 프로세스 IPC 채널
export const PAGE_IPC = {
  vaultCapture: 'vault:capture',
  vaultPickerAccounts: 'vault:pickerAccounts',
  vaultPickerFill: 'vault:pickerFill',
  settingsGet: 'settings:get',
  newTabInit: 'newtab:init',
  newTabSearch: 'newtab:search',
  newTabOpen: 'newtab:open',
  // 마우스 제스처: 인식된 시퀀스를 메인으로 보내는 채널(page → main)
  gesture: 'page:gesture',
  // 메인이 켜짐 여부와 시퀀스→동작 매핑을 밀어 주는 채널(main → page)
  gestureConfig: 'page:gestureConfig',
  pageTranslate: 'page:translate',
  // 번역 진행률(page → main). 개수와 오류 코드만 싣고 원문·번역문은 싣지 않는다
  pageTranslateProgress: 'page:translateProgress',
  // 캡처 영역 선택(요소 단위). 메인이 모드를 켜고, 클릭한 요소 경계만 돌려보낸다
  captureRegionMode: 'capture:regionMode',
  captureElementRect: 'capture:elementRect'
} as const

// 번역 배치 상한·동시 실행 수 사본
// ← src/shared/translate.ts 의 TRANSLATE_MAX_NODES / TRANSLATE_MAX_CHARS / TRANSLATE_CONCURRENCY
export const TRANSLATE_MAX_NODES = 30
export const TRANSLATE_MAX_CHARS = 1200
export const TRANSLATE_CONCURRENCY = 3

// 자동 채움 피커 문구(ko/en). page.ts 는 settings.language 를 IPC 로 물어본 뒤
// 이 표에서 골라 쓴다(격리 월드에는 i18n 모듈을 쓸 수 없어 여기 복제해 둔다)
export const PICKER_LABELS = {
  ko: {
    locked: '키마스터 잠금 해제 필요',
    empty: '이 사이트에 저장된 계정이 없어요',
    title: '키마스터 계정'
  },
  en: {
    locked: 'Unlock KeyMaster to continue',
    empty: 'No saved accounts for this site',
    title: 'KeyMaster accounts'
  }
} as const

// 내부 페이지 스킴(location.protocol 형태). 새 탭 페이지에서만 브리지를 노출하는 조건이다
export const INTERNAL_PROTOCOL = 'samba:'

// 마우스 제스처 궤적 라벨에 쓰는 동작 이름(ko/en).
// 키 집합은 src/shared/gestures.ts 의 GESTURE_ACTIONS 와 같아야 한다(preload-bundle 테스트가 대조)
export const GESTURE_ACTION_LABELS = {
  ko: {
    none: '없음',
    back: '이전 페이지',
    forward: '다음 페이지',
    scrollTop: '맨 위로',
    scrollBottom: '맨 아래로',
    home: '홈페이지로',
    reload: '새로고침',
    newTab: '새 탭 열기',
    newWindow: '새 창 열기(새 탭)',
    newProfileTab: '새 프로필 탭',
    closeTab: '탭 닫기',
    reopenTab: '닫은 탭 다시 열기',
    fullscreen: '전체화면',
    maximize: '창 최대화',
    minimize: '창 최소화'
  },
  en: {
    none: 'None',
    back: 'Back',
    forward: 'Forward',
    scrollTop: 'Scroll to top',
    scrollBottom: 'Scroll to bottom',
    home: 'Home page',
    reload: 'Reload',
    newTab: 'New tab',
    newWindow: 'New window (opens a tab)',
    newProfileTab: 'New profile tab',
    closeTab: 'Close tab',
    reopenTab: 'Reopen closed tab',
    fullscreen: 'Full screen',
    maximize: 'Maximize window',
    minimize: 'Minimize window'
  }
} as const
