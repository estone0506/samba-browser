// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EXTENSION_MENU,
  EXTENSION_MENUS,
  filterExtensions,
  isExtensionMenu,
  matchesQuery,
  migratePinned,
  normalizeQuery,
  parsePinned,
  pinnedExtensions,
  permissionSummary,
  sortExtensions,
  sortWithPinned,
  sourceLabelKey,
  togglePinned
} from '@renderer/components/extensions/extension-list'
import type { ExtensionDto } from '@shared/extensions'
import ko from '@renderer/i18n/ko.json'
import en from '@renderer/i18n/en.json'

function ext(patch: Partial<ExtensionDto> & { id: string }): ExtensionDto {
  return {
    name: '확장',
    version: '1.0.0',
    path: 'C:/ext/' + patch.id,
    source: 'folder',
    description: '',
    permissions: [],
    enabled: true,
    ...patch
  }
}

describe('확장 검색', () => {
  const items = [
    ext({ id: 'aaa', name: '비밀번호 도우미', description: '로그인을 도와줘요' }),
    ext({ id: 'bbb', name: 'Dark Reader', description: '어두운 테마' }),
    ext({ id: 'ccc', name: '광고 차단', description: '' })
  ]

  it('앞뒤 공백과 대소문자를 무시한다', () => {
    expect(normalizeQuery('  DaRk  ')).toBe('dark')
    expect(filterExtensions(items, '  DARK ').map((e) => e.id)).toEqual(['bbb'])
  })

  it('빈 검색어면 전부 원래 순서로 돌려준다', () => {
    expect(filterExtensions(items, '').map((e) => e.id)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(filterExtensions(items, '   ').map((e) => e.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('이름·설명·id 중 하나만 걸려도 맞는 것으로 본다', () => {
    expect(filterExtensions(items, '로그인').map((e) => e.id)).toEqual(['aaa'])
    expect(filterExtensions(items, 'ccc').map((e) => e.id)).toEqual(['ccc'])
    expect(matchesQuery(items[0], '비밀번호')).toBe(true)
  })

  it('경로는 검색 대상이 아니다', () => {
    // 앱 데이터 폴더 경로는 모든 확장이 공유해서 검색이 무의미해진다
    expect(filterExtensions(items, 'C:/ext')).toEqual([])
  })

  it('맞는 것이 없으면 빈 목록이다', () => {
    expect(filterExtensions(items, '없는확장')).toEqual([])
  })
})

describe('확장 정렬', () => {
  it('이름순으로 늘어놓고 원본은 건드리지 않는다', () => {
    const items = [ext({ id: 'c', name: '다' }), ext({ id: 'a', name: '가' })]
    expect(sortExtensions(items).map((e) => e.id)).toEqual(['a', 'c'])
    expect(items.map((e) => e.id)).toEqual(['c', 'a'])
  })

  it('이름이 같으면 id 로 갈라 매번 같은 순서가 나온다', () => {
    const items = [ext({ id: 'z', name: '같음' }), ext({ id: 'a', name: '같음' })]
    expect(sortExtensions(items).map((e) => e.id)).toEqual(['a', 'z'])
  })

  it('고정한 확장을 위로 올리고 무리 안 순서는 지킨다', () => {
    const items = [ext({ id: 'a' }), ext({ id: 'b' }), ext({ id: 'c' })]
    expect(sortWithPinned(items, ['c']).map((e) => e.id)).toEqual(['c', 'a', 'b'])
    expect(sortWithPinned(items, []).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('주소창 메뉴 고정', () => {
  it('없으면 넣고 있으면 뺀다', () => {
    expect(togglePinned([], 'a')).toEqual(['a'])
    expect(togglePinned(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('저장된 값이 깨져 있으면 빈 목록으로 본다', () => {
    expect(parsePinned(null)).toEqual([])
    expect(parsePinned('{{깨진 JSON')).toEqual([])
    expect(parsePinned('{"a":1}')).toEqual([])
    expect(parsePinned('["a", 7, null, "b"]')).toEqual(['a', 'b'])
  })
})

describe('고정 목록 이전(localStorage → 설정)', () => {
  it('설정이 비어 있고 예전 값이 있으면 그 값을 옮긴다', () => {
    expect(migratePinned([], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('옮기면서 중복은 하나로 줄인다', () => {
    expect(migratePinned([], ['a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('설정에 이미 값이 있으면 예전 값은 무시한다', () => {
    expect(migratePinned(['x'], ['a', 'b'])).toBeNull()
  })

  it('예전 값이 없으면 아무것도 하지 않는다', () => {
    expect(migratePinned([], [])).toBeNull()
    expect(migratePinned([], [''])).toBeNull()
  })

  it('사용자가 새 버전에서 고정을 모두 풀어도 예전 값이 되살아나지 않는다', () => {
    // 설정이 빈 목록이면 한 번은 옮겨지지만, 옮긴 뒤 예전 키를 지우므로(호출부)
    // 그다음부터는 예전 값이 빈 목록으로 들어와 null 이 된다
    expect(migratePinned([], [])).toBeNull()
  })
})

describe('툴바에 그릴 고정 확장', () => {
  const items = [ext({ id: 'a' }), ext({ id: 'b' }), ext({ id: 'c', enabled: false })]

  it('고정한 순서대로 늘어놓는다(목록 순서가 아니다)', () => {
    expect(pinnedExtensions(items, ['b', 'a']).map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('꺼 둔 확장은 고정돼 있어도 그리지 않는다', () => {
    expect(pinnedExtensions(items, ['c']).map((e) => e.id)).toEqual([])
  })

  it('지워져서 목록에 없는 id 는 조용히 건너뛴다', () => {
    expect(pinnedExtensions(items, ['없음', 'a']).map((e) => e.id)).toEqual(['a'])
  })

  it('고정이 없으면 빈 목록이다(툴바가 통째로 사라진다)', () => {
    expect(pinnedExtensions(items, [])).toEqual([])
  })
})

describe('권한 요약', () => {
  it('중복을 없애고 순서를 지킨다', () => {
    expect(permissionSummary(['tabs', 'storage', 'tabs'])).toEqual(['tabs', 'storage'])
  })

  it('빈 문자열과 공백만 있는 값은 버린다', () => {
    expect(permissionSummary(['', '  ', ' tabs '])).toEqual(['tabs'])
  })
})

describe('소메뉴', () => {
  it('기본 소메뉴는 목록에 있다', () => {
    expect(isExtensionMenu(DEFAULT_EXTENSION_MENU)).toBe(true)
  })

  it('알 수 없는 값은 소메뉴가 아니다', () => {
    expect(isExtensionMenu('없는메뉴')).toBe(false)
    expect(isExtensionMenu(3)).toBe(false)
  })
})

// 중첩 객체를 'a.b.c' 형태의 평탄한 키 목록으로 편다
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out
}

describe('확장 화면 i18n', () => {
  const koKeys = flatten(ko as Record<string, unknown>)
  const enKeys = flatten(en as Record<string, unknown>)

  it('출처 배지 키가 두 파일에 모두 있다', () => {
    for (const source of ['store', 'imported', 'folder'] as const) {
      expect(koKeys).toContain(sourceLabelKey(source))
      expect(enKeys).toContain(sourceLabelKey(source))
    }
  })

  it('소메뉴·화면 문구 키가 두 파일에 모두 있다', () => {
    for (const key of [
      ...EXTENSION_MENUS.map((m) => `extensions.menu${m === 'mine' ? 'Mine' : 'Shortcuts'}`),
      'extensions.pageTitle',
      'extensions.searchPlaceholder',
      'extensions.devMode',
      'extensions.searchEmpty',
      'extensions.manage',
      'extensions.installedTitle',
      'extensions.detailsPermissions',
      'extensions.actionTitle'
    ]) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })

  it('설정 페이지에는 더 이상 확장 문구가 없다', () => {
    expect(koKeys.filter((k) => k.startsWith('settingsPage.extensions.'))).toEqual([])
    expect(enKeys.filter((k) => k.startsWith('settingsPage.extensions.'))).toEqual([])
  })
})
