import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { verifyPermission } from '../../src/utils/backupStorage';
import {
    hashCode, initializeWorkspace, listWorkspaceHistory, readWorkspaceState,
    reconcileWorkspace, resolveWorkspaceConflict, restoreWorkspaceHistory, synchronizeWorkspace,
    type WorkspaceState,
} from '../../src/utils/workspaceManager';
import type { Script } from '../../src/sandbox/options/types';

beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }); });

const code = (name: string, body = 'console.log(1)') =>
    `// ==UserScript==\n// @name ${name}\n// @namespace demo\n// ==/UserScript==\n${body}`;
const script = (id: string, name: string, body?: string, folderPath = ''): Script =>
    ({ id, name, namespace: 'demo', code: code(name, body), enabled: true, folderPath });

class FakeFile {
    kind = 'file' as const;
    failWrite = false;
    constructor(public name: string, public content = '') {}
    async getFile() { return new Blob([this.content]); }
    async createWritable() {
        if (this.failWrite) throw new DOMException('Write failed', 'NotAllowedError');
        let next = '';
        return {
            write: async (value: string) => { next = value; },
            close: async () => { this.content = next; },
        };
    }
}

class FakeDirectory {
    kind = 'directory' as const;
    children = new Map<string, FakeFile | FakeDirectory>();
    constructor(public name = 'workspace') {}
    async getFileHandle(name: string, options?: { create?: boolean }) {
        const existing = this.children.get(name);
        if (existing instanceof FakeFile) return existing;
        if (existing) throw new DOMException('Wrong kind', 'TypeMismatchError');
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        const file = new FakeFile(name);
        this.children.set(name, file);
        return file;
    }
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const existing = this.children.get(name);
        if (existing instanceof FakeDirectory) return existing;
        if (existing) throw new DOMException('Wrong kind', 'TypeMismatchError');
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        const dir = new FakeDirectory(name);
        this.children.set(name, dir);
        return dir;
    }
    async removeEntry(name: string) {
        const entry = this.children.get(name);
        if (!entry) throw new DOMException('Missing', 'NotFoundError');
        if (entry instanceof FakeDirectory && entry.children.size) throw new DOMException('Not empty', 'InvalidModificationError');
        this.children.delete(name);
    }
    async *entries(): AsyncGenerator<[string, FakeFile | FakeDirectory]> {
        for (const entry of this.children) yield entry;
    }
}

const handle = (directory: FakeDirectory) => directory as unknown as FileSystemDirectoryHandle;
const baseState = async (item: Script, path = 'A.user.js'): Promise<WorkspaceState> => ({
    format: 1, workspaceId: 'workspace-1', folders: [], entries: [{
        id: item.id, path, hash: await hashCode(item.code),
        identity: `demo\u0000${item.name}`,
        metadata: { id: item.id, name: item.name, namespace: 'demo', enabled: true, folderPath: '' },
    }],
});

