// 진단용 스크립트 폐기(2026-09-27) — 아무것도 누르지 않고 끝난다. 정식 스크립트(hmall_*, checkout_enter_hmall)를 쓴다
const seen = Object.keys(args || {}).length
return { ok: false, retired: true, dry: true, args_seen: seen, note: 'hmall_diag 폐기 — 정식 스크립트를 쓴다' }
