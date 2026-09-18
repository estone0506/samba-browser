// 페이지 내 자동 채움 피커 — 로그인 폼의 아이디 칸 오른쪽에 열쇠 아이콘을 띄우고,
// 클릭하면 이 호스트에 저장된 계정 드롭다운을 보여 준다.
//
// 보안 규칙
// - 격리 월드에서만 동작하고, UI 는 Shadow DOM 안에 그린다(페이지 CSS·스크립트가 건드릴 수 없다)
// - 드롭다운에 오는 정보는 {id,label,username} 뿐이다 — 비밀번호는 이 월드에 존재하지 않는다
// - 선택하면 accountId 만 메인에 보내고, 실제 값은 메인이 격리 월드 인자로 직접 채운다

// 아이콘 크기/여백(px)
const ICON_SIZE = 20
const ICON_GAP = 6

export type PickerOutcome = string

export interface PickerAccount {
  id: number
  label: string
  username: string
}

export interface PickerAccountsResponse {
  outcome: PickerOutcome
  accounts: PickerAccount[]
}

export interface AutofillPickerDeps {
  // 메인에 계정 목록을 요청한다(vault:pickerAccounts)
  listAccounts: (host: string) => Promise<PickerAccountsResponse>
  // 선택한 계정으로 채우기를 요청한다(vault:pickerFill)
  fill: (accountId: number) => void
  // 잠금 등 상태 문구(호출부에서 번역된 문자열을 넘긴다)
  labels: { locked: string; empty: string; title: string }
}

const USERNAME_HINT = /id|user|email|login|phone|아이디|이메일/i

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const cs = getComputedStyle(el)
  return cs.display !== 'none' && cs.visibility !== 'hidden'
}

/** 이 입력칸이 피커를 띄울 아이디 칸인지 판정한다 */
export function isPickerTarget(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false
  if (!isVisible(el)) return false
  const type = el.type
  if (type === 'password') return true
  if (type !== 'text' && type !== 'email' && type !== 'tel') return false
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase()
  if (auto === 'username' || auto === 'email') return true
  const hay = `${el.name} ${el.id} ${el.getAttribute('placeholder') || ''}`
  if (USERNAME_HINT.test(hay)) return true
  // 같은 폼에 비밀번호 칸이 있으면 로그인 폼으로 본다
  const form = el.form
  return form ? form.querySelector('input[type="password"]') !== null : false
}

/** 아이디 칸 오른쪽 안쪽에 아이콘을 놓을 문서 좌표를 계산한다(스크롤 포함) */
export function iconPosition(rect: { top: number; left: number; width: number; height: number }): {
  top: number
  left: number
} {
  return {
    top: rect.top + (rect.height - ICON_SIZE) / 2,
    left: rect.left + rect.width - ICON_SIZE - ICON_GAP
  }
}

const STYLE = `
  :host { all: initial; }
  .key {
    position: absolute; width: ${ICON_SIZE}px; height: ${ICON_SIZE}px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 6px; background: #111; color: #fff; cursor: pointer;
    font: 600 11px/1 system-ui, sans-serif; z-index: 2147483646;
  }
  .menu {
    position: absolute; min-width: 220px; max-width: 320px; max-height: 260px; overflow: auto;
    background: #fff; color: #111; border: 1px solid rgba(0,0,0,.12); border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.18); padding: 4px; z-index: 2147483647;
    font: 13px/1.4 system-ui, sans-serif;
  }
  .menu .title { padding: 6px 8px; font-size: 11px; color: #666; }
  .menu button {
    display: block; width: 100%; text-align: left; padding: 7px 8px; border: 0;
    border-radius: 7px; background: transparent; cursor: pointer; font: inherit; color: inherit;
  }
  .menu button:hover { background: rgba(0,0,0,.06); }
  .menu .sub { display: block; font-size: 11.5px; color: #666; }
  .menu .note { padding: 8px; font-size: 12px; color: #666; }
`

/**
 * 피커를 설치한다. 로그인 입력칸에 포커스가 가면 아이콘을 띄운다.
 * 한 번만 호출한다(page.ts).
 */
export function installAutofillPicker(deps: AutofillPickerDeps): void {
  let host: HTMLDivElement | null = null
  let root: ShadowRoot | null = null
  let icon: HTMLDivElement | null = null
  let menu: HTMLDivElement | null = null
  let target: HTMLInputElement | null = null

  const ensureRoot = (): ShadowRoot => {
    if (root) return root
    host = document.createElement('div')
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;'
    root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLE
    root.appendChild(style)
    document.documentElement.appendChild(host)
    return root
  }

  const closeMenu = (): void => {
    menu?.remove()
    menu = null
  }

  const hideIcon = (): void => {
    closeMenu()
    icon?.remove()
    icon = null
    target = null
  }

  const placeIcon = (): void => {
    if (!icon || !target) return
    const rect = target.getBoundingClientRect()
    const pos = iconPosition({
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height
    })
    icon.style.top = `${pos.top}px`
    icon.style.left = `${pos.left}px`
    if (menu) {
      menu.style.top = `${pos.top + ICON_SIZE + 4}px`
      menu.style.left = `${pos.left - 200}px`
    }
  }

  const renderMenu = async (): Promise<void> => {
    if (menu) {
      closeMenu()
      return
    }
    const shadow = ensureRoot()
    menu = document.createElement('div')
    menu.className = 'menu'
    menu.innerHTML = `<div class="note">…</div>`
    shadow.appendChild(menu)
    placeIcon()

    let response: PickerAccountsResponse
    try {
      response = await deps.listAccounts(location.host)
    } catch {
      response = { outcome: 'error', accounts: [] }
    }
    if (!menu) return
    menu.textContent = ''
    if (response.outcome === 'locked') {
      const note = document.createElement('div')
      note.className = 'note'
      note.textContent = deps.labels.locked
      menu.appendChild(note)
      return
    }
    if (response.accounts.length === 0) {
      const note = document.createElement('div')
      note.className = 'note'
      note.textContent = deps.labels.empty
      menu.appendChild(note)
      return
    }
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = deps.labels.title
    menu.appendChild(title)
    for (const acc of response.accounts) {
      const button = document.createElement('button')
      button.type = 'button'
      const label = document.createElement('b')
      label.textContent = acc.label
      const sub = document.createElement('span')
      sub.className = 'sub'
      // 사용자 본인 화면이므로 아이디는 가리지 않는다(비밀번호는 여기 없다)
      sub.textContent = acc.username
      button.append(label, sub)
      button.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        deps.fill(acc.id)
        hideIcon()
      })
      menu.appendChild(button)
    }
  }

  const showIcon = (el: HTMLInputElement): void => {
    const shadow = ensureRoot()
    if (target === el && icon) {
      placeIcon()
      return
    }
    hideIcon()
    target = el
    icon = document.createElement('div')
    icon.className = 'key'
    icon.textContent = '🔑'
    icon.title = deps.labels.title
    icon.addEventListener('mousedown', (e) => {
      // 입력칸 포커스를 뺏지 않도록 기본 동작을 막는다
      e.preventDefault()
      e.stopPropagation()
    })
    icon.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void renderMenu()
    })
    shadow.appendChild(icon)
    placeIcon()
  }

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target
      if (el instanceof Element && isPickerTarget(el)) showIcon(el)
    },
    true
  )
  // 다른 곳을 누르면 메뉴만 닫는다(아이콘은 포커스가 남아 있으면 유지)
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.target === host) return
      closeMenu()
    },
    true
  )
  window.addEventListener('scroll', placeIcon, true)
  window.addEventListener('resize', placeIcon)
}
