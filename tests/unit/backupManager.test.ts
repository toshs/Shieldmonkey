import { test, expect, vi } from 'vitest';
import type { Script } from '../../src/sandbox/options/types';
import { acknowledgeRestoredFolder, parseBackup, performBackup, performRestore, planRestore, serializeBackup, verifyRestoredFolder } from '../../src/utils/backupManager';

let fingerprint: string | undefined;
vi.mock('../../src/utils/backupStorage', () => ({
    getBackupFingerprint: async () => fingerprint,
    saveBackupFingerprint: async (value: string) => { fingerprint = value; },
    getDirectoryHandle: async () => undefined,
    verifyPermission: async () => true
}));

class MemoryDirectory {
    files = new Map<string, string>();
    directories = new Map<string, MemoryDirectory>();

    async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!this.files.has(name) && !options?.create) throw Object.assign(new Error('Missing file'), { name: 'NotFoundError' });
        return {
            getFile: async () => new Blob([this.files.get(name) ?? '']),
            createWritable: async () => {
                let content = '';
                return {
                    write: async (value: string) => { content = value; },
                    close: async () => { this.files.set(name, content); }
                };
            }
        };
    }

    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        if (!this.directories.has(name)) {
            if (!options?.create) throw Object.assign(new Error('Missing directory'), { name: 'NotFoundError' });
            this.directories.set(name, new MemoryDirectory());
        }
        return this.directories.get(name)!;
    }

    async removeEntry(name: string) { this.files.delete(name); }
}

const asHandle = (directory: MemoryDirectory) => directory as unknown as FileSystemDirectoryHandle;
const makeScript = (id: string, name: string, code: string): Script => ({ id, name, code, enabled: true, grantedPermissions: [] });

test.beforeEach(() => { fingerprint = undefined; });

test('legacy backup is accepted, malformed scripts and duplicate IDs are rejected', () => {
    const script = makeScript('one', 'One', '// code');
    expect(parseBackup(JSON.stringify({ scripts: [script] })).scripts).toEqual([script]);
    expect(() => parseBackup('{')).toThrow('Invalid backup JSON');
    expect(() => parseBackup(JSON.stringify({ scripts: [{ id: 'x', name: 'X' }] }))).toThrow('Invalid script');
    expect(() => parseBackup(JSON.stringify({ scripts: [script, script] }))).toThrow('Duplicate script ID');
    expect(() => parseBackup(JSON.stringify({ scripts: [{ ...script, grantedPermissions: [4] }] }))).toThrow('Invalid permissions');
});

test('backup excludes transient editor state and script capability tokens', () => {
    const script = { ...makeScript('one', 'One', 'code'), token: 'secret', lastSavedCode: 'old code' };
    const data = JSON.parse(serializeBackup([script], '1.0'));
    expect(data.scripts[0]).not.toHaveProperty('token');
    expect(data.scripts[0]).not.toHaveProperty('lastSavedCode');
});

test('restore preview counts changes and supports merge or replace', () => {
    const current = [makeScript('a', 'A', 'old'), makeScript('local', 'Local', 'local')];
    const backup = [makeScript('a', 'A', 'new'), makeScript('new', 'New', 'new')];
    expect(planRestore(backup, current)).toMatchObject({ added: 1, updated: 1, unchanged: 0, localOnly: 1 });
    expect(planRestore(backup, current).mergedScripts.map(script => script.id)).toEqual(['a', 'local', 'new']);
    expect(planRestore(backup, current, 'replace').mergedScripts.map(script => script.id)).toEqual(['a', 'new']);
});

