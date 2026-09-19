// 웹페이지 preload(page.ts) 전용 상수 사본.
//
// [중요] 여기의 값들은 src/shared/* 의 원본과 **수동으로 동기화해야 한다**.
//   - MAX_ELEMENTS      ← src/shared/snapshot.ts 의 MAX_ELEMENTS
//   - PAGE_IPC.vaultCapture ← src/shared/ipc.ts 의 IPC.vaultCapture
//   - PAGE_IPC.vaultPickerAccounts/vaultPickerFill ← 같은 파일의 IPC 동명 채널
//   - PAGE_IPC.settingsGet ← 같은 파일의 IPC.settingsGet
//   - PAGE_IPC.newTabInit/newTabSearch/newTabOpen ← 같은 파일의 IPC 동명 채널
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
  // 캡처 영역 선택(요소 단위). 메인이 모드를 켜고, 클릭한 요소 경계만 돌려보낸다
  captureRegionMode: 'capture:regionMode',
  captureElementRect: 'capture:elementRect'
} as const

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
