import { handleSelectBackupDir, handleGetBackupDirName, handleRunBackup, handleRunRestore, handleVerifyRestore, handleAcknowledgeRestore } from './backupHandlers';
import { processScriptContent } from '../utils/importManager';
import type { PopupScript, TypedBridgeMessage } from '../sandbox/bridge/types';
import { isUserScriptsAvailable } from '../utils/browserPolyfill';
import type { Script } from '../sandbox/options/types';
import { isValidHttpUrl } from '../utils/urlValidator';
import { isMetadataMatchingUrl } from '../utils/scriptMatcher';
import { parseMetadata } from '../utils/metadataParser';

async function sendBackground(message: object): Promise<void> {
    const response = await chrome.runtime.sendMessage(message) as { success?: boolean; error?: string } | undefined;
    if (!response || response.success === false) throw new Error(response?.error || 'Background operation failed.');
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
export function initBridge() {
    window.addEventListener('message', async (event: MessageEvent) => {
        // Usage: <iframe src="src/sandbox/index.html">
        // If it's a normal iframe in an extension page, it shares the origin. 
        // If we want to strictly sandbox it, we might use the manifest "sandbox" key, which gives it a unique origin.

        const data = event.data as Partial<TypedBridgeMessage>;
        if (!data || !data.id || !data.type) return;

        const typedData = data as TypedBridgeMessage;
        const id = typedData.id;
        const type = typedData.type;
        let result: unknown = null;
        let error: string | undefined = undefined;

        try {
            switch (typedData.type) {
                case 'GET_SETTINGS': {
                    const keys = ['scripts', 'theme', 'extensionEnabled', 'locale', 'lastBackupTime', 'lastBackupError', 'autoBackup', 'autoBackupMode'];
                    result = await chrome.storage.local.get(keys);
                    break;
                }
                case 'GET_LOCALE': {
                    const data = await chrome.storage.local.get('locale');
                    result = data.locale;
                    break;
                }
                case 'GET_POPUP_DATA': {
                    const [data, tabs] = await Promise.all([
                        chrome.storage.local.get(['scripts', 'theme', 'extensionEnabled']),
                        chrome.tabs.query({ active: true, currentWindow: true })
                    ]);
                    const currentUrl = tabs[0]?.url;
                    const scripts: PopupScript[] = [];
                    if (currentUrl && isValidHttpUrl(currentUrl) && Array.isArray(data.scripts)) {
                        for (const script of data.scripts as Script[]) {
                            const metadata = parseMetadata(script.code);
                            if (!isMetadataMatchingUrl(metadata, currentUrl)) continue;
                            const links = script as Script & { updateUrl?: string; downloadUrl?: string };
                            scripts.push({
                                id: script.id,
                                name: script.name,
                                enabled: script.enabled,
                                hasUpdateUrl: !!(links.updateUrl || links.downloadUrl || script.sourceUrl || metadata.updateURL || metadata.downloadURL || metadata.installURL || metadata.source)
                            });
                        }
                    }
                    result = {
                        theme: data.theme,
                        extensionEnabled: data.extensionEnabled,
                        currentUrl: currentUrl && isValidHttpUrl(currentUrl) ? currentUrl : undefined,
                        scripts
                    };
                    break;
                }
                case 'UPDATE_THEME':
                    await chrome.storage.local.set({ theme: typedData.payload });
                    break;
                case 'UPDATE_LOCALE':
                    await chrome.storage.local.set({ locale: typedData.payload });
                    break;
                case 'TOGGLE_GLOBAL':
                    await chrome.storage.local.set({ extensionEnabled: typedData.payload });
                    break;
                case 'UPDATE_BACKUP_SETTINGS':
                    await chrome.storage.local.set(typedData.payload);
                    break;
                case 'GET_APP_INFO':
                    result = { version: chrome.runtime.getManifest().version };
                    break;
                case 'UPDATE_SCRIPTS':
                    await chrome.storage.local.set({ scripts: typedData.payload });
                    break;
                case 'RESTORE_SCRIPTS':
                    // The marker lets the background worker skip writing the
                    // source folder while a restore is being applied.
                    await chrome.storage.local.set({ scripts: typedData.payload.map(script => ({ ...script, token: crypto.randomUUID() })), backupRestoreMarker: crypto.randomUUID() });
                    break;
                case 'TOGGLE_SCRIPT':
                    // We need to forward this to background
                    await sendBackground({ type: 'TOGGLE_SCRIPT', scriptId: typedData.payload.scriptId, enabled: typedData.payload.enabled });
                    break;
                case 'DELETE_SCRIPT':
                    await sendBackground({ type: 'DELETE_SCRIPT', scriptId: typedData.payload.scriptId });
                    break;
                case 'SAVE_SCRIPT':
                    await sendBackground({ type: 'SAVE_SCRIPT', script: typedData.payload });
                    break;
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
                        isAllowed = allowedHosts.some(host => urlObj.hostname === host || urlObj.hostname.endsWith('.' + host));
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
                case 'START_UPDATE_FLOW':
                    await chrome.runtime.sendMessage({ type: 'START_UPDATE_FLOW', scriptId: typedData.payload.scriptId });
                    break;
                case 'GET_PENDING_INSTALL': {
                    const key = `pending_install_${typedData.payload.id}`;
                    const data = await chrome.storage.local.get(key);
                    result = data[key];
                    break;
                }
                case 'CLEAR_PENDING_INSTALL': {
                    const key = `pending_install_${typedData.payload.id}`;
                    await chrome.storage.local.remove(key);
                    break;
                }
                case 'SELECT_BACKUP_DIR':
                    result = await handleSelectBackupDir();
                    break;
                case 'GET_BACKUP_DIR_NAME':
                    result = await handleGetBackupDirName();
                    break;
                case 'RUN_BACKUP':
                    // payload: { scripts, version }
                    result = await handleRunBackup(typedData.payload.scripts, typedData.payload.version, typedData.payload.repairMissing);
                    break;
                case 'RUN_RESTORE':
                    // payload: { scripts }
                    result = await handleRunRestore(typedData.payload.scripts);
                    break;
                case 'ACK_FOLDER_RESTORE':
                    await handleAcknowledgeRestore(typedData.payload.sourceFingerprint);
                    break;
                case 'VERIFY_FOLDER_RESTORE':
                    await handleVerifyRestore(typedData.payload.sourceFingerprint);
                    break;
                case 'CHECK_USER_SCRIPTS_PERMISSION':
                    result = await isUserScriptsAvailable();
                    break;
                case 'REQUEST_USER_SCRIPTS_PERMISSION':
                    // Must be called from a user gesture (clicking the button in iframe -> postMessage -> here)
                    // postMessage handling usually counts as user gesture if immediate.
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
                            // Fallback for some contexts or if queried purely
                            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                            if (activeTab && activeTab.id) {
                                await chrome.tabs.remove(activeTab.id);
                            } else {
                                window.close();
                            }
                        }
                    } catch (e) {
                        console.error('Failed to close tab via bridge', e);
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
                    error = `Unknown action type: ${type}`;
            }
        } catch (e: unknown) {
            error = (e as Error).message || 'Unknown error';
        }

        if (event.source && (event.source as WindowProxy).postMessage) {
            // Target origin must be '*' because the sandboxed iframe has a null origin
            (event.source as WindowProxy).postMessage({ id, result, error }, '*');
        }
    });

    // Forward storage changes
    chrome.storage.onChanged.addListener((changes, areaName) => {
        const iframe = document.querySelector('iframe');
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({
                type: 'STORAGE_CHANGED',
                changes,
                areaName
            }, '*');
        }
    });
}
