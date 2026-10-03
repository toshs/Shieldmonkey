import { saveDirectoryHandle, getDirectoryHandle, verifyPermission } from '../utils/backupStorage';
import { performBackup, performRestore } from '../utils/backupManager';
import { isFileSystemSupported } from '../utils/browserPolyfill';
import type { Script } from '../sandbox/options/types';

export async function handleSelectBackupDir(): Promise<string> {
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await saveDirectoryHandle(handle);
        return handle.name;
    } catch (e: unknown) {
        if ((e as Error).name === 'AbortError') {
            throw new Error('Selection cancelled');
        }
        throw e;
    }
}

export async function handleGetBackupDirStatus(): Promise<{ supported: boolean; name: string | null; permission: PermissionState | null }> {
    if (!isFileSystemSupported()) return { supported: false, name: null, permission: null };
    let handle: FileSystemDirectoryHandle | undefined;
    try {
        handle = await getDirectoryHandle();
    } catch (error) {
        console.warn('Could not read the saved backup folder:', error);
        return { supported: true, name: null, permission: null };
    }
    let permission: PermissionState | null = null;
    if (handle) {
        try {
            permission = await handle.queryPermission({ mode: 'readwrite' });
        } catch (error) {
            console.warn('Could not check backup folder access:', error);
            permission = 'denied';
        }
    }
    return {
        supported: true,
        name: handle?.name ?? null,
        permission,
    };
}

export async function handleRequestBackupDirAccess(): Promise<boolean> {
    const handle = await getDirectoryHandle();
    if (!handle) throw new Error('No backup directory configured.');
    return verifyPermission(handle, true);
}

export async function handleRunBackup(scripts: Script[], version: string): Promise<number> {
    return await performBackup(undefined, scripts, version);
}

export async function handleRunRestore(scripts: Script[]): Promise<{ count: number; mergedScripts: Script[] }> {
    return await performRestore(undefined, scripts);
}
