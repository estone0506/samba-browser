// 캡처 문구
import { defineMessages } from '../define'

export const captureMessages = defineMessages({
  ko: {
    'capture.noActiveTab': '활성 탭이 없습니다',
    'capture.emptyImage': '빈 이미지는 저장하지 않습니다',
    'capture.pageSizeUnreadable': '페이지 크기를 읽지 못했습니다',
    'capture.fullPageFailed': '전체 페이지 캡처에 실패했습니다',
    'capture.sourceNotFound': '화면 소스를 찾지 못했습니다',
    'capture.unknownMode': '알 수 없는 캡처 방식',
    'capture.invalidImageData': '이미지 데이터가 올바르지 않습니다',
    'capture.imageUnreadable': '이미지를 읽지 못했습니다',
    'capture.recordingWriteFailed': '녹화를 파일에 다 쓰지 못했어요: {message}',
    'capture.emptyPath': '경로가 비어 있습니다',
    'capture.outsideFolder': '캡처 폴더 밖의 파일입니다',
    'capture.fileNotFound': '파일을 찾을 수 없습니다'
  },
  en: {
    'capture.noActiveTab': 'There is no active tab',
    'capture.emptyImage': 'Empty images are not saved',
    'capture.pageSizeUnreadable': 'Could not read the page size',
    'capture.fullPageFailed': 'Full-page capture failed',
    'capture.sourceNotFound': 'Could not find the screen source',
    'capture.unknownMode': 'Unknown capture mode',
    'capture.invalidImageData': 'The image data is invalid',
    'capture.imageUnreadable': 'Could not read the image',
    'capture.recordingWriteFailed': 'Could not finish writing the recording to a file: {message}',
    'capture.emptyPath': 'The path is empty',
    'capture.outsideFolder': 'The file is outside the capture folder',
    'capture.fileNotFound': 'File not found'
  }
})
