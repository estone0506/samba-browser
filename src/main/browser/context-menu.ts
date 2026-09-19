// 탭 안 웹페이지의 우클릭 메뉴(최소 구현).
//
// 지금 담는 항목: 복사 · 링크 주소 복사 · 이미지 번역 · 이 페이지 번역 · 원문 보기.
// 문구는 앱 언어(ko/en)를 따른다 — 페이지 언어가 아니다.

import { Menu, clipboard, type MenuItemConstructorOptions, type WebContents } from 'electron'

export type MenuLanguage = 'ko' | 'en'

export const CONTEXT_MENU_LABELS = {
  ko: {
    copy: '복사',
    copyLink: '링크 주소 복사',
    translateImage: '이미지 번역',
    translatePage: '이 페이지 번역',
    restorePage: '원문 보기'
  },
  en: {
    copy: 'Copy',
    copyLink: 'Copy link address',
    translateImage: 'Translate image',
    translatePage: 'Translate this page',
    restorePage: 'Show original'
  }
} as const

export type ContextMenuLabels = (typeof CONTEXT_MENU_LABELS)[MenuLanguage]

/** 우클릭 지점 정보 중 메뉴 구성에 쓰는 부분만 좁힌 모양 */
export interface ContextTarget {
  mediaType: string
  srcURL: string
  linkURL: string
  selectionText: string
}

export interface ContextMenuActions {
  copy: () => void
  copyLink: (url: string) => void
  translateImage: (srcUrl: string) => void
  translatePage: () => void
  restorePage: () => void
}

/** 우클릭 지점에 맞는 메뉴 항목을 만든다(순수 함수 — 테스트에서 그대로 검사한다) */
export function buildContextTemplate(
  target: ContextTarget,
  labels: ContextMenuLabels,
  actions: ContextMenuActions
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (target.selectionText.trim()) {
    items.push({ id: 'copy', label: labels.copy, click: () => actions.copy() })
  }
  if (target.linkURL) {
    items.push({
      id: 'copyLink',
      label: labels.copyLink,
      click: () => actions.copyLink(target.linkURL)
    })
  }
  if (target.mediaType === 'image' && target.srcURL) {
    items.push({
      id: 'translateImage',
      label: labels.translateImage,
      click: () => actions.translateImage(target.srcURL)
    })
  }
  if (items.length > 0) items.push({ type: 'separator' })
  items.push({
    id: 'translatePage',
    label: labels.translatePage,
    click: () => actions.translatePage()
  })
  items.push({ id: 'restorePage', label: labels.restorePage, click: () => actions.restorePage() })
  return items
}

export interface ContextMenuDeps {
  language: () => MenuLanguage
  translateImage: (wc: WebContents, srcUrl: string) => void
  translatePage: (wc: WebContents) => void
  restorePage: (wc: WebContents) => void
}

/** 탭 webContents 에 우클릭 메뉴를 붙인다(탭 생성 시 1회) */
export function installContextMenu(wc: WebContents, deps: ContextMenuDeps): void {
  wc.on('context-menu', (_event, params) => {
    const labels = CONTEXT_MENU_LABELS[deps.language()]
    const template = buildContextTemplate(
      {
        mediaType: params.mediaType,
        srcURL: params.srcURL,
        linkURL: params.linkURL,
        selectionText: params.selectionText
      },
      labels,
      {
        copy: () => wc.copy(),
        copyLink: (url) => clipboard.writeText(url),
        translateImage: (srcUrl) => deps.translateImage(wc, srcUrl),
        translatePage: () => deps.translatePage(wc),
        restorePage: () => deps.restorePage(wc)
      }
    )
    Menu.buildFromTemplate(template).popup()
  })
}
