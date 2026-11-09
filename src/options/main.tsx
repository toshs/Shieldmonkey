import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import OptionsRouter from './Router';
import { I18nProvider } from './i18n/I18nContext';
import './base.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><I18nProvider><OptionsRouter /></I18nProvider></StrictMode>
);
