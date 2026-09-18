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
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore, type PutSectionInput } from '@renderer/stores/vaultStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { normalizeHost } from '@shared/host'
import { PasswordGenerator } from './PasswordGenerator'
import type { AccountDto, FieldKind, VaultItemMeta, VaultItemType } from '@shared/ipc'

// 항목 종류별 폼 정의(섹션 > 필드). 값은 여기 담지 않고 state 에만 둔다
interface FieldSpec {
  key: string
  labelKey: string
  kind: FieldKind
}

interface SectionSpec {
  key: string
  labelKey: string
  fields: FieldSpec[]
}

// 계정에 종속되는 종류(계정 라벨·아이디·호스트를 함께 입력받는다)
const ACCOUNT_TYPES = new Set<VaultItemType>(['login'])

const FORM_SPECS: Record<VaultItemType, SectionSpec[]> = {
  login: [
    {
      key: 'main',
      labelKey: 'vault.sections.login',
      fields: [{ key: 'value', labelKey: 'vault.fieldNames.password', kind: 'secret' }]
    }
  ],
  password: [
    {
      key: 'main',
      labelKey: 'vault.sections.payment',
      fields: [{ key: 'value', labelKey: 'vault.fieldNames.password', kind: 'secret' }]
    }
  ],
  card: [
    {
      key: 'card',
      labelKey: 'vault.sections.card',
      fields: [
        { key: 'card.holder', labelKey: 'vault.fieldNames.holder', kind: 'text' },
        { key: 'card.brand', labelKey: 'vault.fieldNames.brand', kind: 'text' },
        { key: 'card.number', labelKey: 'vault.fieldNames.number', kind: 'secret' },
        { key: 'card.expiry', labelKey: 'vault.fieldNames.expiry', kind: 'text' },
        { key: 'card.cvc', labelKey: 'vault.fieldNames.cvc', kind: 'secret' }
      ]
    },
    {
      key: 'payment',
      labelKey: 'vault.sections.payment',
      fields: [{ key: 'card.password', labelKey: 'vault.fieldNames.cardPassword', kind: 'secret' }]
    }
  ],
  note: [
    {
      key: 'main',
      labelKey: 'vault.sections.note',
      fields: [{ key: 'value', labelKey: 'vault.fieldNames.note', kind: 'secret' }]
    }
  ],
  identity: [
    {
      key: 'identity',
      labelKey: 'vault.sections.identity',
      fields: [
        { key: 'identity.name', labelKey: 'vault.fieldNames.name', kind: 'text' },
        { key: 'identity.birth', labelKey: 'vault.fieldNames.birth', kind: 'date' },
        { key: 'identity.address', labelKey: 'vault.fieldNames.address', kind: 'text' },
        { key: 'identity.phone', labelKey: 'vault.fieldNames.phone', kind: 'text' },
        { key: 'identity.passport', labelKey: 'vault.fieldNames.passport', kind: 'secret' },
        { key: 'identity.idCard', labelKey: 'vault.fieldNames.idCard', kind: 'secret' }
      ]
    }
  ],
  // 문서 첨부는 2단계 범위 밖이라 폼이 없다(메뉴에서도 비활성)
  document: []
}

const CUSTOM_SECTION_KEY = 'custom'
const FIELD_KINDS: FieldKind[] = ['text', 'secret', 'url', 'date']

interface CustomField {
  key: string
  label: string
  kind: FieldKind
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 새로 만들 항목 종류(편집 중이면 기존 항목 종류를 따른다)
  type: VaultItemType
  // 계정 편집이면 대상 계정
  account?: AccountDto
  // 편집 중인 기존 항목(없으면 신규)
  item?: VaultItemMeta
}

/**
 * 항목 종류별 폼. 계정형(login)은 계정 정보도 함께 저장한다.
 * 부모가 열 때마다 key 를 바꿔 새로 마운트하므로 초기값만 props 에서 읽는다.
 */