test('folder backup keeps a recoverable JSON history and removes only managed stale files', async () => {
    const directory = new MemoryDirectory();
    const handle = asHandle(directory);
    const original = makeScript('id/a', '日本語スクリプト', '// original');
    await performBackup(handle, [original], '1.0');
    const files = await directory.getDirectoryHandle('scripts');
    const originalName = [...files.files.keys()][0];
    expect(originalName).toContain('日本語スクリプト');
    expect(directory.files.has('shieldmonkey_dump.json')).toBe(true);

    const updated = { ...original, name: '名前変更', code: '// updated' };
    await performBackup(handle, [updated], '1.0');
    expect(files.files.has(originalName)).toBe(false);
    expect([...files.files.keys()][0]).toContain('名前変更');
    const history = await directory.getDirectoryHandle('history');
    expect([...history.files.values()].some(text => parseBackup(text).scripts[0].code === '// original')).toBe(true);
    await performBackup(handle, [], '1.0');
    expect(files.files.size).toBe(0);
    expect(parseBackup(directory.files.get('shieldmonkey_dump.json')!).scripts).toEqual([]);
});

test('edited script files are protected from overwrite and can be restored by ID', async () => {
    const directory = new MemoryDirectory();
    const handle = asHandle(directory);
    const script = makeScript('one', 'Original', '// ==UserScript==\n// @name Original\n// ==/UserScript==\nold');
    await performBackup(handle, [script], '1.0');
    const files = await directory.getDirectoryHandle('scripts');
    const fileName = [...files.files.keys()][0];
    files.files.set(fileName, '// ==UserScript==\n// @name Edited\n// ==/UserScript==\nnew');
    const dumpBefore = directory.files.get('shieldmonkey_dump.json');
    await expect(performBackup(handle, [{ ...script, code: 'local change' }], '1.0')).rejects.toThrow('changed outside ShieldMonkey');
    expect(directory.files.get('shieldmonkey_dump.json')).toBe(dumpBefore);

    const preview = await performRestore(handle, [script]);
    expect(preview.fileEdits).toBe(1);
    expect(preview.backupScripts[0]).toMatchObject({ id: 'one', name: 'Edited', code: files.files.get(fileName) });
    await acknowledgeRestoredFolder(preview.sourceFingerprint!, handle);
    await performBackup(handle, preview.mergedScripts, '1.0');
    expect(parseBackup(directory.files.get('shieldmonkey_dump.json')!).scripts[0].code).toContain('new');
});

test('folder restore revision rejects changes made after the preview', async () => {
    const directory = new MemoryDirectory();
    const handle = asHandle(directory);
    const script = makeScript('one', 'One', 'old');
    await performBackup(handle, [script], '1.0');
    const preview = await performRestore(handle, []);
    directory.files.set('shieldmonkey_dump.json', JSON.stringify({ scripts: [makeScript('two', 'Two', 'new')] }));
    await expect(verifyRestoredFolder(preview.sourceFingerprint!, handle)).rejects.toThrow('changed during the restore preview');
});

test('missing editable copy falls back to JSON and explicit restore recreates it', async () => {
    const directory = new MemoryDirectory();
    const handle = asHandle(directory);
    const script = makeScript('one', 'One', 'safe copy');
    await performBackup(handle, [script], '1.0');
    const files = await directory.getDirectoryHandle('scripts');
    const name = [...files.files.keys()][0];
    files.files.delete(name);
    const preview = await performRestore(handle, []);
    expect(preview.missingFiles).toBe(1);
    expect(preview.backupScripts[0].code).toBe('safe copy');
    await acknowledgeRestoredFolder(preview.sourceFingerprint!, handle);
    await performBackup(handle, preview.mergedScripts, '1.0', true, true);
    expect(files.files.get(name)).toBe('safe copy');
});

test('externally changed JSON is never overwritten by automatic sync', async () => {
    const directory = new MemoryDirectory();
    const handle = asHandle(directory);
    const script = makeScript('one', 'One', 'old');
    await performBackup(handle, [script], '1.0');
    const foreign = JSON.stringify({ scripts: [makeScript('two', 'Two', 'other')] });
    directory.files.set('shieldmonkey_dump.json', foreign);
    await expect(performBackup(handle, [makeScript('one', 'One', 'new')], '1.0')).rejects.toThrow('changed outside ShieldMonkey');
    expect(directory.files.get('shieldmonkey_dump.json')).toBe(foreign);
});
