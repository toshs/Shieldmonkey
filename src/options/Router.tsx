import { Suspense } from 'react';
import { createHashRouter, RouterProvider, Navigate, useLocation } from 'react-router-dom';
import App from './App';
import { useI18n } from './i18n/I18nContext';

function LegacyRedirect() {
  const location = useLocation();
  const page = location.pathname.replace(/^\//, '') || 'scripts';
  return <Navigate to={'/options/' + page + location.search} replace />;
}
const router = createHashRouter([
  { path: '/options/*', element: <App /> },
  { path: '/*', element: <LegacyRedirect /> },
]);
export default function OptionsRouter() {
  const { t } = useI18n();
  return <Suspense fallback={<div role="status" style={{ height: '100%', display: 'grid', placeItems: 'center' }}>{t('uiLoading')}</div>}><RouterProvider router={router} /></Suspense>;
}
