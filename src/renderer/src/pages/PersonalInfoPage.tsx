import { useEffect, useState } from 'react'
import type React from 'react'
import { SetupScreen } from '@renderer/components/vault/SetupScreen'
import { UnlockScreen } from '@renderer/components/vault/UnlockScreen'
import { ItemList } from '@renderer/components/vault/ItemList'
import { ItemDetail } from '@renderer/components/vault/ItemDetail'
import { ItemEditor } from '@renderer/components/vault/ItemEditor'
import { ImportPanel } from '@renderer/components/vault/ImportPanel'
import { useVaultStore } from '@renderer/stores/vaultStore'

// 개인정보(Vault) 페이지. 잠금 상태에 따라 설정 → 잠금 해제 → 2단 목록/상세 화면으로 전환된다
export function PersonalInfoPage(): React.JSX.Element {
  const state = useVaultStore((s) => s.state)
  const refreshState = useVaultStore((s) => s.refreshState)
  const loadItems = useVaultStore((s) => s.loadItems)
  const accounts = useVaultStore((s) => s.accounts)
  const selectedAccountId = useVaultStore((s) => s.selectedAccountId)
  const [editorOpen, setEditorOpen] = useState(false)
  // 열 때마다 바뀌어 ItemEditor 를 새로 마운트시킨다(폼 상태를 effect 없이 초기화하기 위함)
  const [editorKey, setEditorKey] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const openEditor = (): void => {
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
      <ItemList onAdd={openEditor} onImport={() => setImportOpen(true)} />
      <ItemDetail onEdit={openEditor} />
      <ItemEditor
        key={editorKey}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        account={typeof selectedAccountId === 'number' ? editingAccount : undefined}
      />
      <ImportPanel open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}
