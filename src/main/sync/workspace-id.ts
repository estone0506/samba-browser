// 로컬 작업공간 id ↔ 원격 작업공간 uuid.
//
// 2b 의 범위는 "기본 작업공간만 기기 간 공유" 다. 그래서 기본 작업공간은 **모든 PC 에서
// 같은 고정 uuid** 를 쓴다 — 예전처럼 PC 마다 randomUUID 를 만들면, 풀 필터
// (.eq('workspace_id')) 에 걸려 두 번째 PC 에서는 아무것도 내려오지 않는다.
// 사용자별 RLS 로 이미 분리돼 있어 고정값이어도 다른 사용자와 섞이지 않는다.
//
// 추가 작업공간은 지금까지대로 기기 로컬 uuid 를 쓴다(기기 간 공유 안 함).
// workspaces 표 자체의 동기화는 2c 에서 붙이고, 그때 이 함수도 표의 remote_id 를 읽게 바뀐다

import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { SyncLocal } from './local'

/** 기본 작업공간의 원격 uuid — 모든 PC 가 같은 값을 쓴다 */
export const DEFAULT_WORKSPACE_REMOTE_ID = '00000000-0000-4000-8000-000000000001'

/** sync_state 에 원격 uuid 를 담아 두는 키 */
function stateKey(localWorkspaceId: number): string {
  return `workspace:${localWorkspaceId}:remoteId`
}

/**
 * 이 작업공간이 원격에서 쓸 uuid.
 * 기본 작업공간이면 고정 uuid, 아니면 기기 로컬 uuid 를 만들어 sync_state 에 고정한다
 * (같은 PC 에서 다시 로그인해도 값이 바뀌지 않아야 한다)
 */
export function workspaceRemoteId(db: Db, localWorkspaceId: number, isDefault = false): string {
  const local = new SyncLocal(db)
  const key = stateKey(localWorkspaceId)
  const existing = local.getState(key)
  if (isDefault) {
    // 기기 로컬 uuid 로 굳어 있던 옛 DB 는 여기서 고정 uuid 로 갈아탄다.
    // 옛 uuid 로 올라간 행은 다음 변경 때 새 uuid 로 다시 올라간다
    if (existing !== DEFAULT_WORKSPACE_REMOTE_ID) local.setState(key, DEFAULT_WORKSPACE_REMOTE_ID)
    return DEFAULT_WORKSPACE_REMOTE_ID
  }
  if (existing) return existing
  const created = randomUUID()
  local.setState(key, created)
  return created
}

/**
 * 이미 정해진 uuid 만 읽는다(없으면 null). 새로 만들지 않는다 —
 * 푸시가 지난 작업공간의 대기 변경을 보낼 때, 그 작업공간의 uuid 를 되찾는 용도다
 */
export function storedWorkspaceRemoteId(db: Db, localWorkspaceId: number): string | null {
  return new SyncLocal(db).getState(stateKey(localWorkspaceId))
}
