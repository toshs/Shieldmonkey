import { openDB } from 'idb';

const DB_NAME = 'shieldmonkey-db';
const STORE_NAME = 'settings';
const HANDLE_KEY = 'backup-directory-handle';
const FINGERPRINT_KEY = 'backup-directory-fingerprint';

// Type definition for test environment
interface GlobalWithMock {
    __mockBackupDirectoryHandle?: FileSystemDirectoryHandle;
}

const global = globalThis as typeof globalThis & GlobalWithMock;
let sessionHandle: FileSystemDirectoryHandle | undefined;
const restoredPermissions = new WeakMap<FileSystemDirectoryHandle, Map<string, Promise<PermissionState>>>();

export async function initDB() {
    return openDB(DB_NAME, 1, {
        upgrade(db) {
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        },
    });
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<boolean> {
    // Skip IndexedDB in test/mock environment
    if (global.__mockBackupDirectoryHandle) {
        return false;
    }
    const db = await initDB();
    const previous = await db.get(STORE_NAME, HANDLE_KEY) as FileSystemDirectoryHandle | undefined;
    let sameFolder = false;
    if (previous && typeof handle.isSameEntry === 'function') {
        try {
            sameFolder = await handle.isSameEntry(previous);
        } catch { /* Fall back to a fresh safety baseline. */ }
    }
    await db.put(STORE_NAME, handle, HANDLE_KEY);
    sessionHandle = handle;
    // A fingerprint belongs to one folder. Selecting another folder must not
    // authorize overwriting a snapshot that was made elsewhere.
    if (!sameFolder) await db.delete(STORE_NAME, FINGERPRINT_KEY);
    return sameFolder;
}

export async function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | undefined> {
    // Return mock handle in test environment
    if (global.__mockBackupDirectoryHandle) {
        return global.__mockBackupDirectoryHandle;
    }
    const db = await initDB();
    const stored = await db.get(STORE_NAME, HANDLE_KEY) as FileSystemDirectoryHandle | undefined;
    if (stored && sessionHandle && typeof stored.isSameEntry === 'function') {
        try {
            if (await stored.isSameEntry(sessionHandle)) return sessionHandle;
        } catch { /* A moved or revoked folder must be checked again. */ }
    }
    sessionHandle = stored;
    return stored;
}

export async function getBackupFingerprint(): Promise<string | undefined> {
    if (global.__mockBackupDirectoryHandle) return undefined;
    const db = await initDB();
    return db.get(STORE_NAME, FINGERPRINT_KEY);
}

export async function saveBackupFingerprint(fingerprint: string): Promise<void> {
    if (global.__mockBackupDirectoryHandle) return;
    const db = await initDB();
    await db.put(STORE_NAME, fingerprint, FINGERPRINT_KEY);
}

export async function verifyPermission(handle: FileSystemDirectoryHandle, readWrite: boolean = false, allowPrompt: boolean = true): Promise<boolean> {
    const options: FileSystemHandlePermissionDescriptor = { mode: readWrite ? 'readwrite' : 'read' };

    if ((await handle.queryPermission(options)) === 'granted') {
        return true;
    }

    if (allowPrompt && (await handle.requestPermission(options)) === 'granted') {
        return true;
    }

    return false;
}

// A persisted grant can report "prompt" until requestPermission reactivates it.
// Try once without user activation: a session-only grant must still be confirmed
// by an explicit click. Do not request access from workers or hidden documents.
export async function restoreDirectoryPermission(handle: FileSystemDirectoryHandle, readWrite = true): Promise<PermissionState> {
    const options: FileSystemHandlePermissionDescriptor = { mode: readWrite ? 'readwrite' : 'read' };
    const state = await handle.queryPermission(options);
    if (state !== 'prompt' || typeof document === 'undefined' || document.visibilityState !== 'visible'
        || navigator.userActivation?.isActive !== false) return state;
    let attempts = restoredPermissions.get(handle);
    if (!attempts) {
        attempts = new Map();
        restoredPermissions.set(handle, attempts);
    }
    let attempt = attempts.get(options.mode!);
    if (!attempt) {
        attempt = handle.requestPermission(options).catch(() => state);
        attempts.set(options.mode!, attempt);
    }
    return attempt;
}

// Settings loads the handle before showing its reconnect button. Request access
// synchronously on that handle, preserving the click's transient activation.
export function requestSavedDirectoryAccess(): Promise<boolean> {
    const request = (handle: FileSystemDirectoryHandle | undefined) => {
        if (!handle) throw new Error('No workspace folder selected.');
        return handle.requestPermission({ mode: 'readwrite' }).then(state => state === 'granted');
    };
    const handle = global.__mockBackupDirectoryHandle ?? sessionHandle;
    return handle ? request(handle) : getDirectoryHandle().then(request);
}
