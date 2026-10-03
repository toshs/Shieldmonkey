import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { bridge } from '../../bridge/client';
import { useApp } from '../context/useApp';
import { useModal } from '../context/useModal';
import { useI18n } from '../../context/I18nContext';
import type { WorkspaceHistoryItem, WorkspaceSnapshot } from '../../../utils/workspaceManager';

export default function History() {
    const navigate = useNavigate();
    const { reloadScripts } = useApp();
    const { showModal } = useModal();
    const { t } = useI18n();
    const [items, setItems] = useState<WorkspaceHistoryItem[]>([]);
    const [selected, setSelected] = useState<WorkspaceHistoryItem | null>(null);
    const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        void bridge.call('LIST_WORKSPACE_HISTORY').then(setItems).catch(reason => setError((reason as Error).message)).finally(() => setLoading(false));
    }, []);

    const openItem = async (item: WorkspaceHistoryItem) => {
        try {
            setError('');
            setSelected(item);
            setSnapshot(null);
            setSnapshot(await bridge.call('READ_WORKSPACE_HISTORY', { name: item.name }));
        } catch (reason) {
            setError((reason as Error).message);
        }
    };

    const restore = (scriptId?: string) => {
        if (!selected) return;
        const target = scriptId ? snapshot?.scripts.find(script => script.id === scriptId)?.name : t('workspaceAllScripts');
        showModal('confirm', t('workspaceRestoreTitle'), t('workspaceRestoreConfirm', [target || '', new Date(selected.timestamp).toLocaleString()]), async () => {
            try {
                setBusy(true);
                setError('');
                await bridge.call('RESTORE_WORKSPACE_HISTORY', { name: selected.name, scriptId });
                await reloadScripts();
                setItems(await bridge.call('LIST_WORKSPACE_HISTORY'));
                navigate('/options/scripts');
            } catch (reason) {
                setError((reason as Error).message);
            } finally {
                setBusy(false);
            }
        });
    };

    return (
        <div className="content-scroll" style={{ padding: 24, overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button className="btn-secondary" onClick={() => navigate('/options/scripts')}><ArrowLeft size={16} /> {t('workspaceBackToScripts')}</button>
                <h2 className="page-title" style={{ margin: 0 }}>{t('workspaceHistoryTitle')}</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)' }}>{t('workspaceHistoryDesc')}</p>
            {error && <p role="alert" style={{ color: '#ef4444' }}>{error}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 16 }}>
                <section aria-label={t('workspaceHistoryList')}>
                    {loading && <p>{t('workspaceHistoryLoading')}</p>}
                    {!loading && items.length === 0 && <p>{t('workspaceNoHistory')}</p>}
                    {items.map(item => (
                        <button key={item.name} className={selected?.name === item.name ? 'btn-primary' : 'btn-secondary'}
                            onClick={() => void openItem(item)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8 }}>
                            <strong>{new Date(item.timestamp).toLocaleString()}</strong>
                            <span style={{ display: 'block', fontSize: 12 }}>{item.reason} · {t('workspaceHistoryCount', String(item.count))}</span>
                        </button>
                    ))}
                </section>
                {snapshot && (
                    <section aria-label={t('workspaceHistoryContents')} style={{ minWidth: 0 }}>
                        <h3>{new Date(snapshot.timestamp).toLocaleString()}</h3>
                        <button className="btn-primary" disabled={busy} onClick={() => restore()}>
                            <RotateCcw size={16} /> {t('workspaceRestoreAll')}
                        </button>
                        <div style={{ marginTop: 16 }}>
                            {snapshot.scripts.map(script => (
                                <details key={script.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                                    <summary style={{ cursor: 'pointer' }}>{script.folderPath ? script.folderPath + '/' : ''}{script.name}</summary>
                                    <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{script.namespace || t('workspaceNoNamespace')} · {script.enabled === false ? t('filterDisabled') : t('filterEnabled')}</p>
                                    <button className="btn-secondary" disabled={busy} onClick={() => restore(script.id)}>{t('workspaceRestoreScript')}</button>
                                    <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, whiteSpace: 'pre' }}>{script.code}</pre>
                                </details>
                            ))}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}
