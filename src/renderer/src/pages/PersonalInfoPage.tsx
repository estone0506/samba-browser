import { useEffect, useState } from 'react'
import type React from 'react'
import { SetupScreen } from '@renderer/components/vault/SetupScreen'
import { UnlockScreen } from '@renderer/components/vault/UnlockScreen'
import { ItemList } from '@renderer/components/vault/ItemList'
import { ItemDetail } from '@renderer/components/vault/ItemDetail'
import { ItemEditor } from '@renderer/components/vault/ItemEditor'
import { ImportPanel } from '@renderer/components/vault/ImportPanel'
import { useVaultStore } from '@renderer/stores/vaultStore'
import type { VaultItemMeta } from '@shared/ipc'

// 개인정보(Vault) 페이지. 잠금 상태에 따라 설정 → 잠금 해제 → 2단 목록/상세 화면으로 전환된다
export function PersonalInfoPage(): React.JSX.Element {
  const state = useVaultStore((s) => s.state)
  const refreshState = useVaultStore((s) => s.refreshState)
  const loadItems = useVaultStore((s) => s.loadItems)
  const accounts = useVaultStore((s) => s.accounts)
  const selectedAccountId = useVaultStore((s) => s.selectedAccountId)
  const [editorOpen, setEditorOpen] = useState(false)
  // 'account': 계정 편집/추가. 'global': 계정 없는 전역 항목 편집/추가
  const [editorMode, setEditorMode] = useState<'account' | 'global'>('account')
  const [editingGlobalItem, setEditingGlobalItem] = useState<VaultItemMeta | undefined>(undefined)
  // 열 때마다 바뀌어 ItemEditor 를 새로 마운트시킨다(폼 상태를 effect 없이 초기화하기 위함)
  const [editorKey, setEditorKey] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const openEditor = (): void => {
    setEditorMode('account')
    setEditingGlobalItem(undefined)
    setEditorKey((k) => k + 1)
    setEditorOpen(true)
  }
  const openGlobalEditor = (item?: VaultItemMeta): void => {
    setEditorMode('global')
    setEditingGlobalItem(item)
    setEditorKey((k) => k + 1)
    setEditorOpen(true)
  }

  useEffect(() => {
    void refreshState()
    return window.samba.vault.onStateChanged(() => void refreshState())
  }, [refreshState])

  // 잠금 해제 상태가 되면 전역 항목(계정 없는 항목) 목록을 함께 불러온다
  useEffect(() => {
    if (state === 'unlocked') void loadItems(null)
  }, [state, loadItems])

  if (state === 'uninitialized') return <SetupScreen />
  if (state === 'locked') return <UnlockScreen />

  const editingAccount = accounts.find((a) => a.id === selectedAccountId)

  return (
    <div className="flex min-h-0 flex-1">
      <ItemList
        onAdd={openEditor}
        onAddGlobal={() => openGlobalEditor()}
        onImport={() => setImportOpen(true)}
      />
      <ItemDetail onEdit={openEditor} onEditGlobal={openGlobalEditor} />
      <ItemEditor
        key={editorKey}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        mode={editorMode}
        account={typeof selectedAccountId === 'number' ? editingAccount : undefined}
        item={editorMode === 'global' ? editingGlobalItem : undefined}
      />
      <ImportPanel open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}
