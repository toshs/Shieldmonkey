import { useState, useEffect } from 'react';
import { Settings, FileText, Plus, Trash2, RefreshCw, Sun, Moon, Monitor, Edit } from 'lucide-react';
import './App.css';
import { useI18n } from '../context/I18nContext';
import { bridge } from '../bridge/client';
import type { PopupScript } from '../bridge/types';

type Theme = 'light' | 'dark' | 'system';

const ToggleSwitch = ({ checked, onChange, disabled }: { checked: boolean, onChange: (checked: boolean) => void, disabled?: boolean }) => (
  <label className={`switch ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
    <input type="checkbox" checked={checked} onChange={(e) => !disabled && onChange(e.target.checked)} disabled={disabled} />
    <span className="slider"></span>
  </label>
);

function App() {
  const [activeScripts, setActiveScripts] = useState<PopupScript[]>([]);
  const [currentUrl, setCurrentUrl] = useState<string>('');
  const [extensionEnabled, setExtensionEnabled] = useState(true);
  const [theme, setTheme] = useState<Theme>('dark');
  const [query, setQuery] = useState('');
  const { t } = useI18n();
  const visibleScripts = activeScripts.filter(script => script.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const applyTheme = (newTheme: Theme) => {
    if (newTheme === 'system') {
      const isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', newTheme);
    }
  };

  useEffect(() => {
    const init = async () => {
      const data = await bridge.call('GET_POPUP_DATA');

      // Apply theme
      const storedTheme = (data.theme as Theme) || 'dark';
      setTheme(storedTheme);
      applyTheme(storedTheme);

      setExtensionEnabled(data.extensionEnabled !== false);

      setCurrentUrl(data.currentUrl || '');
      setActiveScripts(data.scripts);
    };

    init();
  }, []);

  const cycleTheme = () => {
    const modes: Theme[] = ['light', 'dark', 'system'];
    const nextIndex = (modes.indexOf(theme) + 1) % modes.length;
    const nextTheme = modes[nextIndex];
    setTheme(nextTheme);
    applyTheme(nextTheme);
    bridge.call('UPDATE_THEME', nextTheme);
  };

  const openDashboard = (create: boolean = false) => {
    let path = '';
    if (create) {
      if (currentUrl) {
        path = `?match=${encodeURIComponent(currentUrl)}#/options/new`;
      } else {
        path = '#/options/new';
      }
    }
    bridge.call('OPEN_DASHBOARD', { path });
    // window.close() might not work in iframe, or it closes iframe? 
    // Usually popup closes when focus is lost.
  };

  const toggleGlobal = async (checked: boolean) => {
    setExtensionEnabled(checked);
    // Optimistic update
    try {
      await bridge.call('TOGGLE_GLOBAL', checked);
    } catch (e) {
      console.error("Failed to toggle global", e);
    }
  };

  const toggleScript = async (id: string, checked: boolean) => {
    setActiveScripts(prev => prev.map(s => s.id === id ? { ...s, enabled: checked } : s));
    try {
      await bridge.call('TOGGLE_SCRIPT', { scriptId: id, enabled: checked });
    } catch (error) {
      setActiveScripts(prev => prev.map(s => s.id === id ? { ...s, enabled: !checked } : s));
      console.error('Failed to toggle script', error);
    }
  };

  const deleteScript = async (id: string, name: string) => {
    if (confirm(t('confirmDeleteScript', [name]))) {
      setActiveScripts(prev => prev.filter(s => s.id !== id));
      await bridge.call('DELETE_SCRIPT', { scriptId: id });
    }
  };

  const checkForUpdate = (script: PopupScript) => {
    bridge.call('START_UPDATE_FLOW', { scriptId: script.id });
  };

  const editScript = (id: string) => {
    // Open directly using the hash routing supported by Options App
    bridge.call('OPEN_DASHBOARD', { path: `#/options/scripts/${id}` });
    // window.close();
  };

  return (
    <div className="popup-container">
      <header className="popup-header">
        <div className="logo-area">
          <img src="/icons/icon48.png" alt="Logo" className="logo-img" />
          <h1>{t('appName')}</h1>
          <div className="global-switch-container">
            <ToggleSwitch checked={extensionEnabled} onChange={toggleGlobal} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={cycleTheme} className="icon-btn" title={t('themeTooltip', [theme])}>
            {theme === 'light' && <Sun size={20} />}
            {theme === 'dark' && <Moon size={20} />}
            {theme === 'system' && <Monitor size={20} />}
          </button>
          <button onClick={() => openDashboard(false)} className="icon-btn" title={t('dashboardTooltip')}>
            <Settings size={20} />
          </button>
        </div>
      </header>
      <main className="popup-main">
        {activeScripts.length > 5 && (
          <input className="popup-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('searchScripts')} aria-label={t('searchScripts')} />
        )}
        {activeScripts.length > 0 ? (
          <div className="script-list">
            <h2 className="list-title">
              {t('scriptsOnThisPage')}
            </h2>
            {visibleScripts.length === 0 && <p className="popup-no-results">{t('noSearchResults')}</p>}
            {visibleScripts.map(script => (
              <div key={script.id} className="script-item-row" style={{ opacity: extensionEnabled ? 1 : 0.6, pointerEvents: extensionEnabled ? 'auto' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', flex: 1, overflow: 'hidden' }}>
                  <ToggleSwitch checked={!!script.enabled} onChange={(c) => toggleScript(script.id, c)} />
                  <span className="script-name" style={{ marginLeft: '12px' }} title={script.name}>{script.name}</span>
                </div>
                <div className="script-actions">
                  <button className="icon-btn" title={t('editTooltip')} onClick={() => editScript(script.id)} style={{ padding: '8px' }}>
                    <Edit size={18} />
                  </button>
                  {script.hasUpdateUrl && (
                    <button className="icon-btn" title={t('checkForUpdatesTooltip')} onClick={() => checkForUpdate(script)} style={{ padding: '8px' }}>
                      <RefreshCw size={18} />
                    </button>
                  )}
                  <button className="icon-btn" title={t('deleteTooltip')} onClick={() => deleteScript(script.id, script.name)} style={{ padding: '8px', color: '#ef4444' }}>
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <FileText size={48} className="text-gray-400 mb-2" />
            <p>{t('noScriptsMatching')}</p>
            {currentUrl && <p className="text-xs text-gray-500 mt-2 truncate max-w-200">{currentUrl}</p>}
          </div>
        )
        }

        <div className="popup-footer">
          <button className="new-script-btn" onClick={() => openDashboard(true)}>
            <Plus size={16} /> {t('createNewScript')}
          </button>
        </div>
      </main >
    </div >
  );
}

export default App;