describe('editable workspace reconciliation', () => {
    it('keeps the internal ID when the file is renamed or moved', async () => {
        const original = script('one', 'A');
        const state = await baseState(original);
        const result = await reconcileWorkspace(state, [original], [], new Map([['Tools/Renamed.user.js', original.code]]), ['Tools']);
        expect(result.conflicts).toEqual([]);
        expect(result.scripts[0].id).toBe('one');
        expect(result.scripts[0].filePath).toBe('Tools/Renamed.user.js');
        expect(result.state.entries[0].path).toBe('Tools/Renamed.user.js');
    });

    it('applies an external edit at the same path, retaining the ID even if metadata changes', async () => {
        const original = script('one', 'A');
        const state = await baseState(original);
        const changed = code('New name', 'console.log(2)');
        const result = await reconcileWorkspace(state, [original], [], new Map([['A.user.js', changed]]), []);
        expect(result.conflicts).toEqual([]);
        expect(result.scripts[0]).toMatchObject({ id: 'one', name: 'New name', code: changed });
    });

    it('requires a decision when app and file code both changed', async () => {
        const original = script('one', 'A');
        const state = await baseState(original);
        const app = { ...original, code: code('A', 'console.log("app")') };
        const file = code('A', 'console.log("file")');
        const result = await reconcileWorkspace(state, [app], [], new Map([['A.user.js', file]]), []);
        expect(result.conflicts[0].kind).toBe('both-edited');
        expect(result.operations).toEqual([]);
    });

    it('does not silently delete a script when its file disappears', async () => {
        const original = script('one', 'A');
        const result = await reconcileWorkspace(await baseState(original), [original], [], new Map(), []);
        expect(result.conflicts[0].kind).toBe('missing-file');
        expect(result.scripts).toHaveLength(1);
    });

    it('holds a changed-name moved file for review', async () => {
        const original = script('one', 'A');
        const result = await reconcileWorkspace(await baseState(original), [original], [], new Map([['B.user.js', code('B')]]), []);
        expect(result.conflicts.map(item => item.kind)).toEqual(['missing-file', 'possible-move']);
        expect(result.scripts).toHaveLength(1);
    });

    it('rejects duplicate metadata from an external edit', async () => {
        const first = script('one', 'A');
        const second = script('two', 'B');
        const state: WorkspaceState = {
            format: 1, workspaceId: 'workspace-1', folders: [],
            entries: [...(await baseState(first, 'A.user.js')).entries, ...(await baseState(second, 'B.user.js')).entries],
        };
        const result = await reconcileWorkspace(state, [first, second], [], new Map([
            ['A.user.js', first.code], ['B.user.js', first.code],
        ]), []);
        expect(result.conflicts.some(item => item.kind === 'duplicate-identity')).toBe(true);
        expect(result.scripts.find(item => item.id === 'two')?.name).toBe('B');
    });

    it('moves an app-managed file into a nested folder without changing its ID', async () => {
        const original = script('one', 'A');
        const moved = { ...original, folderPath: 'Tools/Nested' };
        const result = await reconcileWorkspace(await baseState(original), [moved], ['Tools', 'Tools/Nested'], new Map([['A.user.js', original.code]]), []);
        expect(result.conflicts).toEqual([]);
        expect(result.state.entries[0].path).toBe('Tools/Nested/A.user.js');
        expect(result.operations.map(item => item.kind)).toEqual(['write', 'remove']);
    });
});

