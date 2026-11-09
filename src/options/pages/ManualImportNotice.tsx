import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/I18nContext';
export default function ManualImportNotice() {
    const { t } = useI18n();
    return <main style={{ padding: 24 }}><h1>{t('manualImportTitle')}</h1><p>{t('manualImportNotice')}</p><Link to="/options/scripts">{t('myScripts')}</Link></main>;
}
