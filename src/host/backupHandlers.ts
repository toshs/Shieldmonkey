import { saveDirectoryHandle, getDirectoryHandle } from '../utils/backupStorage';
import { acknowledgeRestoredFolder, performBackup, performRestore, verifyRestoredFolder, type RestorePlan } from '../utils/backupManager';
import type { Script } from '../sandbox/options/types';

export async function handleSelectBackupDir(): Promise<string> {
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const sameFolder = await saveDirectoryHandle(handle);
        if (!sameFolder) await chrome.storage.local.remove(['lastBackupTime', 'lastBackupError']);
        return handle.name;
    } catch (e: unknown) {
        if ((e as Error).name === 'AbortError') {
            throw new Error('Selection cancelled');
        }
        throw e;
    }
}

export async function handleGetBackupDirName(): Promise<string | null> {
    const handle = await getDirectoryHandle();
    return handle ? handle.name : null;
}

export async function handleRunBackup(scripts: Script[], version: string, repairMissing = false): Promise<number> {
    return await performBackup(undefined, scripts, version, true, repairMissing);
}

export async function handleRunRestore(scripts: Script[]): Promise<RestorePlan> {
    return await performRestore(undefined, scripts);
}

export async function handleVerifyRestore(sourceFingerprint: string): Promise<void> {
    await verifyRestoredFolder(sourceFingerprint);
}

export async function handleAcknowledgeRestore(sourceFingerprint: string): Promise<void> {
    await acknowledgeRestoredFolder(sourceFingerprint);
}