describe('workspace files and history', () => {
    it('writes nested files, keeps unlimited snapshots, and restores one script', async () => {
        const root = new FakeDirectory();
        const initial = script('one', 'A', 'console.log(1)', 'Tools');
        await initializeWorkspace(handle(root), [initial], ['Tools']);
        const state = await readWorkspaceState(handle(root));
        expect(state?.entries[0].path).toBe('Tools/A.user.js');
        const scriptsDir = await root.getDirectoryHandle('scripts');
        const toolsDir = await scriptsDir.getDirectoryHandle('Tools');
        const external = await toolsDir.getFileHandle('A.user.js');
        external.content = code('A', 'console.log(2)');
        let stored = [initial];
        await synchronizeWorkspace(handle(root), stored, ['Tools'], async scripts => { stored = scripts; });
        expect(stored[0].code).toContain('console.log(2)');
        const history = await listWorkspaceHistory(handle(root));
        expect(history).toHaveLength(2);
        await restoreWorkspaceHistory(handle(root), history.find(item => item.reason === 'Initial workspace')!.name, 'one', stored, ['Tools'], async scripts => { stored = scripts; });
        expect(stored[0].code).toContain('console.log(1)');
        expect(await listWorkspaceHistory(handle(root))).toHaveLength(4);
    });

    it('rejects a nonempty legacy folder without touching it', async () => {
        const root = new FakeDirectory();
        await root.getFileHandle('shieldmonkey_dump.json', { create: true });
        await expect(initializeWorkspace(handle(root), [], [])).rejects.toThrow('Choose an empty folder');
        expect(root.children.has('shieldmonkey_dump.json')).toBe(true);
        expect(root.children.has('state.json')).toBe(false);
    });

    it('leaves state untouched when writing a changed script fails', async () => {
        const root = new FakeDirectory();
        const initial = script('one', 'A');
        await initializeWorkspace(handle(root), [initial], []);
        const previousState = JSON.stringify(await readWorkspaceState(handle(root)));
        const scriptsDir = await root.getDirectoryHandle('scripts');
        (await scriptsDir.getFileHandle('A.user.js')).failWrite = true;
        const changed = { ...initial, code: code('A', 'console.log(9)') };
        let applied = false;
        await expect(synchronizeWorkspace(handle(root), [changed], [], async () => { applied = true; })).rejects.toThrow('Write failed');
        expect(JSON.stringify(await readWorkspaceState(handle(root)))).toBe(previousState);
        expect(applied).toBe(false);
        expect((await scriptsDir.getFileHandle('A.user.js')).content).toBe(initial.code);
    });

    it('reports a permission denial without writing through', async () => {
        const denied = { queryPermission: async () => 'denied', requestPermission: async () => 'denied' };
        expect(await verifyPermission(denied as unknown as FileSystemDirectoryHandle, true)).toBe(false);
    });

    it('keeps both versions in history before resolving an edit conflict', async () => {
        const root = new FakeDirectory();
        const original = script('one', 'A');
        await initializeWorkspace(handle(root), [original], []);
        const scriptsDir = await root.getDirectoryHandle('scripts');
        const file = await scriptsDir.getFileHandle('A.user.js');
        file.content = code('A', 'console.log("file")');
        const app = { ...original, code: code('A', 'console.log("app")') };
        const result = await synchronizeWorkspace(handle(root), [app], [], async () => {});
        expect(result.conflicts[0].kind).toBe('both-edited');
        let stored = [app];
        await resolveWorkspaceConflict(handle(root), result.conflicts[0], 'app', stored, [], async scripts => { stored = scripts; });
        expect(file.content).toBe(app.code);
        expect((await readWorkspaceState(handle(root)))?.entries[0].hash).toBe(await hashCode(app.code));
        const history = await listWorkspaceHistory(handle(root));
        expect(history.map(item => item.reason)).toContain('File version before conflict resolution');
    });

    it('requires confirmation before removing a script with a deleted file', async () => {
        const root = new FakeDirectory();
        const original = script('one', 'A');
        await initializeWorkspace(handle(root), [original], []);
        const scriptsDir = await root.getDirectoryHandle('scripts');
        await scriptsDir.removeEntry('A.user.js');
        const result = await synchronizeWorkspace(handle(root), [original], [], async () => {});
        expect(result.conflicts[0].kind).toBe('missing-file');
        let stored = [original];
        await resolveWorkspaceConflict(handle(root), result.conflicts[0], 'file', stored, [], async scripts => { stored = scripts; });
        expect(stored).toHaveLength(0);
        expect((await readWorkspaceState(handle(root)))?.entries).toHaveLength(0);
    });

    it('removes an unrecognized renamed file when the app version wins', async () => {
        const root = new FakeDirectory();
        const original = script('one', 'A');
        await initializeWorkspace(handle(root), [original], []);
        const scriptsDir = await root.getDirectoryHandle('scripts');
        await scriptsDir.removeEntry('A.user.js');
        (await scriptsDir.getFileHandle('Renamed.user.js', { create: true })).content = code('Changed name');
        const result = await synchronizeWorkspace(handle(root), [original], [], async () => {});
        const candidate = result.conflicts.find(conflict => conflict.kind === 'possible-move');
        expect(candidate).toBeDefined();
        await resolveWorkspaceConflict(handle(root), candidate!, 'app', [original], [], async () => {});
        expect((await scriptsDir.getFileHandle('A.user.js')).content).toBe(original.code);
        await expect(scriptsDir.getFileHandle('Renamed.user.js')).rejects.toThrow();
        const after = await synchronizeWorkspace(handle(root), [original], [], async () => {});
        expect(after.conflicts).toEqual([]);
    });
});
