import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Pause, Trash2, FileUp, FolderUp, Plus, Terminal, RefreshCw, ClipboardPaste, Folder, FolderPlus, History, Pencil } from 'lucide-react';
import { useApp } from '../context/useApp';
import { useModal } from '../context/useModal';
import ToggleSwitch from '../components/ToggleSwitch';
import { parseMetadata } from '../../../utils/metadataParser';
import { importFromFileLegacy, importFromDirectoryLegacy } from '../../../utils/importManager';
import { useI18n } from '../../context/I18nContext';
import { bridge } from '../../bridge/client';
import { isMobile } from '../../../utils/browserPolyfill';
import type { Script } from '../types';
import type { WorkspaceConflict, WorkspaceResolution } from '../../../utils/workspaceManager';
import { normalizeFolder } from '../../../utils/workspaceManager';

function DiffView({ appCode, fileCode }: { appCode: string; fileCode: string }) {
    const { t } = useI18n();
    const [appChanged, fileChanged] = useMemo(() => {
        const a = appCode.split('\n');
        const b = fileCode.split('\n');
        const app = new Set<number>();
        const file = new Set<number>();
        if (a.length * b.length > 250000) {
            for (let i = 0; i < Math.max(a.length, b.length); i++) {
                if (a[i] !== b[i]) {
                    if (i < a.length) app.add(i);
                    if (i < b.length) file.add(i);
                }
            }
            return [app, file];
        }
        const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
        for (let i = a.length - 1; i >= 0; i--) {
            for (let j = b.length - 1; j >= 0; j--) {
                table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < a.length || j < b.length) {
            if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
            else if (j === b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) app.add(i++);
            else file.add(j++);
        }
        return [app, file];
    }, [appCode, fileCode]);
    const render = (code: string, changed: Set<number>) => code.split('\n').map((line, index) => (
        <span key={index} style={{ display: 'block', background: changed.has(index) ? 'rgba(245,158,11,.22)' : 'transparent' }}>
            {String(index + 1).padStart(4)}  {line || ' '}
        </span>
    ));
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 8 }}>
            <div><strong>{t('workspaceAppVersion')}</strong><pre style={{ overflow: 'auto', maxHeight: 240, fontSize: 11 }}>{render(appCode, appChanged)}</pre></div>
            <div><strong>{t('workspaceFileVersion')}</strong><pre style={{ overflow: 'auto', maxHeight: 240, fontSize: 11 }}>{render(fileCode, fileChanged)}</pre></div>
        </div>
    );
}

