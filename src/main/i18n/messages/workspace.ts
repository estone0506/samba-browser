// 작업공간 문구
import { defineMessages } from '../define'

export const workspaceMessages = defineMessages({
  ko: {
    'workspace.emptyName': '작업공간 이름이 비어 있습니다',
    'workspace.limitReached': '작업공간은 최대 {max}개까지 만들 수 있습니다',
    'workspace.notFound': '작업공간을 찾을 수 없습니다',
    'workspace.cannotDeleteLast': '마지막 작업공간은 삭제할 수 없습니다'
  },
  en: {
    'workspace.emptyName': 'The workspace name is empty',
    'workspace.limitReached': 'You can create up to {max} workspaces',
    'workspace.notFound': 'Workspace not found',
    'workspace.cannotDeleteLast': 'The last workspace cannot be deleted'
  }
})
