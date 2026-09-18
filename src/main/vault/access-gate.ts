// 금고 값을 페이지에 채우기 전에 통과해야 하는 공통 게이트.
// AI 도구(agent/tools.ts)·E2E 하네스(e2e/login-harness.ts)·사용자 자동 채움(vault/autofill.ts)이
// 같은 규칙을 쓰도록 한 곳에 모았다. electron 의존이 없어 테스트에서 그대로 호출할 수 있다.

import type { VaultAccessPolicy } from '../../shared/settings'
import type { AgentAccess } from '../../shared/vault'
import { normalizeHost, registrableDomain } from '../../shared/host'

// http 라도 비밀값 입력을 허용하는 로컬 개발 호스트
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1']

/**
 * 비밀값을 채워도 되는 페이지인지 판정한다.
 * https 만 허용하고, 로컬 개발 서버(http://localhost 등)만 예외로 둔다.
 * 파싱이 안 되는 URL(about:blank 등)도 거부한다.
 */
export function isSecurePageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:') return LOCAL_HOSTNAMES.includes(u.hostname)
    return false
  } catch {
    return false
  }
}

/**
 * 현재 호스트가 제외 도메인 목록에 있는지 확인한다. 정확 일치뿐 아니라 같은 등록 도메인
 * (eTLD+1)이면 제외로 취급한다 — 제외 설정이 "example.com" 이어도 "login.example.com" 은
 * 새는 서브도메인이 되면 안 된다
 */
export function isHostExcluded(host: string, excludedHosts: readonly string[]): boolean {
  if (excludedHosts.length === 0 || !host) return false
  const hostDomain = registrableDomain(host)
  return excludedHosts.some((raw) => {
    const h = normalizeHost(raw) || raw
    return h === host || registrableDomain(h) === hostDomain
  })
}

/**
 * 계정별 접근 정책과 전역 정책을 합쳐 실제 적용할 정책을 고른다.
 * 계정이 'inherit' 이면 전역 정책을, 아니면 계정 설정이 전역을 override 한다.
 */
export function effectiveAccess(
  accountAccess: AgentAccess | undefined,
  globalPolicy: VaultAccessPolicy
): VaultAccessPolicy {
  if (!accountAccess || accountAccess === 'inherit') return globalPolicy
  return accountAccess
}

/** 게이트 거부 사유. 호출부가 각자의 안내 문구로 바꿔 쓴다 */
export type VaultGateReason = 'host-unknown' | 'insecure-page' | 'excluded' | 'access-never'

export interface VaultGateInput {
  // 값을 채울 페이지의 현재 URL
  url: string
  // 제외 도메인 목록(설정 값 그대로 넘겨도 된다 — 내부에서 정규화한다)
  excludedHosts: readonly string[]
  // 적용할 접근 정책(계정별 override 를 이미 반영한 값). 생략하면 정책 검사를 건너뛴다
  policy?: VaultAccessPolicy
}

/**
 * https·호스트 확인·제외 도메인·접근 정책(never)을 한 번에 검사한다.
 * 통과하면 null, 막히면 사유를 돌려준다. 잠금 해제 시도는 호출부가 맡는다
 * (정책 'always' 의 기기 키 자동 해제는 비동기라 여기서 다루지 않는다).
 */
export function checkVaultGate(input: VaultGateInput): VaultGateReason | null {
  if (input.policy === 'never') return 'access-never'
  const host = normalizeHost(input.url)
  if (!host) return 'host-unknown'
  if (!isSecurePageUrl(input.url)) return 'insecure-page'
  if (isHostExcluded(host, input.excludedHosts)) return 'excluded'
  return null
}

/**
 * 계정의 비밀값을 이 호스트에 채워도 되는지 — 등록 도메인(eTLD+1)이 같아야 한다.
 * nid.naver.com 계정을 www.naver.com 에 채우는 것은 허용하고,
 * 폴백 이동으로 전혀 다른 사이트에 내려섰을 때만 막는다.
 */
export function sameRegistrableDomain(hostA: string, hostB: string): boolean {
  const a = registrableDomain(hostA)
  const b = registrableDomain(hostB)
  return a !== '' && a === b
}