const Scripts = () => {
    const { scripts, folders, toggleScript, deleteScript, setScripts, saveScript, reloadScripts, updateLibrary } = useApp();
    const { t } = useI18n();
    const { showModal } = useModal();
    const navigate = useNavigate();
    const [selectedScriptIds, setSelectedScriptIds] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
    const [sortBy, setSortBy] = useState<'name' | 'recent'>('name');
    const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
    const [folderDraft, setFolderDraft] = useState('');
    const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
    const [conflicts, setConflicts] = useState<WorkspaceConflict[]>([]);
    const [workspaceNotice, setWorkspaceNotice] = useState('');
    const [scanning, setScanning] = useState(false);
    const [workspaceLinked, setWorkspaceLinked] = useState(false);
    const didInitialScan = useRef(false);
    const scanWorkspace = useCallback(async () => {
        setScanning(true);
        try {
            const status = await bridge.call('GET_BACKUP_DIR_STATUS');
            setWorkspaceLinked(!!status.name);
            if (!status.name) {
                setWorkspaceNotice('');
                setConflicts([]);
                return;
            }
            if (status.needsRestore) {
                setWorkspaceNotice(t('workspaceNeedsRestore'));
                return;
            }
            if (status.permission !== 'granted') {
                setWorkspaceNotice(t('workspaceNeedsAccess'));
                return;
            }
            const result = await bridge.call('SCAN_WORKSPACE');
            setConflicts(result.conflicts);
            setWorkspaceNotice(result.conflicts.length ? t('workspaceConflictsCount', String(result.conflicts.length)) : '');
            if (result.changed) await reloadScripts();
        } catch (error) {
            setWorkspaceNotice((error as Error).message);
        } finally {
            setScanning(false);
        }
    }, [reloadScripts, t]);
    useEffect(() => {
        if (didInitialScan.current) return;
        didInitialScan.current = true;
        void scanWorkspace();
    }, [scanWorkspace]);

    const createFolder = async () => {
        try {
            const name = folderDraft.trim();
            if (!name || name.includes('/')) throw new Error(t('workspaceInvalidFolderName'));
            const folder = normalizeFolder(`${selectedFolder ? selectedFolder + '/' : ''}${name}`);
            if (folders.includes(folder)) throw new Error(t('workspaceFolderExists'));
            await updateLibrary(scripts, [...folders, folder].sort());
            setFolderDraft('');
        } catch (error) {
            showModal('error', t('workspaceCreateFolderFailed'), (error as Error).message);
        }
    };
    const renameFolder = async (oldPath: string) => {
        try {
            const name = folderDraft.trim();
            if (!name || name.includes('/')) throw new Error(t('workspaceInvalidFolderName'));
            const parent = oldPath.split('/').slice(0, -1).join('/');
            const newPath = normalizeFolder(`${parent ? parent + '/' : ''}${name}`);
            if (folders.some(folder => folder === newPath || folder.startsWith(newPath + '/'))) throw new Error(t('workspaceFolderExists'));
            const replace = (path: string) => path === oldPath || path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
            await updateLibrary(
                scripts.map(script => ({ ...script, folderPath: replace(script.folderPath || '') })),
                folders.map(replace).sort(),
            );
            if (selectedFolder?.startsWith(oldPath)) setSelectedFolder(replace(selectedFolder));
            setRenamingFolder(null);
            setFolderDraft('');
        } catch (error) {
            showModal('error', t('workspaceRenameFolderFailed'), (error as Error).message);
        }
    };
    const moveScript = async (script: Script, folderPath: string) => {
        try {
            await updateLibrary(scripts.map(item => item.id === script.id ? { ...item, folderPath } : item), folders);
        } catch (error) {
            showModal('error', t('workspaceMoveScriptFailed'), (error as Error).message);
        }
    };
    const resolveConflict = async (conflict: WorkspaceConflict, resolution: WorkspaceResolution) => {
        try {
            const result = await bridge.call('RESOLVE_WORKSPACE_CONFLICT', { conflict, resolution });
            setConflicts(result.conflicts);
            setWorkspaceNotice(result.conflicts.length ? t('workspaceConflictsCount', String(result.conflicts.length)) : '');
            await reloadScripts();
        } catch (error) {
            showModal('error', t('workspaceResolveFailed'), (error as Error).message);
        }
    };
    const visibleScripts = useMemo(() => {
        const term = query.trim().toLocaleLowerCase();
        return scripts.filter((script: Script) => {
            if (selectedFolder !== null) {
                const path = script.folderPath || '';
                if (selectedFolder === '' ? path !== '' : path !== selectedFolder && !path.startsWith(selectedFolder + '/')) return false;
            }
            if (statusFilter === 'enabled' && !script.enabled) return false;
            if (statusFilter === 'disabled' && script.enabled) return false;
            if (!term) return true;
            const metadata = parseMetadata(script.code);
            return [script.name, metadata.namespace, script.sourceUrl]
                .some(value => value?.toLocaleLowerCase().includes(term));
        }).sort((a: Script, b: Script) => sortBy === 'recent'
            ? (b.updateDate || b.installDate || 0) - (a.updateDate || a.installDate || 0)
            : a.name.localeCompare(b.name));
    }, [scripts, selectedFolder, query, statusFilter, sortBy]);

    const handleNewScript = async () => {
        navigate('/options/new', { state: { folderPath: selectedFolder || '' } });
    };

    const handleBulkEnable = async () => {
        if (selectedScriptIds.size === 0) return;
        for (const id of selectedScriptIds) {
            const script = scripts.find((s: Script) => s.id === id);
            if (script) await toggleScript(script, true);
        }
    };

    const handleBulkDisable = async () => {
        if (selectedScriptIds.size === 0) return;
        for (const id of selectedScriptIds) {
            const script = scripts.find((s: Script) => s.id === id);
            if (script) await toggleScript(script, false);
        }
    };

    const handleBulkDelete = async () => {
        if (selectedScriptIds.size === 0) return;
        showModal('confirm', t('deleteScriptsTitle'), t('confirmDeleteMultiple', [String(selectedScriptIds.size)]), async () => {
            try {
                for (const id of selectedScriptIds) {
                    await deleteScript(id);
                }
                setScripts((prev: Script[]) => prev.filter((s: Script) => !selectedScriptIds.has(s.id)));
                setSelectedScriptIds(new Set());
            } catch (e) {
                console.error("Failed to delete", e);
                showModal('error', t('deleteFailed'), (e as Error).message);
            }
        });
    };

    const handleImportFile = async () => {
        try {
            let importedScripts;
            if (!('showOpenFilePicker' in window)) {
                importedScripts = await importFromFileLegacy();
            } else {
                importedScripts = await bridge.call('IMPORT_FILE');
            }
            if (!importedScripts || importedScripts.length === 0) return;
            for (const script of importedScripts) {
                await saveScript(script);
            }
            await bridge.call('RELOAD_SCRIPTS');
            // Update context? reloadScripts() from context would happen automatically via listener
            showModal('success', t('importSuccessful'), t('importedScripts', [String(importedScripts.length)]));
        } catch (e) {
            showModal('error', t('importFailed'), (e as Error).message);
        }
    };

    const handleImportFolder = async () => {
        try {
            let importedScripts;
            if (!('showDirectoryPicker' in window)) {
                importedScripts = await importFromDirectoryLegacy();
            } else {
                importedScripts = await bridge.call('IMPORT_DIRECTORY');
            }
            if (!importedScripts || importedScripts.length === 0) return;
            for (const script of importedScripts) {
                await saveScript(script);
            }
            await bridge.call('RELOAD_SCRIPTS');
            showModal('success', t('importSuccessful'), t('importedScripts', [String(importedScripts.length)]));
        } catch (e) {
            showModal('error', t('importFailed'), (e as Error).message);
        }
    };

    const getUpdateUrl = (script: Script) => {
        // Prioritize metadata update URL, then fallback to script sourceUrl
        const metadata = parseMetadata(script.code);
        return metadata.updateURL || metadata.downloadURL || metadata.installURL || script.sourceUrl;
    };

    const handleCheckUpdate = (script: Script) => {
        bridge.call('START_UPDATE_FLOW', { scriptId: script.id });
    };



    const toggleScriptSelection = (id: string) => {
        const next = new Set(selectedScriptIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedScriptIds(next);
    };

    const toggleSelectAll = () => {
        if (visibleScripts.every((script: Script) => selectedScriptIds.has(script.id))) {
            setSelectedScriptIds(prev => new Set([...prev].filter(id => !visibleScripts.some((script: Script) => script.id === id))));
        } else {
            setSelectedScriptIds(prev => new Set([...prev, ...visibleScripts.map((script: Script) => script.id)]));
        }
    };

    const handleDeleteScript = (script: Script) => {
        showModal('confirm', t('deleteScriptTitle'), t('deleteScriptConfirm', [script.name]), async () => {
            try {
                await deleteScript(script.id);
                setSelectedScriptIds(prev => new Set([...prev].filter(id => id !== script.id)));
            } catch (e) {
                console.error("Failed to delete", e);
                showModal('error', t('deleteFailed'), (e as Error).message);
            }
        });
    };

    return (
        <div className="content-scroll" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: 0 }}>
            <div className="script-table-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', maxWidth: '100%', margin: 0 }}>
                <div className="page-header" style={{ height: 'auto', minHeight: '40px', flexShrink: 0, padding: '32px 48px 24px 48px', marginBottom: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <h2 className="page-title">{t('myScripts', [String(scripts.length)])}</h2>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div className="header-actions">
                            <button className="btn-secondary" onClick={handleImportFile}><FileUp size={16} /> {t('importFile')}</button>
                            {!isMobile() && <button className="btn-secondary" onClick={handleImportFolder}><FolderUp size={16} /> {t('importFolder')}</button>}
                            <button className="btn-secondary" onClick={() => navigate('/options/new', { state: { openPaste: true, folderPath: selectedFolder || '' } })}><ClipboardPaste size={16} /> {t('createFromPaste')}</button>
                            <button className="btn-primary" onClick={handleNewScript}><Plus size={16} /> {t('newScript')}</button>
                        </div>
                    </div>
                </div>

                <div style={{ padding: '0 24px 12px', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <button className="btn-secondary" onClick={() => void scanWorkspace()} disabled={scanning || !workspaceLinked}>
                        <RefreshCw size={15} /> {scanning ? t('workspaceScanning') : t('workspaceRefresh')}
                    </button>
                    <button className="btn-secondary" onClick={() => navigate('/options/history')} disabled={!workspaceLinked}>
                        <History size={15} /> {t('workspaceHistory')}
                    </button>
                    {workspaceNotice && <span role="status" style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{workspaceNotice}</span>}
                </div>

                {conflicts.length > 0 && (
                    <section aria-label={t('workspaceConflictSection')} style={{ padding: '8px 24px', maxHeight: '38vh', overflow: 'auto', flexShrink: 0, borderBlock: '1px solid var(--border-color)' }}>
                        <h3 style={{ margin: '4px 0 8px' }}>{t('workspaceConflictSection')}</h3>
                        {conflicts.map((conflict, index) => (
                            <article key={`${conflict.kind}-${conflict.path}-${index}`} style={{ padding: 12, marginBottom: 8, border: '1px solid var(--border-color)', borderRadius: 8 }}>
                                <strong>{conflict.path || conflict.scriptId}</strong>
                                <p style={{ margin: '6px 0' }}>{conflict.message}</p>
                                {conflict.appCode && conflict.fileCode && <DiffView appCode={conflict.appCode} fileCode={conflict.fileCode} />}
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                    {conflict.scriptId && !['duplicate-identity', 'invalid-file', 'ambiguous-move'].includes(conflict.kind) && (
                                        <>
                                            <button className="btn-secondary" onClick={() => void resolveConflict(conflict, 'app')}>
                                                {t(conflict.kind === 'missing-file' ? 'workspaceRecreateFile' : conflict.kind === 'changed-before-delete' ? 'workspaceDeleteFile' : 'workspaceChooseApp')}
                                            </button>
                                            <button className="btn-secondary" onClick={() => void resolveConflict(conflict, 'file')}>
                                                {t(conflict.kind === 'missing-file' ? 'workspaceDeleteFromApp' : conflict.kind === 'changed-before-delete' ? 'workspaceRestoreFromFile' : conflict.kind === 'possible-move' ? 'workspaceLinkFile' : 'workspaceChooseFile')}
                                            </button>
                                        </>
                                    )}
                                    {(!conflict.scriptId || ['duplicate-identity', 'invalid-file', 'ambiguous-move'].includes(conflict.kind)) &&
                                        <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('workspaceFixMetadata')}</span>}
                                </div>
                            </article>
                        ))}
                    </section>
                )}

                <section aria-label={t('workspaceFolders')} style={{ padding: '0 24px 14px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        <button className={selectedFolder === null ? 'btn-primary' : 'btn-secondary'} onClick={() => setSelectedFolder(null)}>{t('workspaceAll')}</button>
                        <button className={selectedFolder === '' ? 'btn-primary' : 'btn-secondary'} onClick={() => setSelectedFolder('')}><Folder size={14} /> {t('workspaceRoot')}</button>
                        {folders.map(folder => (
                            <button key={folder} className={selectedFolder === folder ? 'btn-primary' : 'btn-secondary'} onClick={() => setSelectedFolder(folder)}
                                style={{ paddingLeft: 10 + folder.split('/').length * 8 }}>
                                <Folder size={14} /> {folder}
                            </button>
                        ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input value={folderDraft} onChange={event => setFolderDraft(event.target.value)}
                            onKeyDown={event => { if (event.key === 'Enter') void (renamingFolder ? renameFolder(renamingFolder) : createFolder()); }}
                            placeholder={t('workspaceNewFolderName')} aria-label={t('workspaceFolderName')} />
                        <button className="btn-secondary" onClick={() => void (renamingFolder ? renameFolder(renamingFolder) : createFolder())}>
                            <FolderPlus size={15} /> {t(renamingFolder ? 'workspaceRenameFolder' : 'workspaceCreateFolder')}
                        </button>
                        {selectedFolder && !renamingFolder &&
                            <button className="btn-secondary" onClick={() => { setRenamingFolder(selectedFolder); setFolderDraft(selectedFolder.split('/').at(-1) || ''); }}>
                                <Pencil size={15} /> {t('workspaceRenameFolder')}
                            </button>}
                        {renamingFolder && <button className="btn-secondary" onClick={() => { setRenamingFolder(null); setFolderDraft(''); }}>{t('workspaceCancel')}</button>}
                    </div>
                </section>

                {scripts.length > 0 && (
                    <div className="script-filters">
                        <input
                            type="search"
                            value={query}
                            onChange={event => setQuery(event.target.value)}
                            placeholder={t('searchScripts')}
                            aria-label={t('searchScripts')}
                        />
                        <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)} aria-label={t('filterScripts')}>
                            <option value="all">{t('filterAll')}</option>
                            <option value="enabled">{t('filterEnabled')}</option>
                            <option value="disabled">{t('filterDisabled')}</option>
                        </select>
                        <select value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)} aria-label={t('sortScripts')}>
                            <option value="name">{t('sortName')}</option>
                            <option value="recent">{t('sortRecent')}</option>
                        </select>
                    </div>
                )}

                {scripts.length === 0 ? (
                    <div className="empty-dashboard" style={{ textAlign: 'center', marginTop: '4rem', color: 'var(--text-secondary)', flex: 1, overflow: 'auto' }}>
                        <div className="empty-icon-wrapper" style={{ background: 'var(--surface-bg)', borderRadius: '50%', padding: '2rem', display: 'inline-block', marginBottom: '1rem' }}>
                            <Terminal size={48} />
                        </div>
                        <h3>{t('noScriptsFound')}</h3>
                        <p>{t('createScriptToStart')}</p>
                    </div>
                ) : visibleScripts.length === 0 ? (
                    <div className="empty-dashboard">{t('noSearchResults')}</div>
                ) : (
                    <div className="script-list-scroll">
                        <table className="script-table compact" style={{ minWidth: '800px' }}>
                            <thead>
                                <tr>
                                    <th style={{ width: '40px', textAlign: 'center' }}>
                                        <input type="checkbox" checked={visibleScripts.length > 0 && visibleScripts.every((script: Script) => selectedScriptIds.has(script.id))} onChange={toggleSelectAll} style={{ cursor: 'pointer' }} aria-label={t('selectAllVisible')} />
                                    </th>
                                    <th style={{ width: '60px' }}>{t('enabledHeader')}</th>
                                    <th>{t('nameHeader')}</th>
                                    <th>{t('namespaceHeader')}</th>
                                    <th>{t('versionHeader')}</th>
                                    <th>{t('sourceHeader')}</th>
                                    <th>{t('installedHeader')}</th>
                                    <th className="col-actions">{t('actionsHeader')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleScripts.map((script: Script) => {
                                    const metadata = parseMetadata(script.code);

                                    return (
                                        <tr key={script.id} className={selectedScriptIds.has(script.id) ? 'selected-row' : ''} style={selectedScriptIds.has(script.id) ? { backgroundColor: 'var(--hover-color, rgba(255,255,255,0.05))' } : {}}>
                                            <td style={{ textAlign: 'center' }}>
                                                <input type="checkbox" checked={selectedScriptIds.has(script.id)} onChange={() => toggleScriptSelection(script.id)} style={{ cursor: 'pointer' }} />
                                            </td>
                                            <td>
                                                <ToggleSwitch checked={!!script.enabled} onChange={() => toggleScript(script, !script.enabled)} />
                                            </td>
                                            <td style={{ cursor: 'pointer', maxWidth: '300px' }} onClick={() => navigate(`/options/scripts/${script.id}`)}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                                                    <span style={{ fontWeight: 600, fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{script.name}</span>
                                                </div>
                                                <select value={script.folderPath || ''} aria-label={t('workspaceScriptFolder', script.name)}
                                                    onClick={event => event.stopPropagation()}
                                                    onChange={event => { event.stopPropagation(); void moveScript(script, event.target.value); }}
                                                    style={{ maxWidth: '100%', fontSize: 12, marginTop: 4 }}>
                                                    <option value="">{t('workspaceRoot')}</option>
                                                    {folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}
                                                </select>
                                            </td>
                                            <td style={{ maxWidth: '200px' }}>
                                                {metadata.namespace ? (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
                                                        {metadata.namespace}
                                                    </span>
                                                ) : <span style={{ color: 'var(--text-secondary)' }}>-</span>}
                                            </td>
                                            <td>
                                                {metadata.version ? (
                                                    <span className="script-version">v{metadata.version}</span>
                                                ) : (
                                                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>-</span>
                                                )}
                                            </td>
                                            <td>
                                                <div className="remote-label-container">
                                                    <span style={{
                                                        padding: '2px 8px',
                                                        borderRadius: '12px',
                                                        backgroundColor: (script.sourceUrl) ? 'rgba(59, 130, 246, 0.1)' : 'rgba(107, 114, 128, 0.1)',
                                                        color: (script.sourceUrl) ? '#60a5fa' : '#9ca3af',
                                                        border: `1px solid ${(script.sourceUrl) ? 'rgba(59, 130, 246, 0.2)' : 'rgba(107, 114, 128, 0.2)'}`,
                                                        fontWeight: 600,
                                                        fontSize: '0.75rem',
                                                        whiteSpace: 'nowrap'
                                                    }}>
                                                        {(script.sourceUrl) ? t('remoteLabel') : t('localLabel')}
                                                    </span>
                                                    {getUpdateUrl(script) && (
                                                        <button className="action-btn" onClick={(e) => { e.stopPropagation(); handleCheckUpdate(script); }} title={t('checkForUpdatesTooltip')} style={{ padding: '4px', marginLeft: 0 }}>
                                                            <RefreshCw size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                            <td style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                                                {script.installDate ? new Date(script.installDate).toLocaleDateString() : '-'}
                                            </td>
                                            <td className="col-actions">
                                                <button className="action-btn delete" onClick={(e) => { e.stopPropagation(); handleDeleteScript(script); }} title={t('deleteTooltip')}>
                                                    <Trash2 size={16} />
                                                </button>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                        <div className="mobile-script-list">
                            <label className="select-visible">
                                <input type="checkbox" checked={visibleScripts.every((script: Script) => selectedScriptIds.has(script.id))} onChange={toggleSelectAll} />
                                {t('selectAllVisible')}
                            </label>
                            {visibleScripts.map((script: Script) => {
                                const metadata = parseMetadata(script.code);
                                return (
                                    <article className="mobile-script-card" key={script.id}>
                                        <div className="mobile-script-card-header">
                                            <input type="checkbox" checked={selectedScriptIds.has(script.id)} onChange={() => toggleScriptSelection(script.id)} aria-label={`${t('selectScript')} ${script.name}`} />
                                            <button className="mobile-script-name" onClick={() => navigate(`/options/scripts/${script.id}`)}>{script.name}</button>
                                            <ToggleSwitch checked={!!script.enabled} onChange={() => toggleScript(script, !script.enabled)} />
                                        </div>
                                        <div className="mobile-script-meta">
                                            {metadata.namespace && <span>{metadata.namespace}</span>}
                                            {metadata.version && <span>v{metadata.version}</span>}
                                            <span>{script.sourceUrl ? t('remoteLabel') : t('localLabel')}</span>
                                        </div>
                                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0' }}>
                                            <Folder size={14} />
                                            <select value={script.folderPath || ''} aria-label={t('workspaceScriptFolder', script.name)}
                                                onChange={event => void moveScript(script, event.target.value)} style={{ minWidth: 0, flex: 1 }}>
                                                <option value="">{t('workspaceRoot')}</option>
                                                {folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}
                                            </select>
                                        </label>
                                        <div className="mobile-script-actions">
                                            <button className="btn-secondary" onClick={() => navigate(`/options/scripts/${script.id}`)}>{t('editTooltip')}</button>
                                            {getUpdateUrl(script) && <button className="btn-secondary" onClick={() => handleCheckUpdate(script)}>{t('checkForUpdatesTooltip')}</button>}
                                            <button className="btn-secondary mobile-delete" onClick={() => handleDeleteScript(script)}>{t('deleteTooltip')}</button>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {selectedScriptIds.size > 0 && (
                <div className="bulk-actions">
                    <span style={{ fontSize: '0.9rem', fontWeight: 600, marginRight: '8px', color: 'var(--text-secondary)' }}>
                        {t('selectedCount', [String(selectedScriptIds.size)])}
                    </span>
                    <div style={{ width: '1px', height: '20px', background: 'var(--border-color)' }}></div>
                    <button className="btn-secondary" onClick={handleBulkEnable} style={{ padding: '6px 12px', fontSize: '0.9rem' }} title="Enable Selected">
                        <Play size={16} /> {t('enableSelected')}
                    </button>
                    <button className="btn-secondary" onClick={handleBulkDisable} style={{ padding: '6px 12px', fontSize: '0.9rem' }} title="Disable Selected">
                        <Pause size={16} /> {t('disableSelected')}
                    </button>
                    <button className="btn-danger action-btn delete" onClick={handleBulkDelete} style={{
                        padding: '6px 12px',
                        fontSize: '0.9rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        backgroundColor: '#ef4444',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer'
                    }}>
                        <Trash2 size={16} />
                        <span>{t('deleteSelected')}</span>
                    </button>
                </div>
            )}

            <style>{`
                @keyframes slideUp {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            `}</style>
        </div>
    );
};

export default Scripts;
