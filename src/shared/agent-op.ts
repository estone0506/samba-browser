// 메인 프로세스가 iframe 안 preload 에 맡기는 동작 한 건.
//
// WebFrameMain 에는 executeJavaScriptInIsolatedWorld 가 없다. frame.executeJavaScript 는
// 페이지의 메인 월드에서 돌아 격리 월드의 __samba 에 닿지 못하고, 거기에 실행기를 두면
// 적대 페이지가 가로챌 수 있다. 그래서 프레임 호출은 IPC 로 하되 **코드 문자열은 보내지 않고**
// 미리 정해진 동작 이름과 인자만 보낸다 — 프레임 preload 는 이 목록에 있는 것만 실행한다.
//
// [주의] 이 파일은 preload(page-core.ts)에서도 쓰이므로 **타입만** 있어야 한다.
// 값(상수·함수)을 넣으면 Rollup 이 공용 청크를 만들어 preload 번들이 깨진다
// (tests/preload-bundle.test.ts 참고)
export type AgentOp =
  | { op: 'snapshot'; query?: string; selector?: string }
  | { op: 'textOf'; id: number }
  | { op: 'click'; id: number }
  | { op: 'type'; id: number; text: string; submit: boolean }
  | { op: 'select'; id: number; value: string }
  | { op: 'scroll'; dir: 'up' | 'down'; id?: number }
  | { op: 'fillValue'; id: number; value: string }
  | { op: 'submitForm'; id: number }
  | { op: 'isSecretField'; id: number }
  | { op: 'keypadSignals' }
  | { op: 'overlays' }

/** 메인 → 프레임 요청(동작 + 짝 맞추기용 번호) */
export type AgentOpRequest = AgentOp & { reqId: number }

/** 프레임 → 메인 응답. 실패하면 ok:false 만 온다(오류 문구에 페이지 값이 섞이지 않게) */
export interface AgentOpReply {
  reqId: number
  ok: boolean
  value?: unknown
}
