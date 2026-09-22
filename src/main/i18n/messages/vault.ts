// 금고 문구
import { defineMessages } from '../define'

export const vaultMessages = defineMessages({
  ko: {
    'vault.alreadyInitialized': '금고가 이미 설정되어 있습니다',
    'vault.emptyMaster': '마스터 비밀번호가 비어 있습니다',
    'vault.notInitialized': '금고가 아직 설정되지 않았습니다',
    'vault.metaCorrupted': '금고 메타데이터가 손상되었습니다',
    'vault.locked': '금고가 잠겨 있습니다',
    'vault.itemSaveFailed': '항목을 저장하지 못했습니다',
    'vault.itemNotFound': '항목을 찾을 수 없습니다',
    'vault.secretFieldNotFound': '비밀 필드를 찾을 수 없습니다',
    'vault.accountNotFound': '계정을 찾을 수 없습니다',
    'vault.accountCreateFailed': '계정을 만들지 못했습니다',
    'vault.exportWarning':
      '내보낸 파일에는 비밀번호가 평문으로 들어갑니다. 저장 후 안전한 곳으로 옮기고 원본은 지우세요.',
    'vault.webKeypadEntered': '결제 비밀번호 입력({digits}자리)',
    'vault.webKeypadPartial': '시험 입력: 결제 비밀번호 {digits}자리만 누름(결제 안 함)',
    'vault.webKeypadVerifyFailed': '결제 비밀번호 입력 확인 실패({digits}자리째)',
    'aiKeys.saveFailed': 'API 키 저장 실패: {reason}',
    'aiKeys.safeStorageUnavailable':
      '이 기기에서는 안전 저장소를 쓸 수 없어 API 키를 보관할 수 없습니다'
  },
  en: {
    'vault.alreadyInitialized': 'The vault is already set up',
    'vault.emptyMaster': 'The master password is empty',
    'vault.notInitialized': 'The vault has not been set up yet',
    'vault.metaCorrupted': 'The vault metadata is corrupted',
    'vault.locked': 'The vault is locked',
    'vault.itemSaveFailed': 'Could not save the item',
    'vault.itemNotFound': 'Item not found',
    'vault.secretFieldNotFound': 'Secret field not found',
    'vault.accountNotFound': 'Account not found',
    'vault.accountCreateFailed': 'Could not create the account',
    'vault.exportWarning':
      'The exported file contains your passwords in plain text. After saving, move it somewhere safe and delete the original.',
    'vault.webKeypadEntered': 'Payment password entered ({digits} digits)',
    'vault.webKeypadPartial':
      'Dry run: pressed only {digits} digits of the payment password (not paying)',
    'vault.webKeypadVerifyFailed': 'Payment password entry not registering (digit {digits})',
    'aiKeys.saveFailed': 'Failed to save API key: {reason}',
    'aiKeys.safeStorageUnavailable':
      'Secure storage is not available on this device, so the API key cannot be stored'
  }
})
