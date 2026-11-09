import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDirectoryHandle, requestSavedDirectoryAccess, restoreDirectoryPermission } from '../../src/utils/backupStorage';

const db = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('idb', () => ({ openDB: vi.fn(async () => db) }));
const handle = (state: PermissionState = 'prompt') => ({
    name: 'workspace', kind: 'directory',
    queryPermission: vi.fn(async () => state),
    requestPermission: vi.fn(async () => 'granted' as PermissionState),
    isSameEntry: vi.fn(async () => true),
});
const asHandle = (value: ReturnType<typeof handle>) => value as unknown as FileSystemDirectoryHandle;

beforeEach(() => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('navigator', { userActivation: { isActive: false } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('saved workspace permissions', () => {
    it('reactivates a persistent grant instead of treating prompt as a lost connection', async () => {
        const folder = handle();
        expect(await restoreDirectoryPermission(asHandle(folder))).toBe('granted');
        expect(folder.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('leaves a temporary grant disconnected without retrying its rejected request', async () => {
        const folder = handle();
        folder.requestPermission.mockRejectedValue(new DOMException('Click required', 'SecurityError'));
        expect(await restoreDirectoryPermission(asHandle(folder))).toBe('prompt');
        expect(await restoreDirectoryPermission(asHandle(folder))).toBe('prompt');
        expect(folder.requestPermission).toHaveBeenCalledTimes(1);
    });

    it.each(['denied', 'granted'] as const)('does not request an already %s grant', async state => {
        const folder = handle(state);
        expect(await restoreDirectoryPermission(asHandle(folder))).toBe(state);
        expect(folder.requestPermission).not.toHaveBeenCalled();
    });

    it('does not use a background document or an unrelated click to display a prompt', async () => {
        const folder = handle();
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        expect(await restoreDirectoryPermission(asHandle(folder))).toBe('prompt');
        vi.stubGlobal('document', { visibilityState: 'visible' });
        vi.stubGlobal('navigator', { userActivation: { isActive: true } });
        expect(await restoreDirectoryPermission(asHandle(folder))).toBe('prompt');
        expect(folder.requestPermission).not.toHaveBeenCalled();
    });

    it('requests the remembered handle inside the reconnect click and notices another tab changing folders', async () => {
        const first = handle('denied');
        db.get.mockResolvedValue(asHandle(first));
        await getDirectoryHandle();
        const clone = handle('denied');
        db.get.mockResolvedValue(asHandle(clone));
        expect(await getDirectoryHandle()).toBe(first);
        const reconnected = requestSavedDirectoryAccess();
        expect(first.requestPermission).toHaveBeenCalledTimes(1); // Before any await / IndexedDB task.
        expect(await reconnected).toBe(true);
        const other = handle();
        other.isSameEntry.mockResolvedValue(false);
        db.get.mockResolvedValue(asHandle(other));
        expect(await getDirectoryHandle()).toBe(other);
        await requestSavedDirectoryAccess();
        expect(other.requestPermission).toHaveBeenCalledTimes(1);
    });
});
