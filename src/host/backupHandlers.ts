import { saveDirectoryHandle, getDirectoryHandle, verifyPermission } from '../utils/backupStorage';
import {
    initializeWorkspace, listWorkspaceHistory, readWorkspaceHistory, readWorkspaceState,
    resolveWorkspaceConflict, restoreCurrentWorkspace, restoreWorkspaceHistory,
    synchronizeWorkspace,
    type WorkspaceConflict, type WorkspaceResolution,
} from '../utils/workspaceManager';
import { isFileSystemSupported } from '../utils/browserPolyfill';
import type { Script } from '../sandbox/options/types';

let workspaceQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = workspaceQueue.then(work, work);
    workspaceQueue = next.then(() => undefined, () => undefined);
    return next;
}

async function applyLibrary(scripts: Script[], folders: string[]): Promise<void> {
    await chrome.storage.local.set({ scripts, scriptFolders: folders });
    await chrome.runtime.sendMessage({ type: 'RELOAD_SCRIPTS' });
}

async function requireHandle(write = true): Promise<FileSystemDirectoryHandle> {
    const handle = await getDirectoryHandle();
    if (!handle) throw new Error('No workspace folder selected.');
    if (!await verifyPermission(handle, write)) throw new Error('Folder access is required. Grant access in Settings.');
    return handle;
}

async function requireReadyHandle(write = true): Promise<FileSystemDirectoryHandle> {
    const handle = await requireHandle(write);
    const state = await readWorkspaceState(handle);
    if (!state) throw new Error('The selected folder is not a ShieldMonkey workspace.');
    const { workspaceId } = await chrome.storage.local.get('workspaceId');
    if (workspaceId !== state.workspaceId) throw new Error('Restore this workspace from Settings before editing it.');
    return handle;
}

export async function handleSelectBackupDir(): Promise<string> {
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        if (!await verifyPermission(handle, true)) throw new Error('Folder write access is required.');
        const state = await readWorkspaceState(handle);
        if (!state) {
            const data = await chrome.storage.local.get(['scripts', 'scriptFolders']);
            const scripts = Array.isArray(data.scripts) ? data.scripts as Script[] : [];
            const folders = Array.isArray(data.scriptFolders) ? data.scriptFolders as string[] : [];
            const initialized = await initializeWorkspace(handle, scripts, folders);
            await chrome.storage.local.set({
                workspaceId: initialized.workspaceId,
                scripts: initialized.entries.map(entry => ({
                    ...scripts.find(script => script.id === entry.id)!,
                    ...entry.metadata,
                })),
            });
        }
        await saveDirectoryHandle(handle);
        return handle.name;
    } catch (error) {
        if ((error as Error).name === 'AbortError') throw new Error('Selection cancelled');
        throw error;
    }
}

export async function handleGetBackupDirStatus(): Promise<{
    supported: boolean; name: string | null; permission: PermissionState | null;
    needsRestore: boolean; syncError: string | null;
}> {
    if (!isFileSystemSupported()) return { supported: false, name: null, permission: null, needsRestore: false, syncError: null };
    const { workspaceId, workspaceSyncError } = await chrome.storage.local.get(['workspaceId', 'workspaceSyncError']);
    let handle: FileSystemDirectoryHandle | undefined;
    try {
        handle = await getDirectoryHandle();
    } catch (error) {
        console.warn('Could not read the saved workspace folder:', error);
    }
    let permission: PermissionState | null = null;
    let needsRestore = false;
    if (handle) {
        try {
            permission = await handle.queryPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
                const state = await readWorkspaceState(handle);
                needsRestore = !!state && state.workspaceId !== workspaceId;
            }
        } catch (error) {
            console.warn('Could not check workspace folder access:', error);
            permission = 'denied';
        }
    }
    return { supported: true, name: handle?.name ?? null, permission, needsRestore, syncError: typeof workspaceSyncError === 'string' ? workspaceSyncError : null };
}

export async function handleRequestBackupDirAccess(): Promise<boolean> {
    const handle = await getDirectoryHandle();
    if (!handle) throw new Error('No workspace folder selected.');
    return verifyPermission(handle, true);
}

async function scanWorkspaceUnlocked() {
    const handle = await requireReadyHandle();
    const data = await chrome.storage.local.get(['scripts', 'scriptFolders']);
    const scripts = Array.isArray(data.scripts) ? data.scripts as Script[] : [];
    const folders = Array.isArray(data.scriptFolders) ? data.scriptFolders as string[] : [];
    const result = await synchronizeWorkspace(handle, scripts, folders, applyLibrary);
    await chrome.storage.local.set({ workspaceSyncError: result.conflicts.length ? `${result.conflicts.length} file conflict(s) need review.` : null });
    return { conflicts: result.conflicts, changed: result.changed, count: result.scripts.length };
}

export function handleScanWorkspace() {
    return serialize(scanWorkspaceUnlocked);
}

export async function handleRunBackup(_scripts: Script[], _version: string): Promise<number> {
    void _scripts;
    void _version;
    const result = await handleScanWorkspace();
    if (result.conflicts.length) throw new Error(`${result.conflicts.length} file conflict(s) need review on the Scripts page.`);
    return result.count;
}

export function handleRunRestore(_scripts: Script[]): Promise<{ count: number; mergedScripts: Script[] }> {
    void _scripts;
    return serialize(async () => {
    const handle = await requireHandle();
    const data = await chrome.storage.local.get(['scripts', 'scriptFolders']);
    const currentScripts = Array.isArray(data.scripts) ? data.scripts as Script[] : [];
    const folders = Array.isArray(data.scriptFolders) ? data.scriptFolders as string[] : [];
    const count = await restoreCurrentWorkspace(handle, currentScripts, folders, applyLibrary);
    const state = await readWorkspaceState(handle);
    await chrome.storage.local.set({ workspaceId: state!.workspaceId, workspaceSyncError: null });
    const restored = await chrome.storage.local.get('scripts');
    return { count, mergedScripts: restored.scripts as Script[] };
    });
}

export function handleResolveWorkspaceConflict(conflict: WorkspaceConflict, resolution: WorkspaceResolution): Promise<void> {
    return serialize(async () => {
    const handle = await requireReadyHandle();
    const data = await chrome.storage.local.get(['scripts', 'scriptFolders']);
    await resolveWorkspaceConflict(
        handle, conflict, resolution,
        Array.isArray(data.scripts) ? data.scripts as Script[] : [],
        Array.isArray(data.scriptFolders) ? data.scriptFolders as string[] : [],
        applyLibrary,
    );
    });
}

export async function handleListWorkspaceHistory() {
    return listWorkspaceHistory(await requireReadyHandle(false));
}

export async function handleReadWorkspaceHistory(name: string) {
    return readWorkspaceHistory(await requireReadyHandle(false), name);
}

export function handleRestoreWorkspaceHistory(name: string, scriptId?: string): Promise<number> {
    return serialize(async () => {
    const handle = await requireReadyHandle();
    const data = await chrome.storage.local.get(['scripts', 'scriptFolders']);
    return restoreWorkspaceHistory(
        handle, name, scriptId,
        Array.isArray(data.scripts) ? data.scripts as Script[] : [],
        Array.isArray(data.scriptFolders) ? data.scriptFolders as string[] : [],
        applyLibrary,
    );
    });
}