export function ItemEditor({ open, onOpenChange, type, account, item }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const upsertAccount = useVaultStore((s) => s.upsertAccount)
  const putItem = useVaultStore((s) => s.putItem)
  const select = useVaultStore((s) => s.select)
  const selectGlobalItem = useVaultStore((s) => s.selectGlobalItem)
  const error = useVaultStore((s) => s.error)
  const activeTab = useBrowserStore((s) => s.activeTab)

  const itemType = item?.type ?? type
  const isAccountForm = ACCOUNT_TYPES.has(itemType)
  // 새 로그인은 현재 탭의 호스트·URL 을 기본값으로 채운다
  const tabHost = normalizeHost(activeTab?.url ?? '')
  const tabUrl = activeTab?.url ?? ''

  const [label, setLabel] = useState(
    item?.label ?? account?.label ?? (isAccountForm ? tabHost : t(`vault.itemType.${itemType}`))
  )
  const [username, setUsername] = useState(account?.username ?? '')
  const [host, setHost] = useState(account?.host ?? (isAccountForm ? tabHost : ''))
  const [values, setValues] = useState<Record<string, string>>({})
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [saving, setSaving] = useState(false)

  const specs = FORM_SPECS[itemType]

  const setValue = (key: string, value: string): void =>
    setValues((prev) => ({ ...prev, [key]: value }))

  // 값이 빈 문자열인 필드는 아예 보내지 않는다 → 메인이 기존 값을 유지한다
  const toSections = (): PutSectionInput[] => {
    const sections: PutSectionInput[] = specs.map((section) => ({
      key: section.key,
      label: t(section.labelKey),
      fields: section.fields.map((field) => ({
        key: field.key,
        label: t(field.labelKey),
        kind: field.kind,
        ...(values[field.key] ? { value: values[field.key] } : {})
      }))
    }))
    if (customFields.length > 0) {
      sections.push({
        key: CUSTOM_SECTION_KEY,
        label: t('vault.sections.custom'),
        fields: customFields.map((field) => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(values[field.key] ? { value: values[field.key] } : {})
        }))
      })
    }
    return sections
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    void save()
  }

  const save = async (): Promise<void> => {
    if (!label.trim()) return
    setSaving(true)
    let accountId: number | null = account?.id ?? null
    if (isAccountForm) {
      if (!host.trim()) {
        setSaving(false)
        return
      }
      const saved = await upsertAccount({
        id: account?.id,
        host: host.trim(),
        label: label.trim(),
        username: username.trim(),
        isDefault: account?.isDefault,
        // 새 계정이면 현재 탭 URL 을 첫 Website 로 담는다
        ...(account || !tabUrl ? {} : { urls: [tabUrl] })
      })
      if (!saved) {
        setSaving(false)
        return
      }
      accountId = saved.id
    }

    const ok = await putItem({
      ...(item ? { id: item.id } : {}),
      accountId,
      type: itemType,
      label: label.trim(),
      sections: toSections()
    })
    setSaving(false)
    if (!ok) return
    if (accountId !== null) select(accountId)
    else {
      const saved = useVaultStore
        .getState()
        .itemsByAccount.global?.find((i) => i.type === itemType && i.label === label.trim())
      if (saved) selectGlobalItem(saved.id)
    }
    onOpenChange(false)
  }

  const titleKey = item ? 'vault.editor.editItemTitle' : 'vault.editor.newTitle'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-auto rounded-2xl sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t(titleKey, { type: t(`vault.itemType.${itemType}`) })}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label={t('vault.editor.label')}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
          {isAccountForm && (
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

          {specs.map((section) => (
            <section key={section.key} className="flex flex-col gap-2">
              <h4 className="text-[12px] font-semibold text-[var(--text2)]">
                {t(section.labelKey)}
              </h4>
              {section.fields.map((field) => (
                <Field key={field.key} label={t(field.labelKey)}>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type={
                        field.kind === 'secret'
                          ? 'password'
                          : field.kind === 'date'
                            ? 'date'
                            : 'text'
                      }
                      autoComplete="off"
                      data-lpignore="true"
                      spellCheck={false}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValue(field.key, e.target.value)}
                      placeholder={item ? t('vault.editor.keepHint') : ''}
                    />
                    {field.kind === 'secret' && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-9 shrink-0 rounded-[9px]"
                          >
                            {t('vault.editor.generate')}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-[280px]">
                          <PasswordGenerator onUse={(pw) => setValue(field.key, pw)} />
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                </Field>
              ))}
            </section>
          ))}

          <CustomFieldEditor
            fields={customFields}
            values={values}
            onAdd={(field) => setCustomFields((prev) => [...prev, field])}
            onRemove={(key) => setCustomFields((prev) => prev.filter((f) => f.key !== key))}
            onChange={setValue}
          />

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

// 사용자 정의 필드 — key/표시 이름/종류를 정해 추가한다
function CustomFieldEditor({
  fields,
  values,
  onAdd,
  onRemove,
  onChange
}: {
  fields: CustomField[]
  values: Record<string, string>
  onAdd: (field: CustomField) => void
  onRemove: (key: string) => void
  onChange: (key: string, value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<FieldKind>('text')

  const add = (): void => {
    const trimmedKey = key.trim()
    if (!trimmedKey || fields.some((f) => f.key === trimmedKey)) return
    onAdd({ key: trimmedKey, label: label.trim() || trimmedKey, kind })
    setKey('')
    setLabel('')
  }

  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[12px] font-semibold text-[var(--text2)]">
        {t('vault.sections.custom')}
      </h4>
      {fields.map((field) => (
        <Field key={field.key} label={field.label}>
          <div className="flex items-center gap-1.5">
            <Input
              type={field.kind === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              value={values[field.key] ?? ''}
              onChange={(e) => onChange(field.key, e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0 rounded-[9px]"
              onClick={() => onRemove(field.key)}
            >
              {t('vault.fields.remove')}
            </Button>
          </div>
        </Field>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('vault.fields.key')}
          className="h-8"
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('vault.fields.fieldLabel')}
          className="h-8"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as FieldKind)}
          aria-label={t('vault.fields.kind')}
          className="h-8 rounded-md border border-[var(--line)] bg-transparent px-2 text-[12px] outline-none"
        >
          {FIELD_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`vault.fields.kind${k.charAt(0).toUpperCase()}${k.slice(1)}`)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 rounded-[9px]"
          onClick={add}
        >
          {t('vault.fields.add')}
        </Button>
      </div>
    </section>
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
