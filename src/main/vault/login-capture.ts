// 로그인 자격증명 자동 저장(크롬 '비밀번호 저장' 흐름)의 판정·저장 로직.
// electron 의존이 없어 테스트에서 그대로 호출할 수 있다.
//
// 흐름: preload 가 사람이 제출한 로그인 폼의 아이디·비밀번호를 vault:capture 로 메인에 보낸다
//   → VaultCaptureGate(ipc/vault-capture.ts)가 발신자·https·제외 도메인·기계 입력을 거른다
//   → 로그인 성공을 지켜본 뒤(ipc/login-watch.ts) 새 계정/바뀐 비밀번호/같은 값을 가른다(classifyCapture)
//   → 확인 바(렌더러)에는 호스트와 가린 아이디만 간다(toCapturePrompt)
//   → 사용자가 저장을 누르면 saveCapturedLogin 이 금고에 넣는다.
// 비밀번호 값은 메인 메모리(VaultService.pending, 60초)에만 머물고 로그·반환값·렌더러 어디에도 나가지 않는다.

import { maskUsername, type CapturePromptDto } from '../../shared/vault'
import { normalizeHost, registrableDomain } from '../../shared/host'

// DB 에 저장·동기화되는 로그인 항목 이름. 앱 언어와 무관하게 고정(가져오기·IPC 저장과 같은 값)
export const LOGIN_ITEM_LABEL = '로그인 비밀번호'

// 탭 프로필이 이 이름이면 따로 만든 프로필이 아니다 — 계정 라벨로 쓰지 않는다
const DEFAULT_PROFILE = 'default'

/** 판정 결과. same = 이미 같은 값이 저장돼 있어 아무것도 묻지 않는다 */
export type CaptureClass =
  | { kind: 'new' }
  | { kind: 'update'; accountId: number | undefined }
  | { kind: 'same'; accountId: number | undefined }

export interface CaptureAccountLike {
  id?: number
  username: string
  label?: string
}

/**
 * 같은 사이트(등록 도메인) 계정 목록과 제출된 아이디로 새 계정/비밀번호 변경/같은 값을 가른다.
 * 아이디는 앞뒤 공백을 빼고 대소문자까지 같아야 같은 계정이다(금고 hasSameSecret 과 같은 기준).
 * sameSecret 은 금고가 저장된 값과 비교한 결과(값 자체는 여기로 오지 않는다)
 */
export function classifyCapture(
  accounts: readonly CaptureAccountLike[],
  username: string,
  sameSecret: boolean
): CaptureClass {
  const wanted = username.trim()
  const existing = accounts.find((a) => a.username.trim() === wanted)
  // 금고가 같은 값이라고 하면(그 계정을 금고가 찾은 것이다) 목록과 무관하게 같은 값이다
  if (sameSecret) return { kind: 'same', accountId: existing?.id }
  if (!existing) return { kind: 'new' }
  return { kind: 'update', accountId: existing.id }
}

/**
 * 새 계정의 라벨. 탭 프로필(따로 만든 프로필)이 있으면 그 이름을 라벨로 써서
 * 하네스 login 도구(accountLabel·탭 프로필 일치)가 곧바로 이 계정을 고르게 한다.
 * 그 라벨을 같은 사이트의 다른 계정이 이미 쓰고 있으면 '프로필 아이디' 로 겹치지 않게 하고,
 * 프로필이 없으면 호스트를 라벨로 쓴다(예전 동작)
 */
export function accountLabelFor(
  profile: string | undefined,
  host: string,
  username: string,
  existingLabels: readonly string[]
): string {
  const name = profile?.trim()
  if (!name || name === DEFAULT_PROFILE) return host
  if (!existingLabels.includes(name)) return name
  return `${name} ${username.trim()}`.trim()
}

/** '이 사이트는 묻지 않기' 목록에 넣을 값 — 등록 도메인(없으면 정규화한 호스트) */
export function neverSaveEntry(host: string): string {
  const normalized = normalizeHost(host) || host
  return registrableDomain(normalized) || normalized
}

/** 목록에 이미 있으면 그대로, 없으면 덧붙인 새 목록 */
export function addNeverSaveHost(list: readonly string[], host: string): string[] {
  const entry = neverSaveEntry(host)
  if (!entry) return [...list]
  return list.some((h) => neverSaveEntry(h) === entry) ? [...list] : [...list, entry]
}

