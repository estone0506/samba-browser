// 동기화 공용 타입·상수(메인·렌더러 양쪽에서 쓴다)

// 동기화 대상 표. 감사 로그(audit_log)는 기기 밖으로 내보내지 않으므로 여기 없다
export const SYNC_TABLES = ['settings', 'accounts', 'vault_items', 'bookmarks'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]
