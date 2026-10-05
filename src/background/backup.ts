import { performBackup, serializeBackup } from '../utils/backupManager';
import type { Script } from '../sandbox/options/types';
import { isFirefox, isMobile } from '../utils/browserPolyfill';

let running = false;
let dirty = false;

async function downloadMobileBackup(scripts: Script[], version: string): Promise<void> {
    const data = serializeBackup(scripts, version);
    const filename = 'shieldmonkey_autobackup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(data);
    const id = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs: false }, downloadId =>
            chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message))
                : downloadId === undefined ? reject(new Error('Download did not start')) : resolve(downloadId));
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
            if (delta.id !== id) return;
            if (delta.error?.current) finish(new Error(delta.error.current));
            else if (delta.state?.current === 'complete') finish();
        };
        chrome.downloads.onChanged.addListener(onChanged);
        chrome.downloads.search({ id }, items => {
            if (chrome.runtime.lastError) finish(new Error(chrome.runtime.lastError.message));
            else if (items[0]?.state === 'complete') finish();
            else if (items[0]?.state === 'interrupted') finish(new Error(items[0].error || 'Download interrupted'));
        });
    });
}

async function backUpCurrentScripts(): Promise<void> {
    const { autoBackup, autoBackupMode, scripts } = await chrome.storage.local.get(['autoBackup', 'autoBackupMode', 'scripts']);
    if (!autoBackup || !Array.isArray(scripts)) return;
    try {
        const version = chrome.runtime.getManifest().version;
        if (autoBackupMode === 'download' || (!autoBackupMode && (isMobile() || isFirefox()))) await downloadMobileBackup(scripts as Script[], version);
        else await performBackup(undefined, scripts as Script[], version, false);
        await chrome.storage.local.set({ lastBackupTime: new Date().toISOString() });
        await chrome.storage.local.remove('lastBackupError');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await chrome.storage.local.set({ lastBackupError: message });
        console.error('Automatic backup failed:', error);
    }
}

function scheduleBackup(): void {
    dirty = true;
    if (running) return;
    running = true;
    void (async () => {
        try {
            while (dirty) {
                dirty = false;
                await backUpCurrentScripts();
            }
        } finally {
            running = false;
        }
    })();
}

export function setupAutoBackup(): void {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || changes.backupRestoreMarker) return;
        if (changes.scripts || changes.autoBackup?.newValue === true || changes.autoBackupMode) scheduleBackup();
    });
    chrome.runtime.onStartup.addListener(scheduleBackup);
}