// 메인에 잠시 보관하는 제출 정보(비밀번호 포함) — 타입 모양만 필요하다
export interface CaptureCandidate {
  host: string
  username: string
  password: string
  isNew: boolean
  locked: boolean
  // 제출이 일어난 탭의 프로필 이름(계정 라벨용). 모르면 undefined
  profile?: string
}

/** 렌더러로 보낼 확인 바 정보 — 비밀번호는 없고 아이디는 가린다 */
export function toCapturePrompt(c: CaptureCandidate): CapturePromptDto {
  return {
    host: c.host,
    username: maskUsername(c.username),
    isNew: c.isNew,
    locked: c.locked
  }
}

// saveCapturedLogin 이 쓰는 VaultService 의 일부
export interface CaptureSaveVault {
  hasSameSecret: (host: string, username: string, password: string) => boolean
  listAccounts: (host?: string) => { id: number; username: string; label: string }[]
  listItems: (accountId: number | null) => { type: string; label: string }[]
  upsertAccount: (input: { id?: number; host: string; label?: string; username: string }) => {
    id: number
  }
  putItem: (input: {
    accountId: number
    type: 'login'
    label: string
    value: string
    jobId?: string
  }) => unknown
}

export type CaptureSaveResult = 'saved' | 'updated' | 'same'

/**
 * 확인 바에서 '저장/업데이트'를 누른 제출을 금고에 넣는다(잠금 해제 상태에서만 부른다).
 * 누른 시점에 다시 판정한다 — 그사이 다른 경로로 같은 값이 저장됐으면 아무것도 하지 않는다.
 * 기존 계정이면 사용자가 붙여 둔 계정 라벨·기본 지정·항목 이름을 덮어쓰지 않는다
 */
export function saveCapturedLogin(
  vault: CaptureSaveVault,
  capture: Pick<CaptureCandidate, 'host' | 'username' | 'password' | 'profile'>
): CaptureSaveResult {
  const host = normalizeHost(capture.host) || capture.host
  const username = capture.username.trim()
  const accounts = vault.listAccounts(host)
  const verdict = classifyCapture(
    accounts,
    username,
    vault.hasSameSecret(host, username, capture.password)
  )
  if (verdict.kind === 'same') return 'same'

  let accountId: number
  if (verdict.kind === 'update' && verdict.accountId !== undefined) {
    accountId = verdict.accountId
  } else {
    const label = accountLabelFor(
      capture.profile,
      host,
      username,
      accounts.map((a) => a.label)
    )
    accountId = vault.upsertAccount({ host, label, username }).id
  }
  const itemLabel =
    vault.listItems(accountId).find((m) => m.type === 'login')?.label ?? LOGIN_ITEM_LABEL
  vault.putItem({
    accountId,
    type: 'login',
    label: itemLabel,
    value: capture.password,
    jobId: 'login-capture'
  })
  return verdict.kind === 'update' ? 'updated' : 'saved'
}

// autoSaveCapturedLogin 이 더 쓰는 부분(되돌리기 토큰을 남기는 갱신)
export interface CaptureAutoSaveVault extends CaptureSaveVault {
  applyAutoPasswordUpdate: (input: { accountId: number; username: string; value: string }) => {
    undoToken: string
  }
}

/**
 * '묻지 않고 자동 저장'(설정, 기본 꺼짐)이 켜져 있을 때의 저장. 확인 없이 넣는 대신
 * 60초 되돌리기 토큰을 남긴다(새 계정이면 되돌리기가 로그인 항목을 지운다)
 */
export function autoSaveCapturedLogin(
  vault: CaptureAutoSaveVault,
  capture: Pick<CaptureCandidate, 'host' | 'username' | 'password' | 'profile'>
): { result: CaptureSaveResult; undoToken?: string } {
  const host = normalizeHost(capture.host) || capture.host
  const username = capture.username.trim()
  const accounts = vault.listAccounts(host)
  const verdict = classifyCapture(
    accounts,
    username,
    vault.hasSameSecret(host, username, capture.password)
  )
  if (verdict.kind === 'same') return { result: 'same' }
  const accountId =
    verdict.kind === 'update' && verdict.accountId !== undefined
      ? verdict.accountId
      : vault.upsertAccount({
          host,
          label: accountLabelFor(
            capture.profile,
            host,
            username,
            accounts.map((a) => a.label)
          ),
          username
        }).id
  const { undoToken } = vault.applyAutoPasswordUpdate({
    accountId,
    username,
    value: capture.password
  })
  return { result: verdict.kind === 'update' ? 'updated' : 'saved', undoToken }
}
