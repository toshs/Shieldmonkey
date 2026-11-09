import {
    handleSelectBackupDir, handleGetBackupDirStatus, handleRequestBackupDirAccess,
    handleRunBackup, handleRunRestore, handleScanWorkspace, handleResolveWorkspaceConflict,
    handleListWorkspaceHistory, handleReadWorkspaceHistory, handleRestoreWorkspaceHistory,
} from './workspace';
import { processScriptContent } from '../utils/importManager';
import { getDirectoryHandle, restoreDirectoryPermission } from '../utils/backupStorage';
import type { ActionType, AppActionMap, TypedAppAction } from './types';
import { confirmApproval } from './approval';
import { publicScript } from '../shared/policy';
import type { Script } from '../shared/types';
import { isUserScriptsAvailable } from '../utils/browserPolyfill';

async function sendBackground(message: object): Promise<void> {
    const response = await chrome.runtime.sendMessage(message) as { success?: boolean; error?: string } | undefined;
    if (!response || response.success !== true) throw new Error(response?.error || 'Background operation failed.');
}

async function downloadJson(data: string, filename: string): Promise<void> {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    try {
        const downloadId = await new Promise<number>((resolve, reject) => {
            chrome.downloads.download({
                url,
                filename,
                saveAs: false
            }, id => chrome.runtime.lastError
                ? reject(new Error(chrome.runtime.lastError.message))
                : id === undefined ? reject(new Error('Download did not start')) : resolve(id));
        });
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => finish(new Error('Backup download did not complete')), 120000);
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                chrome.downloads.onChanged.removeListener(onChanged);
                if (error) reject(error);
                else resolve();
            };
            const onChanged = (delta: chrome.downloads.DownloadDelta) => {
                if (delta.id !== downloadId) return;
                if (delta.error?.current) finish(new Error(delta.error.current));
                else if (delta.state?.current === 'complete') finish();
            };
            chrome.downloads.onChanged.addListener(onChanged);
            // A small download can finish before the listener is attached.
            chrome.downloads.search({ id: downloadId }, items => {
                if (chrome.runtime.lastError) finish(new Error(chrome.runtime.lastError.message));
                else if (items[0]?.state === 'complete') finish();
                else if (items[0]?.state === 'interrupted') finish(new Error(items[0].error || 'Download interrupted'));
            });
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function syncAfterChange(): Promise<void> {
    try {
        await triggerAutoBackup();
    } catch (error) {
        console.error('Workspace write failed:', error);
        await chrome.storage.local.set({ workspaceSyncError: (error as Error).message || String(error) });
    }
}

async function handleImportFile() {
    if (!('showOpenFilePicker' in window)) {
        throw new Error("File picker not supported in this browser");
    }
    try {
        const handles = await window.showOpenFilePicker({
            types: [{ description: 'User Scripts', accept: { 'text/javascript': ['.user.js', '.js'] } }],
            multiple: true
        });
        const scripts = [];
        for (const handle of handles) {
            const file = await handle.getFile();
            const text = await file.text();
            scripts.push(await processScriptContent(text));
        }
        return scripts;
    } catch (e: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((e as any).name === 'AbortError') return [];
        throw e;
    }
}

async function handleImportDirectory() {
    if (!('showDirectoryPicker' in window)) {
        throw new Error("Directory picker not supported in this browser");
    }
    try {
        const dirHandle = await window.showDirectoryPicker();
        const scripts = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const [name, entry] of (dirHandle as any).entries()) {
            if (entry.kind === 'file' && (name.endsWith('.user.js') || name.endsWith('.js'))) {
                const file = await (entry as FileSystemFileHandle).getFile();
                const text = await file.text();
                if (text.includes('==UserScript==')) {
                    scripts.push(await processScriptContent(text));
                }
            }
        }
        return scripts;
    } catch (e: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((e as any).name === 'AbortError') return [];
        throw e;
    }
}
async function triggerAutoBackup() {
    const handle = await getDirectoryHandle();
    if (!handle) return; // Download backups are serialized by the background worker.
    if (await restoreDirectoryPermission(handle) === 'granted') {
        const result = await handleScanWorkspace();
        if (result.conflicts.length) throw new Error('Resolve workspace conflicts before syncing.');
        await chrome.storage.local.set({ lastBackupTime: new Date().toISOString() });
    } else {
        throw new Error('Folder access is required. Grant access in Settings.');
    }
}

