// 키마스터 목록의 도메인 그룹 계산 순수 함수.
// 컴포넌트와 분리해 두어 단위 테스트가 가능하다.

import { accountGroupKey } from '@shared/host'
import type { AccountDto } from '@shared/ipc'

export interface DomainGroup {
  // 그룹 키이자 헤더에 보여 줄 도메인(registrableDomain 결과)
  key: string
  accounts: AccountDto[]
}

/**
 * 계정을 사이트 그룹 키(보통 등록 도메인)로 묶고 알파벳순으로 정렬한다.
 * nid.naver.com · mail.naver.com 은 naver.com 으로, accounts.commerce.naver.com 은 commerce.naver.com 으로 따로 모인다.
 */
export function groupByDomain(accounts: AccountDto[]): DomainGroup[] {
  const map = new Map<string, AccountDto[]>()
  for (const a of accounts) {
    const key = accountGroupKey(a.host) || a.host
    const list = map.get(key) ?? []
    list.push(a)
    map.set(key, list)
  }
  return [...map.entries()]
    .map(([key, list]) => ({ key, accounts: list }))
    .sort((a, b) => a.key.localeCompare(b.key))
}
