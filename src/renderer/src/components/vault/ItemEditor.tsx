import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore } from '@renderer/stores/vaultStore'
import type { AccountDto, VaultItemMeta, VaultItemType } from '@shared/ipc'

const ITEM_TYPES: VaultItemType[] = [
  'login_password',
  'payment_password',
  'card',
  'passport',
  'id_card',
  'birth_date',
  'address',
  'phone',
  'custom'
]

// 전역(계정 없는) 항목에는 로그인/결제 비밀번호처럼 계정에 종속된 타입은 쓸 수 없다
const GLOBAL_ITEM_TYPES: VaultItemType[] = [
  'card',
  'passport',
  'id_card',
  'birth_date',
  'address',
  'phone',
  'custom'
]

const SECRET_TYPES = new Set<VaultItemType>(['login_password', 'payment_password'])

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 'account'(기본값): 계정(라벨·아이디·호스트) + 항목. 'global': 계정 없이 항목만
  mode?: 'account' | 'global'
  account?: AccountDto
  // global 모드에서 편집 중인 기존 항목. 없으면 신규 생성
  item?: VaultItemMeta
}

// 계정(라벨·아이디·호스트) + 항목(타입별 값) 을 한 화면에서 저장한다.
// 값을 비워두면 항목은 건드리지 않고 계정 정보만 갱신한다
export function ItemEditor({
  open,
  onOpenChange,
  mode = 'account',
  account,
  item
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const upsertAccount = useVaultStore((s) => s.upsertAccount)
  const putItem = useVaultStore((s) => s.putItem)
  const select = useVaultStore((s) => s.select)
  const selectGlobalItem = useVaultStore((s) => s.selectGlobalItem)
  const error = useVaultStore((s) => s.error)

  // 부모가 다이얼로그를 열 때마다 key 를 바꿔 이 컴포넌트를 완전히 새로 마운트한다.
  // 그래서 여기선 effect 로 상태를 되돌릴 필요 없이 초기값만 props 에서 읽으면 된다
  const [label, setLabel] = useState(
    mode === 'global' ? (item?.label ?? '') : (account?.label ?? '')
  )
  const [username, setUsername] = useState(account?.username ?? '')
  const [host, setHost] = useState(account?.host ?? '')
  const [itemType, setItemType] = useState<VaultItemType>(item?.type ?? 'card')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const submitAccount = async (): Promise<void> => {
    if (!host.trim() || !label.trim()) return
    setSaving(true)
    const savedAccount = await upsertAccount({
      id: account?.id,
      host: host.trim(),
      label: label.trim(),
      username: username.trim(),
      isDefault: account?.isDefault
    })
    if (savedAccount && value.trim()) {
      await putItem({
        accountId: savedAccount.id,
        type: itemType,
        label: t(`vault.itemType.${itemType}`),
        value: value.trim()
      })
    }
    setSaving(false)
    if (savedAccount) {
      select(savedAccount.id)
      onOpenChange(false)
    }
  }

  const submitGlobal = async (): Promise<void> => {
    if (!label.trim()) return
    // 신규 항목은 값이 있어야 만들 수 있다. 편집 중 값을 비워두면 값은 그대로 두고
    // (현재는 라벨/타입만 바꿀 방법이 없으므로) 아무 것도 하지 않는다
    if (!value.trim()) return
    setSaving(true)
    const ok = await putItem({
      accountId: null,
      type: itemType,
      label: label.trim(),
      value: value.trim()
    })
    setSaving(false)
    if (ok) {
      const saved = useVaultStore.getState().itemsByAccount.global?.find((i) => i.type === itemType)
      if (saved) selectGlobalItem(saved.id)
      onOpenChange(false)
    }
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    void (mode === 'global' ? submitGlobal() : submitAccount())
  }

  const titleKey =
    mode === 'global'
      ? item
        ? 'vault.editor.editGlobalTitle'
        : 'vault.editor.addGlobalTitle'
      : account
        ? 'vault.editor.editTitle'
        : 'vault.editor.addTitle'

  const types = mode === 'global' ? GLOBAL_ITEM_TYPES : ITEM_TYPES

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label={mode === 'global' ? t('vault.editor.itemLabel') : t('vault.editor.label')}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
          {mode === 'account' && (
            <>
              <Field label={t('vault.editor.username')}>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label={t('vault.editor.host')}>
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="example.com"
                  required
                />
              </Field>
            </>
          )}
          <Field label={t('vault.editor.itemType')}>
            <select
              value={itemType}
              onChange={(e) => setItemType(e.target.value as VaultItemType)}
              className="h-9 w-full rounded-md border border-[var(--line)] bg-transparent px-3 text-[13px] outline-none"
            >
              {types.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`vault.itemType.${ty}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('vault.editor.value')}>
            <Input
              type={SECRET_TYPES.has(itemType) ? 'password' : 'text'}
              autoComplete="off"
              data-lpignore="true"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('vault.editor.valuePlaceholder')}
            />
          </Field>
          {error && <p className="text-[12px] text-[#b91c1c]">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-[9px]"
              onClick={() => onOpenChange(false)}
            >
              {t('vault.editor.cancel')}
            </Button>
            <Button type="submit" disabled={saving} className="rounded-[9px]">
              {t('vault.editor.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--text2)]">{label}</span>
      {children}
    </label>
  )
}