async function call<T extends ActionType>(
    type: T,
    ...args: AppActionMap[T]['payload'] extends undefined ? [payload?: undefined] : [payload: AppActionMap[T]['payload']]
): Promise<AppActionMap[T]['response']> {
    const typedData = { type, payload: args[0] } as TypedAppAction;
    let result: unknown;
    switch (typedData.type) {
                case 'GET_SETTINGS': {
                    const keys = ['scripts', 'scriptFolders', 'theme', 'extensionEnabled', 'locale', 'lastBackupTime', 'lastBackupError', 'autoBackup', 'autoBackupMode'];
                    result = await chrome.storage.local.get(keys);
                    const settings = result as { scripts?: Script[] };
                    settings.scripts = settings.scripts?.map(publicScript);
                    break;
                }
                case 'GET_LOCALE': {
                    const data = await chrome.storage.local.get('locale');
                    result = data.locale;
                    break;
                }
                case 'UPDATE_THEME':
                    await chrome.storage.local.set({ theme: typedData.payload });
                    break;
                case 'UPDATE_LOCALE':
                    await chrome.storage.local.set({ locale: typedData.payload });
                    break;
                case 'TOGGLE_GLOBAL':
                    await sendBackground({ type: 'TOGGLE_GLOBAL', enabled: typedData.payload });
                    break;
                case 'UPDATE_BACKUP_SETTINGS':
                    await chrome.storage.local.set(typedData.payload);
                    if (typedData.payload.autoBackup === true) await syncAfterChange();
                    break;
                case 'GET_APP_INFO':
                    result = { version: chrome.runtime.getManifest().version };
                    break;
                case 'UPDATE_SCRIPTS':
                    await sendBackground({ type: 'APPLY_LIBRARY', scripts: typedData.payload });
                    await syncAfterChange();
                    break;
                case 'RESTORE_SCRIPTS':
                    await sendBackground({ type: 'APPLY_LIBRARY', scripts: typedData.payload, restoring: true });
                    await syncAfterChange();
                    break;
                case 'UPDATE_LIBRARY':
                    await sendBackground({ type: 'APPLY_LIBRARY', ...typedData.payload });
                    await syncAfterChange();
                    break;
                case 'TOGGLE_SCRIPT':
                    // We need to forward this to background
                    {
                        const data = await chrome.storage.local.get('scripts');
                        const previous = (data.scripts as Script[]).find(script => script.id === typedData.payload.scriptId);
                        const approved = typedData.payload.enabled && previous ? await confirmApproval(previous, previous) : false;
                        await sendBackground({ type: 'TOGGLE_SCRIPT', ...typedData.payload, approved });
                    }
                    await syncAfterChange();
                    break;
                case 'DELETE_SCRIPT':
                    await sendBackground({ type: 'DELETE_SCRIPT', scriptId: typedData.payload.scriptId });
                    await syncAfterChange();
                    break;
                case 'IMPORT_SCRIPTS': {
                    const data = await chrome.storage.local.get('scripts');
                    const current = (data.scripts || []) as Script[];
                    const approvedIds: string[] = [];
                    for (const script of typedData.payload) {
                        if (await confirmApproval(script, current.find(old => old.id === script.id))) approvedIds.push(script.id);
                    }
                    await sendBackground({ type: 'IMPORT_SCRIPTS', scripts: typedData.payload, approvedIds });
                    await syncAfterChange();
                    break;
                }
                case 'SAVE_SCRIPT': {
                    const data = await chrome.storage.local.get('scripts');
                    const previous = (data.scripts as Script[] | undefined)?.find(script => script.id === typedData.payload.id);
                    const approved = await confirmApproval(typedData.payload, previous);
                    await sendBackground({ type: 'SAVE_SCRIPT', script: typedData.payload, approved });
                    await syncAfterChange();
                    break;
                }
                case 'RELOAD_SCRIPTS':
                    await sendBackground({ type: 'RELOAD_SCRIPTS' });
                    break;
                case 'OPEN_DASHBOARD':
                    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/index.html' + (typedData.payload?.path || '')), active: true });
                    // Close popup to ensure focus on the new tab, especially on mobile
                    window.close();
                    break;
                case 'OPEN_URL': {
                    const allowedHosts = [
                        'shieldmonkey.github.io',
                        'github.com'
                    ];
                    let isAllowed = false;
                    try {
                        const urlObj = new URL(typedData.payload);
                        isAllowed = urlObj.protocol === 'https:' && allowedHosts.some(host => urlObj.hostname === host || urlObj.hostname.endsWith('.' + host));
                    } catch { /* parse error */ }

                    if (isAllowed) {
                        chrome.tabs.create({ url: typedData.payload });
                    } else {
                        console.error(`Blocked unauthorized OPEN_URL request to: ${typedData.payload}`);
                        throw new Error("URL not whitelisted");
                    }
                    break;
                }
                case 'GET_I18N_MESSAGE':
                    // payload is { key, substitutions }
                    result = chrome.i18n.getMessage(typedData.payload.key, typedData.payload.substitutions);
                    break;
                case 'SELECT_BACKUP_DIR':
                    result = await handleSelectBackupDir();
                    break;
                case 'GET_BACKUP_DIR_STATUS':
                    result = await handleGetBackupDirStatus();
                    break;
                case 'REQUEST_BACKUP_DIR_ACCESS':
                    result = await handleRequestBackupDirAccess();
                    break;
                case 'RUN_BACKUP':
                    // payload: { scripts, version }
                    result = await handleRunBackup(typedData.payload.scripts, typedData.payload.version);
                    break;
                case 'RUN_RESTORE':
                    // payload: { scripts }
                    result = await handleRunRestore(typedData.payload.scripts);
                    break;
                case 'SCAN_WORKSPACE':
                    result = await handleScanWorkspace();
                    break;
                case 'RESOLVE_WORKSPACE_CONFLICT':
                    await handleResolveWorkspaceConflict(typedData.payload.conflict, typedData.payload.resolution);
                    result = await handleScanWorkspace();
                    break;
                case 'LIST_WORKSPACE_HISTORY':
                    result = await handleListWorkspaceHistory();
                    break;
                case 'READ_WORKSPACE_HISTORY':
                    result = await handleReadWorkspaceHistory(typedData.payload.name);
                    break;
                case 'RESTORE_WORKSPACE_HISTORY':
                    result = await handleRestoreWorkspaceHistory(typedData.payload.name, typedData.payload.scriptId);
                    break;
                case 'CHECK_USER_SCRIPTS_PERMISSION':
                    result = await isUserScriptsAvailable();
                    break;
                case 'REQUEST_USER_SCRIPTS_PERMISSION':
                    // Called directly by the options page click handler.
                    try {
                        result = await chrome.permissions.request({ permissions: ['userScripts'] });
                    } catch (e) {
                        console.error("Permission request failed", e);
                        result = false;
                    }
                    break;
                case 'OPEN_EXTENSION_SETTINGS': {
                    // We can check user agent here or just default to ID for desktops
                    // Simple check for mobile logic if needed, or just try getting ID
                    // If isMobile check is complex, we can just use chrome://extensions/ generally?
                    // But for specific extension settings on desktop, `?id=` is better.
                    const isMob = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
                    const extUrl = isMob ? 'chrome://extensions/' : `chrome://extensions/?id=${chrome.runtime.id}`;
                    chrome.tabs.create({ url: extUrl, active: true });
                    window.close();
                    break;
                }
                case 'RELOAD_EXTENSION':
                    chrome.runtime.reload();
                    break;
                case 'CLOSE_TAB': {
                    // Close the current tab (host page)
                    try {
                        // For extension pages, getCurrent returns the tab
                        const currentTab = await chrome.tabs.getCurrent();
                        if (currentTab && currentTab.id) {
                            await chrome.tabs.remove(currentTab.id);
                        } else {
                            window.close();
                        }
                    } catch (e) {
                        console.error('Failed to close options tab', e);
                        window.close();
                    }
                    break;
                }
                case 'IMPORT_FILE':
                    result = await handleImportFile();
                    break;
                case 'IMPORT_DIRECTORY':
                    result = await handleImportDirectory();
                    break;
                case 'DOWNLOAD_JSON': {
                    await downloadJson(typedData.payload.data, typedData.payload.filename);
                    result = true;
                    break;
                }
                default:
                    throw new Error(`Unknown action type: ${type}`);
            }

    return result as AppActionMap[T]['response'];
}
export const app = {
    call,
    onStorageChanged(callback: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) {
        const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
            const allowed = new Set(['scripts', 'scriptFolders', 'theme', 'extensionEnabled', 'locale', 'lastBackupTime', 'lastBackupError', 'workspaceSyncError', 'autoBackup', 'autoBackupMode']);
            const filtered = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.has(key)));
            if (filtered.scripts) {
                filtered.scripts = { ...filtered.scripts,
                    newValue: Array.isArray(filtered.scripts.newValue) ? (filtered.scripts.newValue as Script[]).map(publicScript) : undefined,
                    oldValue: Array.isArray(filtered.scripts.oldValue) ? (filtered.scripts.oldValue as Script[]).map(publicScript) : undefined };
            }
            callback(filtered, areaName);
        };
        chrome.storage.onChanged.addListener(listener);
        return () => chrome.storage.onChanged.removeListener(listener);
    },
};
