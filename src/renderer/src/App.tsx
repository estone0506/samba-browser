import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'

function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  return (
    <div className="flex items-center gap-3 p-6">
      <h1 className="text-lg font-semibold">{t('app.name')}</h1>
      <Button
        variant="outline"
        onClick={() => i18n.changeLanguage(i18n.language === 'ko' ? 'en' : 'ko')}
      >
        {t('settings.language')}
      </Button>
    </div>
  )
}

export default App
