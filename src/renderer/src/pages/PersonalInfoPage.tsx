import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { SetupScreen } from '@renderer/components/vault/SetupScreen'
import { UnlockScreen } from '@renderer/components/vault/UnlockScreen'
import { useAuthStore } from '@renderer/stores/authStore'
import { ItemList } from '@renderer/components/vault/ItemList'
import { ItemDetail } from '@renderer/components/vault/ItemDetail'
import { ItemEditor } from '@renderer/components/vault/ItemEditor'
import { ImportPanel } from '@renderer/components/vault/ImportPanel'
import { VaultSettingsPanel } from '@renderer/components/vault/VaultSettingsPanel'
import { useVaultStore } from '@renderer/stores/vaultStore'
import type { VaultItemMeta, VaultItemType } from '@shared/ipc'

// 개인정보(Vault) 페이지. 잠금 상태에 따라 설정 → 잠금 해제 → 2단 목록/상세 화면으로 전환된다
export function PersonalInfoPage(): React.JSX.Element {
  const state = useVaultStore((s) => s.state)
  const refreshState = useVaultStore((s) => s.refreshState)
  const loadItems = useVaultStore((s) => s.loadItems)
  const accounts = useVaultStore((s) => s.accounts)
  const selectedAccountId = useVaultStore((s) => s.selectedAccountId)
  const [editorOpen, setEditorOpen] = useState(false)
  // 새로 만들 항목 종류(+ 메뉴에서 고른 값). 편집 중이면 기존 항목 종류를 따른다
  const [editorType, setEditorType] = useState<VaultItemType>('login')
  const [editingItem, setEditingItem] = useState<VaultItemMeta | undefined>(undefined)
  // 열 때마다 바뀌어 ItemEditor 를 새로 마운트시킨다(폼 상태를 effect 없이 초기화하기 위함)
  const [editorKey, setEditorKey] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // + 메뉴에서 종류를 고르거나(신규), 계정 '편집' 을 누를 때(기존 계정) 열린다
  const openEditor = (type: VaultItemType, item?: VaultItemMeta): void => {
    setEditorType(type)
    setEditingItem(item)
    setEditorKey((k) => k + 1)
    setEditorOpen(true)
  }

  useEffect(() => {
    void refreshState()
    return window.samba.vault.onStateChanged(() => void refreshState())
  }, [refreshState])

  const accountConfigured = useAuthStore((st) => st.state?.account?.configured === true)
  // 잠금 해제 상태가 되면 전역 항목(계정 없는 항목) 목록을 함께 불러온다
  useEffect(() => {
    if (state === 'unlocked') void loadItems(null)
  }, [state, loadItems])

  // 계정 로그인 빌드에서는 로그인이 곧 키마스터 설정이다 — 로그인 직후 잠깐 'uninitialized' 가 보일 수 있다
  if (state === 'uninitialized') return accountConfigured ? <PreparingNote /> : <SetupScreen />
  if (state === 'locked') return <UnlockScreen />

  const editingAccount = accounts.find((a) => a.id === selectedAccountId)

  return (
    <div className="flex min-h-0 flex-1">
      <ItemList
        onAdd={(type) => openEditor(type)}
        onImport={() => setImportOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      <ItemDetail
        onEdit={() => openEditor('login')}
        onEditGlobal={(item) => openEditor(item.type, item)}
        onAddPayment={() => openEditor('password')}
        onEditItem={(item) => openEditor(item.type, item)}
      />
      <ItemEditor
        key={editorKey}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        type={editorType}
        account={typeof selectedAccountId === 'number' ? editingAccount : undefined}
        item={editingItem}
      />
      <ImportPanel open={importOpen} onOpenChange={setImportOpen} />
      <VaultSettingsPanel open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UndoToast />
    </div>
  )
}

// 삭제 후 8초 동안 떠 있는 되돌리기 토스트. 값(암호문)은 메인 메모리에만 남아 있고
// 여기서는 토큰으로만 복원을 요청한다
const UNDO_TOAST_MS = 8000

function UndoToast(): React.JSX.Element | null {
  const { t } = useTranslation()
  const pendingUndo = useVaultStore((s) => s.pendingUndo)
  const undoDelete = useVaultStore((s) => s.undoDelete)
  const clearPendingUndo = useVaultStore((s) => s.clearPendingUndo)

  useEffect(() => {
    if (!pendingUndo) return
    const timer = setTimeout(clearPendingUndo, UNDO_TOAST_MS)
    return () => clearTimeout(timer)
  }, [pendingUndo, clearPendingUndo])

  if (!pendingUndo) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-[12px] bg-[var(--text)] px-3.5 py-2 text-[12.5px] text-white shadow-[0_8px_24px_rgba(0,0,0,.2)]">
        <span>
          {t('vault.list.deleted')} · {pendingUndo.count}
        </span>
        <button
          type="button"
          onClick={() => void undoDelete()}
          className="rounded-[8px] bg-white/15 px-2 py-0.5 font-medium"
        >
          {t('vault.list.undo')}
        </button>
      </div>
    </div>
  )
}

// 로그인 직후 키마스터가 계정 비밀번호로 준비되는 짧은 순간
function PreparingNote(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-[var(--text2)]">
      {t('vault.preparing')}
    </div>
  )
}
