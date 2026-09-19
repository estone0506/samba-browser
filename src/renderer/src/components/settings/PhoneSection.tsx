import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import {
  PHONE_COUNTRIES,
  PHONE_LIMIT_PRO,
  SCREEN_FPS,
  SCREEN_SIZES,
  type PhoneCountry,
  type PhoneDto,
  type ScreenFps,
  type ScreenSize
} from '@shared/phone'
import { usePhoneStore } from '@renderer/stores/phoneStore'
import {
  countryBadge,
  isOverPhoneLimit,
  phoneStateLabelKey,
  phoneStateTone,
  smsBadgeKey,
  transportLabelKey
} from '@renderer/components/phone/phone-view'
import {
  SecondaryButton,
  SegmentedGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  StatusBadge,
  TextInput,
  type SectionProps
} from './shared'

// 설정 → 폰. adb·scrcpy 경로와 폰 목록, 화면 품질, 자동 재연결, 결제 상한을 다룬다
export function PhoneSection({ settings, update }: SectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const { list, load, subscribe, setLabel } = usePhoneStore()
  const [adb, setAdb] = useState(settings.adbPath)
  const [scrcpy, setScrcpy] = useState(settings.scrcpyPath)
  const [limit, setLimit] = useState(String(settings.paymentLimitKrw))
  const [detecting, setDetecting] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)

  useEffect(() => {
    void load()
    return subscribe()
  }, [load, subscribe])

  const detect = async (): Promise<void> => {
    setDetecting(true)
    setDetectNote(null)
    const r = await window.samba.phone.detectPaths()
    setDetecting(false)
    if (!r.ok) {
      setDetectNote(r.error)
      return
    }
    setAdb(r.data.adb)
    setScrcpy(r.data.scrcpy)
    update({ adbPath: r.data.adb, scrcpyPath: r.data.scrcpy })
    setDetectNote(r.data.adb ? null : t('phone.settings.detectFailed'))
  }

  // 결제 상한은 숫자만 받고, 빈 값·음수는 저장하지 않는다
  const commitLimit = (): void => {
    const n = Number(limit.replace(/[^\d]/g, ''))
    if (!Number.isFinite(n) || n <= 0) {
      setLimit(String(settings.paymentLimitKrw))
      return
    }
    setLimit(String(n))
    update({ paymentLimitKrw: n })
  }

  return (
    <>
      <SettingsSection
        title={t('phone.settings.pathsTitle')}
        description={t('phone.settings.pathsDesc')}
      >
        <SettingsRow label={t('phone.settings.adbPath')}>
          <TextInput
            value={adb}
            onChange={setAdb}
            onBlur={() => update({ adbPath: adb.trim() })}
            placeholder="C:\\platform-tools\\adb.exe"
          />
        </SettingsRow>
        <SettingsRow label={t('phone.settings.scrcpyPath')}>
          <TextInput
            value={scrcpy}
            onChange={setScrcpy}
            onBlur={() => update({ scrcpyPath: scrcpy.trim() })}
            placeholder="C:\\scrcpy\\scrcpy.exe"
          />
        </SettingsRow>
        <SecondaryButton disabled={detecting} onClick={() => void detect()}>
          {t('phone.settings.detect')}
        </SecondaryButton>
        {detectNote && <p className="text-[11.5px] text-[var(--text2)]">{detectNote}</p>}
      </SettingsSection>

      <SettingsSection
        title={t('phone.settings.listTitle')}
        description={t('phone.settings.limitNote', { n: PHONE_LIMIT_PRO })}
      >
        {list.length === 0 ? (
          <p className="text-[11.5px] text-[var(--text2)]">{t('phone.empty')}</p>
        ) : (
          list.map((phone) => <PhoneRow key={phone.id} phone={phone} onSave={setLabel} />)
        )}
        {isOverPhoneLimit(list.length) && (
          <p className="text-[11.5px] text-[#b91c1c]">
            {t('phone.settings.overLimit', { n: PHONE_LIMIT_PRO })}
          </p>
        )}
      </SettingsSection>

      <SettingsSection title={t('phone.settings.qualityTitle')}>
        <SettingsRow
          label={t('phone.settings.maxSize')}
          description={t('phone.settings.maxSizeDesc')}
        >
          <SegmentedGroup<string>
            value={String(settings.phoneScreenMaxSize)}
            onChange={(v) => update({ phoneScreenMaxSize: Number(v) as ScreenSize })}
            options={SCREEN_SIZES.map((s) => ({ value: String(s), label: `${s}p` }))}
          />
        </SettingsRow>
        <SettingsRow label={t('phone.settings.fps')}>
          <SegmentedGroup<string>
            value={String(settings.phoneScreenFps)}
            onChange={(v) => update({ phoneScreenFps: Number(v) as ScreenFps })}
            options={SCREEN_FPS.map((f) => ({ value: String(f), label: `${f} fps` }))}
          />
        </SettingsRow>
        <SettingsToggleRow
          label={t('phone.settings.autoReconnect')}
          description={t('phone.settings.autoReconnectDesc')}
        >
          <Switch
            checked={settings.phoneAutoReconnect}
            onCheckedChange={(v) => update({ phoneAutoReconnect: v })}
          />
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection
        title={t('phone.settings.paymentTitle')}
        description={t('phone.settings.paymentDesc')}
      >
        <SettingsRow label={t('phone.settings.paymentLimit')}>
          <TextInput value={limit} onChange={setLimit} onBlur={commitLimit} />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}

// 폰 한 줄 — 별칭·국가만 고칠 수 있고, 나머지(모델·주소·상태)는 읽기 전용이다
function PhoneRow({
  phone,
  onSave
}: {
  phone: PhoneDto
  onSave: (id: number, label: string, country: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [label, setLabelValue] = useState(phone.label)
  const smsBadge = smsBadgeKey(phone.smsQueryOk)

  // 다른 곳에서 별칭이 바뀌면 입력칸도 따라간다(렌더 중 보정 — 이펙트로 하면 렌더가 한 번 더 돈다)
  const [lastLabel, setLastLabel] = useState(phone.label)
  if (lastLabel !== phone.label) {
    setLastLabel(phone.label)
    setLabelValue(phone.label)
  }

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--line)] p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge
          label={t(phoneStateLabelKey(phone.state))}
          tone={phoneStateTone(phone.state)}
        />
        <StatusBadge label={t(transportLabelKey(phone.transport))} />
        {smsBadge && <StatusBadge label={t(smsBadge)} />}
        <span className="truncate text-[11.5px] text-[var(--text2)]">
          {phone.model || phone.serial}
          {phone.wifiAddress ? ` · ${phone.wifiAddress}` : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          value={label}
          onChange={setLabelValue}
          onBlur={() => void onSave(phone.id, label.trim(), phone.country)}
          placeholder={t('phone.settings.labelPlaceholder')}
          className="h-[30px] max-w-[220px]"
        />
        <SegmentedGroup<PhoneCountry>
          value={phone.country}
          onChange={(c) => void onSave(phone.id, label.trim(), c)}
          options={PHONE_COUNTRIES.map((c) => ({ value: c, label: countryBadge(c) }))}
        />
      </div>
    </div>
  )
}
