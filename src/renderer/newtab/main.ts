// 자체 새 탭 페이지(samba://newtab).
// 렌더러(React UI)와 별개의 정적 페이지라 프레임워크 없이 DOM 으로만 그린다.
// 메인 프로세스와의 통신은 preload 가 노출한 window.sambaNewTab 하나뿐이다.

import './newtab.css'
import ko from '../src/i18n/ko.json'
import en from '../src/i18n/en.json'
import type { NewTabBookmarkDto, NewTabInitDto, SambaNewTabApi } from '@shared/newtab'

declare global {
  interface Window {
    sambaNewTab?: SambaNewTabApi
  }
}

interface NewTabMessages {
  title: string
  placeholder: string
  bookmarks: string
}

const MESSAGES: Record<NewTabInitDto['language'], NewTabMessages> = {
  ko: ko.newtab,
  en: en.newtab
}

// 구글 파비콘 서비스(gstatic 직접 호출). www.google.com/s2 는 301 리다이렉트라 CSP 에 막힌다
function faviconUrl(host: string): string {
  const url = encodeURIComponent(`https://${host}`)
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${url}&size=32`
}

// 파비콘. 먼저 첫 글자 폴백(검정 원)을 그리고 이미지가 로드되면 그 위를 덮는다
function iconOf(item: NewTabBookmarkDto): HTMLElement {
  const box = document.createElement('span')
  box.className = 'icon'
  box.textContent = (item.host || item.title || '?').slice(0, 1).toUpperCase()
  if (!item.host) return box
  const img = document.createElement('img')
  img.alt = ''
  img.hidden = true
  img.addEventListener('load', () => {
    img.hidden = false
  })
  img.src = faviconUrl(item.host)
  box.appendChild(img)
  return box
}

function renderBookmarks(
  root: HTMLElement,
  items: NewTabBookmarkDto[],
  api: SambaNewTabApi | undefined
): void {
  root.replaceChildren()
  root.hidden = items.length === 0
  for (const item of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'link'
    button.title = item.url
    const name = document.createElement('span')
    name.className = 'link-name'
    name.textContent = item.title
    button.append(iconOf(item), name)
    button.addEventListener('click', () => api?.open(item.url))
    root.appendChild(button)
  }
}

function start(): void {
  const form = document.getElementById('search-form')
  const input = document.getElementById('search-input')
  const links = document.getElementById('links')
  if (
    !(form instanceof HTMLFormElement) ||
    !(input instanceof HTMLInputElement) ||
    !(links instanceof HTMLElement)
  ) {
    return
  }

  const api = window.sambaNewTab
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const value = input.value.trim()
    if (!value) return
    api?.search(value)
  })
  input.focus()
  // 설정 언어가 오기 전까지는 기본 문구(한국어)를 먼저 보여 준다
  input.placeholder = MESSAGES.ko.placeholder

  // 언어·북마크는 메인에서 받아온다. 실패해도 검색창은 그대로 쓸 수 있어야 한다
  void api
    ?.init()
    .then((data) => {
      const messages = MESSAGES[data.language] ?? MESSAGES.ko
      document.title = messages.title
      input.placeholder = messages.placeholder
      links.setAttribute('aria-label', messages.bookmarks)
      renderBookmarks(links, data.bookmarks, api)
    })
    .catch((e: unknown) => {
      console.error('새 탭 초기화 실패', e)
    })
}

start()
