// 확장 문구
import { defineMessages } from '../define'

export const extensionMessages = defineMessages({
  ko: {
    // manifest 검증
    'ext.manifestInvalid': 'manifest.json 형식이 올바르지 않아요',
    'ext.manifestNoName': 'manifest.json 에 name 이 없어요',
    'ext.manifestNoVersion': 'manifest.json 에 version 이 없어요',
    'ext.manifestVersionUnsupported': '지원하지 않는 manifest_version 이에요 (2 또는 3만 지원)',
    'ext.manifestVersionOnly3': '지원하지 않는 manifest_version 이에요 (3만 지원)',
    'ext.manifestUnreadable': 'manifest.json 을 읽을 수 없어요 (JSON 형식 오류)',
    'ext.manifestOutsideFolder': 'manifest.json 이 확장 폴더 밖을 가리켜요',
    'ext.mv2Unsupported': 'MV2(Manifest V2) 확장은 지원하지 않아요',
    // 폴더 로드
    'ext.folderPathEmpty': '확장 폴더 경로가 비어 있어요',
    'ext.folderNotFound': '확장 폴더를 찾을 수 없어요',
    'ext.selectUnpackedFolder':
      '압축 해제된 확장 폴더를 선택해 주세요 (.crx 파일은 지원하지 않아요)',
    'ext.folderNoManifest': '폴더 안에 manifest.json 이 없어요',
    'ext.loadUnsupported': '이 Electron 버전은 확장 로드를 지원하지 않아요',
    'ext.notInList': '목록에 없는 확장이에요',
    // 웹스토어 입력
    'ext.inputEmpty': '확장 주소나 id 를 입력해 주세요',
    'ext.idNotFound': '확장 id 를 찾지 못했어요 (웹스토어 주소나 32자 id 를 넣어 주세요)',
    // CRX·ZIP
    'ext.crxTooShort': '내려받은 파일이 너무 짧아요 (CRX 가 아니에요)',
    'ext.crxBadMagic': 'CRX 파일이 아니에요 (매직 넘버가 달라요)',
    'ext.crxVersionUnsupported': '지원하지 않는 CRX 버전이에요 ({version})',
    'ext.crxBadHeaderLength': 'CRX 헤더 길이가 올바르지 않아요',
    'ext.crxNoZip': 'CRX 안에서 ZIP 을 찾지 못했어요',
    'ext.crxNoId': 'CRX 헤더에서 확장 id 를 읽지 못했어요',
    'ext.crxIdMismatch': '요청한 확장과 다른 파일이에요 ({id})',
    'ext.zipSlip': '확장 폴더 밖을 가리키는 파일이 있어요: {name}',
    'ext.zipTooBig': '확장 압축을 풀면 너무 커져요 ({mb}MB 초과)',
    'ext.zipEmpty': '확장 압축 파일이 비어 있어요',
    'ext.zipTooManyEntries': '확장 안의 파일이 너무 많아요 ({max}개 초과)',
    'ext.zipNoManifest': '확장 안에 manifest.json 이 없어요',
    // 내려받기
    'ext.fileTooLarge': '확장 파일이 너무 커요 ({mb}MB 초과)',
    'ext.downloadFailed': '내려받기에 실패했어요 (HTTP {status})',
    'ext.downloadBadRedirect': '허용하지 않는 주소로 연결됐어요',
    'ext.downloadEmpty': '내려받은 파일이 비어 있어요',
    'ext.downloadTimeout': '내려받기 시간이 초과됐어요',
    // 다른 브라우저에서 가져오기
    'ext.sourceFolderNotFound': '원본 확장 폴더를 찾을 수 없어요',
    'ext.copiedNoManifest': '복사한 폴더에 manifest.json 이 없어요',
    'ext.browserItemGone': '브라우저에서 그 확장을 더 이상 찾을 수 없어요'
  },
  en: {
    'ext.manifestInvalid': 'manifest.json is not in a valid format',
    'ext.manifestNoName': 'manifest.json has no name',
    'ext.manifestNoVersion': 'manifest.json has no version',
    'ext.manifestVersionUnsupported': 'Unsupported manifest_version (only 2 or 3 are supported)',
    'ext.manifestVersionOnly3': 'Unsupported manifest_version (only 3 is supported)',
    'ext.manifestUnreadable': "Couldn't read manifest.json (invalid JSON)",
    'ext.manifestOutsideFolder': 'manifest.json points outside the extension folder',
    'ext.mv2Unsupported': 'MV2 (Manifest V2) extensions are not supported',
    'ext.folderPathEmpty': 'The extension folder path is empty',
    'ext.folderNotFound': "Couldn't find the extension folder",
    'ext.selectUnpackedFolder':
      'Please select an unpacked extension folder (.crx files are not supported)',
    'ext.folderNoManifest': 'There is no manifest.json in the folder',
    'ext.loadUnsupported': "This Electron version doesn't support loading extensions",
    'ext.notInList': "This extension isn't in the list",
    'ext.inputEmpty': 'Please enter an extension URL or id',
    'ext.idNotFound': "Couldn't find an extension id (enter a Web Store URL or a 32-character id)",
    'ext.crxTooShort': 'The downloaded file is too short (not a CRX)',
    'ext.crxBadMagic': 'Not a CRX file (magic number mismatch)',
    'ext.crxVersionUnsupported': 'Unsupported CRX version ({version})',
    'ext.crxBadHeaderLength': 'The CRX header length is invalid',
    'ext.crxNoZip': "Couldn't find the ZIP inside the CRX",
    'ext.crxNoId': "Couldn't read the extension id from the CRX header",
    'ext.crxIdMismatch': "This file doesn't match the requested extension ({id})",
    'ext.zipSlip': 'A file points outside the extension folder: {name}',
    'ext.zipTooBig': 'The extension is too large when unpacked (over {mb}MB)',
    'ext.zipEmpty': 'The extension archive is empty',
    'ext.zipTooManyEntries': 'The extension has too many files (over {max})',
    'ext.zipNoManifest': 'There is no manifest.json in the extension',
    'ext.fileTooLarge': 'The extension file is too large (over {mb}MB)',
    'ext.downloadFailed': 'Download failed (HTTP {status})',
    'ext.downloadBadRedirect': 'Redirected to a disallowed address',
    'ext.downloadEmpty': 'The downloaded file is empty',
    'ext.downloadTimeout': 'The download timed out',
    'ext.sourceFolderNotFound': "Couldn't find the original extension folder",
    'ext.copiedNoManifest': 'There is no manifest.json in the copied folder',
    'ext.browserItemGone': "That extension can't be found in the browser anymore"
  }
})
