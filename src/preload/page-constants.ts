// 웹페이지 preload(page.ts) 전용 상수 사본.
//
// [중요] 여기의 값들은 src/shared/* 의 원본과 **수동으로 동기화해야 한다**.
//   - MAX_ELEMENTS      ← src/shared/snapshot.ts 의 MAX_ELEMENTS
//   - PAGE_IPC.vaultCapture ← src/shared/ipc.ts 의 IPC.vaultCapture
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
  vaultCapture: 'vault:capture'
} as const
