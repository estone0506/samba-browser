import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import ko from './ko.json'
import en from './en.json'

// 앱 전체 번역 초기화. 기본 한국어, 설정에서 전환
void i18n.use(initReactI18next).init({
  resources: { ko: { translation: ko }, en: { translation: en } },
  lng: 'ko',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
