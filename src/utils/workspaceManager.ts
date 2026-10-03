import { parseMetadata } from './metadataParser';
import type { Script } from '../sandbox/options/types';

export interface WorkspaceEntry {
    id: string;
    path: string;
    hash: string;
    identity: string;
    metadata: Omit<Script, 'code'>;
}

export interface WorkspaceState {
    format: 1;
    workspaceId: string;
    folders: string[];
    entries: WorkspaceEntry[];
}

export type WorkspaceConflictKind = 'both-edited' | 'missing-file' | 'ambiguous-move' | 'possible-move' | 'duplicate-identity' | 'invalid-file' | 'changed-before-delete';

export interface WorkspaceConflict {
    kind: WorkspaceConflictKind;
    scriptId?: string;
    path: string;
    message: string;
    appCode?: string;
    fileCode?: string;
    appHash?: string;
    fileHash?: string;
}

export type WorkspaceResolution = 'app' | 'file';

export interface WorkspaceSnapshot {
    format: 1;
    timestamp: string;
    reason: string;
    folders: string[];
    scripts: Script[];
}

export interface WorkspaceHistoryItem {
    name: string;
    timestamp: string;
    reason: string;
    count: number;
}

interface FileOperation {
    kind: 'write' | 'remove';
    path: string;
    code?: string;
}

export interface Reconciliation {
    scripts: Script[];
    folders: string[];
    state: WorkspaceState;
    conflicts: WorkspaceConflict[];
    operations: FileOperation[];
    changed: boolean;
}

export function normalizeFolder(path = ''): string {
    const parts = path.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..' || [...part].some(char => char === '\\' || char.charCodeAt(0) < 32))) {
        throw new Error('Invalid folder path.');
    }
    return parts.join('/');
}

function validatePath(path: string): string {
    const parts = path.split('/');
    if (parts.length === 0 || parts.some(part => !part || part === '.' || part === '..' || [...part].some(char => char === '\\' || char.charCodeAt(0) < 32))) {
        throw new Error('Invalid script path.');
    }
    return path;
}

function folderOf(path: string): string {
    return path.split('/').slice(0, -1).join('/');
}

export function scriptIdentity(code: string): string | undefined {
    if (!/\/\/\s*==UserScript==/.test(code)) return undefined;
    const block = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
    if (!block || !/^\s*\/\/\s*@name\s+\S/m.test(block[1])) return undefined;
    const metadata = parseMetadata(code);
    return `${metadata.namespace || ''}\u0000${metadata.name}`;
}

export async function hashCode(code: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function entryFor(script: Script, path: string, hash: string): WorkspaceEntry {
    const { code: _code, lastSavedCode: _lastSavedCode, ...metadata } = script;
    void _code;
    void _lastSavedCode;
    return { id: script.id, path, hash, identity: scriptIdentity(script.code) || '', metadata };
}

function pathForNewScript(script: Script, occupied: Set<string>): string {
    const folder = normalizeFolder(script.folderPath);
    const base = [...(parseMetadata(script.code).name || script.name || 'Script')]
        .map(char => char.charCodeAt(0) < 32 ? '_' : char).join('')
        .replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || 'Script';
    let number = 1;
    let path = `${folder ? folder + '/' : ''}${base}.user.js`;
    while (occupied.has(path)) {
        number++;
        path = `${folder ? folder + '/' : ''}${base} (${number}).user.js`;
    }
    occupied.add(path);
    return path;
}

function withFileMetadata(script: Script, code: string, path: string): Script {
    const metadata = parseMetadata(code);
    return {
        ...script,
        code,
        name: metadata.name,
        namespace: metadata.namespace || '',
        grantedPermissions: metadata.grant,
        token: crypto.randomUUID(),
        folderPath: folderOf(path),
        filePath: path,
        updateDate: Date.now(),
    };
}

function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}

export async function reconcileWorkspace(
    state: WorkspaceState,
    appScripts: Script[],
    appFolders: string[],
    files: Map<string, string>,
    diskFolders: string[],
): Promise<Reconciliation> {
    const scripts = appScripts.map(script => ({ ...script }));
    for (const script of scripts) {
        if (!script.token) script.token = crypto.randomUUID();
    }
    const appById = new Map(scripts.map(script => [script.id, script]));
    const fileHashes = new Map<string, string>();
    for (const [path, code] of files) fileHashes.set(path, await hashCode(code));
    const claimed = new Set<string>();
    const occupied = new Set(files.keys());
    const entries: WorkspaceEntry[] = [];
    const operations: FileOperation[] = [];
    const conflicts: WorkspaceConflict[] = [];
    const stateIds = new Set(state.entries.map(entry => entry.id));
    const statePaths = new Set(state.entries.map(entry => entry.path));
    const identityToPaths = new Map<string, string[]>();
    for (const [path, code] of files) {
        const identity = scriptIdentity(code);
        if (identity) identityToPaths.set(identity, [...(identityToPaths.get(identity) || []), path]);
    }
    const duplicateIds = new Set<string>();
    for (const script of scripts) {
        const identity = scriptIdentity(script.code);
        if (identity && scripts.filter(item => scriptIdentity(item.code) === identity).length > 1) duplicateIds.add(script.id);
    }

    for (const entry of state.entries) {
        const app = appById.get(entry.id);
        if (duplicateIds.has(entry.id)) {
            conflicts.push({ kind: 'duplicate-identity', scriptId: entry.id, path: entry.path, message: 'Multiple scripts have the same @name and @namespace.', appCode: app?.code });
            entries.push(entry);
            continue;
        }

        let path = entry.path;
        let file = files.get(path);
        let externallyMoved = false;
        if (file === undefined) {
            const candidates = (identityToPaths.get(entry.identity) || []).filter(candidate => !claimed.has(candidate) && !statePaths.has(candidate));
            if (candidates.length === 1) {
                path = candidates[0];
                file = files.get(path);
                externallyMoved = true;
            } else if (candidates.length > 1) {
                conflicts.push({ kind: 'ambiguous-move', scriptId: entry.id, path: entry.path, message: 'Several files match this script. Select one after resolving duplicate metadata.', appCode: app?.code });
                entries.push(entry);
                continue;
            }
        }

        if (!app) {
            if (file !== undefined && fileHashes.get(path) !== entry.hash) {
                conflicts.push({ kind: 'changed-before-delete', scriptId: entry.id, path, message: 'This file changed after the script was deleted in ShieldMonkey.', fileCode: file, fileHash: fileHashes.get(path) });
                entries.push(entry);
            } else if (file !== undefined) {
                claimed.add(path);
                operations.push({ kind: 'remove', path });
            }
            continue;
        }

        if (file === undefined) {
            conflicts.push({ kind: 'missing-file', scriptId: entry.id, path: entry.path, message: 'The script file was removed outside ShieldMonkey.', appCode: app.code, appHash: await hashCode(app.code) });
            entries.push(entry);
            continue;
        }
        claimed.add(path);
        const diskHash = fileHashes.get(path)!;
        const appHash = await hashCode(app.code);
        const diskChanged = diskHash !== entry.hash;
        const appChanged = appHash !== entry.hash;
        if (diskChanged && appChanged && diskHash !== appHash) {
            conflicts.push({ kind: 'both-edited', scriptId: entry.id, path, message: 'The app and file both changed.', appCode: app.code, fileCode: file, appHash, fileHash: diskHash });
            entries.push(entry);
            continue;
        }
        if (externallyMoved && normalizeFolder(app.folderPath) !== folderOf(entry.path) && normalizeFolder(app.folderPath) !== folderOf(path)) {
            conflicts.push({ kind: 'ambiguous-move', scriptId: entry.id, path, message: 'The folder changed in both places.', appCode: app.code, fileCode: file, appHash, fileHash: diskHash });
            entries.push(entry);
            continue;
        }

        let next = app;
        if (diskChanged && !appChanged) {
            const identity = scriptIdentity(file);
            if (!identity) {
                conflicts.push({ kind: 'invalid-file', scriptId: entry.id, path, message: 'The file has no valid @name metadata.', appCode: app.code, fileCode: file, fileHash: diskHash });
                entries.push(entry);
                continue;
            }
            if (scripts.some(script => script.id !== app.id && scriptIdentity(script.code) === identity) ||
                (identityToPaths.get(identity) || []).some(candidate => candidate !== path)) {
                conflicts.push({ kind: 'duplicate-identity', scriptId: entry.id, path, message: 'The edited file now has the same @name and @namespace as another script.', appCode: app.code, fileCode: file, fileHash: diskHash });
                entries.push(entry);
                continue;
            }
            next = withFileMetadata(app, file, path);
            scripts[scripts.findIndex(script => script.id === app.id)] = next;
        }
        const desiredFolder = normalizeFolder(app.folderPath);
        const movedByApp = desiredFolder !== folderOf(entry.path) && !externallyMoved;
        let targetPath = path;
        if (movedByApp) {
            targetPath = validatePath(`${desiredFolder ? desiredFolder + '/' : ''}${path.split('/').at(-1)}`);
            if (targetPath !== path && occupied.has(targetPath)) {
                conflicts.push({ kind: 'ambiguous-move', scriptId: entry.id, path, message: 'The destination file already exists.', appCode: app.code, fileCode: file, appHash, fileHash: diskHash });
                entries.push(entry);
                continue;
            }
            occupied.add(targetPath);
            operations.push({ kind: 'write', path: targetPath, code: next.code });
            operations.push({ kind: 'remove', path });
        } else if (appChanged && !diskChanged) {
            operations.push({ kind: 'write', path, code: app.code });
        }
        next.filePath = targetPath;
        next.folderPath = folderOf(targetPath);
        entries.push(entryFor(next, targetPath, await hashCode(next.code)));
    }

    for (const app of scripts) {
        if (stateIds.has(app.id)) continue;
        const identity = scriptIdentity(app.code);
        if (identity && (duplicateIds.has(app.id) || (identityToPaths.get(identity) || []).some(path => !claimed.has(path)))) {
            conflicts.push({ kind: 'duplicate-identity', scriptId: app.id, path: app.filePath || '', message: 'A file or script already uses this @name and @namespace.', appCode: app.code });
            continue;
        }
        const path = pathForNewScript(app, occupied);
        app.filePath = path;
        app.folderPath = folderOf(path);
        operations.push({ kind: 'write', path, code: app.code });
        entries.push(entryFor(app, path, await hashCode(app.code)));
    }

    const missingScripts = conflicts.filter(conflict => conflict.kind === 'missing-file');
    for (const [path, code] of files) {
        if (claimed.has(path) || statePaths.has(path) || operations.some(op => op.kind === 'write' && op.path === path)) continue;
        if (missingScripts.length > 0) {
            conflicts.push({ kind: 'possible-move', scriptId: missingScripts.length === 1 ? missingScripts[0].scriptId : undefined, path, message: 'A script file is missing and this new file may be its renamed version. Review it before importing.', fileCode: code, fileHash: fileHashes.get(path) });
            continue;
        }
        const identity = scriptIdentity(code);
        if (!identity) {
            conflicts.push({ kind: 'invalid-file', path, message: 'The file has no valid @name metadata.', fileCode: code, fileHash: fileHashes.get(path) });
            continue;
        }
        const sameIdentity = scripts.find(script => scriptIdentity(script.code) === identity);
        if (sameIdentity || (identityToPaths.get(identity) || []).length > 1) {
            conflicts.push({ kind: 'duplicate-identity', path, message: 'Another script uses this @name and @namespace.', fileCode: code, fileHash: fileHashes.get(path) });
            continue;
        }
        const metadata = parseMetadata(code);
        const imported: Script = {
            id: crypto.randomUUID(), name: metadata.name, namespace: metadata.namespace || '',
            code, enabled: true, grantedPermissions: metadata.grant,
            token: crypto.randomUUID(),
            folderPath: folderOf(path), filePath: path, installDate: Date.now(), updateDate: Date.now(),
        };
        scripts.push(imported);
        entries.push(entryFor(imported, path, fileHashes.get(path)!));
        claimed.add(path);
    }

    const folders = unique([
        ...appFolders.map(normalizeFolder).filter(folder =>
            !!folder && (!state.folders.includes(folder) || diskFolders.includes(folder) ||
                scripts.some(script => normalizeFolder(script.folderPath) === folder || normalizeFolder(script.folderPath).startsWith(folder + '/')))),
        ...diskFolders.filter(folder => !state.folders.includes(folder)),
        ...scripts.map(script => normalizeFolder(script.folderPath)).filter(Boolean),
    ]).sort();
    const nextState: WorkspaceState = { ...state, folders, entries };
    const changed = JSON.stringify(nextState) !== JSON.stringify(state) || operations.length > 0;
    return { scripts, folders, state: nextState, conflicts, operations, changed };
}

async function getFile(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<FileSystemFileHandle> {
    const parts = validatePath(path).split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
    return directory.getFileHandle(parts.at(-1)!, { create });
}

async function writeText(root: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
    const file = await getFile(root, path, true);
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
}

async function readText(root: FileSystemDirectoryHandle, path: string): Promise<string> {
    return (await (await getFile(root, path, false)).getFile()).text();
}

async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
    const parts = validatePath(path).split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    await directory.removeEntry(parts.at(-1)!);
}

async function collectFiles(root: FileSystemDirectoryHandle): Promise<{ files: Map<string, string>; folders: string[] }> {
    const files = new Map<string, string>();
    const folders: string[] = [];
    async function visit(directory: FileSystemDirectoryHandle, prefix: string) {
        for await (const [name, handle] of directory.entries()) {
            const path = prefix ? `${prefix}/${name}` : name;
            if (handle.kind === 'directory') {
                folders.push(path);
                await visit(handle as FileSystemDirectoryHandle, path);
            } else if (name.endsWith('.user.js')) {
                files.set(path, await (await (handle as FileSystemFileHandle).getFile()).text());
            }
        }
    }
    try {
        await visit(await root.getDirectoryHandle('scripts'), '');
    } catch (error) {
        if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
    return { files, folders };
}

async function removeEmptyFolders(root: FileSystemDirectoryHandle, wanted: Set<string>): Promise<void> {
    async function visit(directory: FileSystemDirectoryHandle, prefix: string): Promise<boolean> {
        let containsFiles = false;
        for await (const [name, handle] of directory.entries()) {
            if (handle.kind === 'file') {
                containsFiles = true;
                continue;
            }
            const path = prefix ? `${prefix}/${name}` : name;
            if (await visit(handle as FileSystemDirectoryHandle, path)) containsFiles = true;
            else if (!wanted.has(path)) await directory.removeEntry(name);
        }
        return containsFiles || wanted.has(prefix);
    }
    await visit(root, '');
}

async function ensureFolders(root: FileSystemDirectoryHandle, folders: string[]): Promise<void> {
    for (const folder of folders) {
        const normalized = normalizeFolder(folder);
        if (!normalized) continue;
        let directory = root;
        for (const part of normalized.split('/')) directory = await directory.getDirectoryHandle(part, { create: true });
    }
}

export async function readWorkspaceState(root: FileSystemDirectoryHandle): Promise<WorkspaceState | undefined> {
    try {
        const state = JSON.parse(await readText(root, 'state.json')) as WorkspaceState;
        if (state.format !== 1 || !state.workspaceId || !Array.isArray(state.entries) || !Array.isArray(state.folders)) {
            throw new Error('Unsupported or damaged state.json.');
        }
        for (const entry of state.entries) validatePath(entry.path);
        return state;
    } catch (error) {
        if ((error as DOMException).name === 'NotFoundError') return undefined;
        throw error;
    }
}

async function saveState(root: FileSystemDirectoryHandle, state: WorkspaceState): Promise<void> {
    await writeText(root, 'state.json', JSON.stringify(state, null, 2));
}

let snapshotSequence = 0;
async function saveSnapshot(root: FileSystemDirectoryHandle, scripts: Script[], folders: string[], reason: string): Promise<string> {
    const directory = await root.getDirectoryHandle('history', { create: true });
    const timestamp = new Date().toISOString();
    const name = `${timestamp.replace(/[:.]/g, '-')}-${String(++snapshotSequence).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}.json`;
    const snapshot: WorkspaceSnapshot = { format: 1, timestamp, reason, folders, scripts };
    await writeText(directory, name, JSON.stringify(snapshot));
    return name;
}

export async function initializeWorkspace(root: FileSystemDirectoryHandle, scripts: Script[], folders: string[]): Promise<WorkspaceState> {
    const normalizedFolders = unique(folders.map(normalizeFolder).filter(Boolean));
    const identities = scripts.map(script => scriptIdentity(script.code)).filter(Boolean);
    if (new Set(identities).size !== identities.length) throw new Error('Resolve duplicate @name and @namespace values before selecting a workspace.');
    for (const script of scripts) normalizeFolder(script.folderPath);
    for await (const _entry of root.entries()) {
        void _entry;
        throw new Error('Choose an empty folder, or an existing ShieldMonkey folder with state.json.');
    }
    const scriptsDir = await root.getDirectoryHandle('scripts', { create: true });
    await root.getDirectoryHandle('history', { create: true });
    const occupied = new Set<string>();
    const entries: WorkspaceEntry[] = [];
    const nextScripts = scripts.map(script => ({ ...script, token: script.token || crypto.randomUUID() }));
    await ensureFolders(scriptsDir, normalizedFolders);
    for (const script of nextScripts) {
        const path = pathForNewScript(script, occupied);
        script.filePath = path;
        script.folderPath = folderOf(path);
        await writeText(scriptsDir, path, script.code);
        entries.push(entryFor(script, path, await hashCode(script.code)));
    }
    const state: WorkspaceState = { format: 1, workspaceId: crypto.randomUUID(), folders: normalizedFolders, entries };
    await saveSnapshot(root, nextScripts, state.folders, 'Initial workspace');
    await saveState(root, state);
    return state;
}

export async function resolveWorkspaceConflict(
    root: FileSystemDirectoryHandle,
    conflict: WorkspaceConflict,
    resolution: WorkspaceResolution,
    appScripts: Script[],
    appFolders: string[],
    applyLibrary: (scripts: Script[], folders: string[]) => Promise<void>,
): Promise<void> {
    if (conflict.kind === 'duplicate-identity' || conflict.kind === 'invalid-file') {
        throw new Error('Edit the duplicate or invalid file metadata, then refresh.');
    }
    const state = await readWorkspaceState(root);
    if (!state) throw new Error('This folder is not initialized.');
    const scripts = appScripts.map(script => ({ ...script }));
    const script = conflict.scriptId ? scripts.find(item => item.id === conflict.scriptId) : undefined;
    const entry = conflict.scriptId ? state.entries.find(item => item.id === conflict.scriptId) : undefined;
    const scriptsDir = await root.getDirectoryHandle('scripts', { create: true });
    let currentFile: string | undefined;
    try {
        currentFile = await readText(scriptsDir, conflict.path);
    } catch (error) {
        if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
    if (conflict.fileHash && (!currentFile || await hashCode(currentFile) !== conflict.fileHash)) {
        throw new Error('The file changed again. Refresh before resolving this conflict.');
    }
    if (conflict.appHash && (!script || await hashCode(script.code) !== conflict.appHash)) {
        throw new Error('The app copy changed again. Refresh before resolving this conflict.');
    }
    if (currentFile !== undefined && entry && conflict.fileHash) {
        const fileVersion = withFileMetadata({ ...entry.metadata, id: entry.id, code: currentFile }, currentFile, conflict.path);
        await saveSnapshot(root, [...appScripts.filter(item => item.id !== entry.id), fileVersion], appFolders, 'File version before conflict resolution');
    }
    await saveSnapshot(root, appScripts, appFolders, 'Before conflict resolution');
    if (conflict.kind === 'missing-file') {
        if (!script || !entry) throw new Error('Script no longer exists.');
        if (resolution === 'app') {
            await writeText(scriptsDir, entry.path, script.code);
            const updatedEntry = entryFor(script, entry.path, await hashCode(script.code));
            state.entries = state.entries.map(item => item.id === script.id ? updatedEntry : item);
        } else {
            const index = scripts.findIndex(item => item.id === script.id);
            scripts.splice(index, 1);
            state.entries = state.entries.filter(item => item.id !== script.id);
        }
    } else if (conflict.kind === 'changed-before-delete') {
        if (!entry) throw new Error('Script no longer exists.');
        if (resolution === 'app') {
            await removeFile(scriptsDir, conflict.path);
            state.entries = state.entries.filter(item => item.id !== entry.id);
        } else {
            if (currentFile === undefined) throw new Error('File no longer exists.');
            const restored = withFileMetadata({ ...entry.metadata, id: entry.id, code: currentFile }, currentFile, conflict.path);
            scripts.push(restored);
            const updatedEntry = entryFor(restored, conflict.path, await hashCode(restored.code));
            state.entries = state.entries.map(item => item.id === entry.id ? updatedEntry : item);
        }
    } else {
        if (!script || !entry) throw new Error('Script no longer exists.');
        if (resolution === 'app') {
            const target = conflict.kind === 'possible-move' ? entry.path : conflict.path;
            await writeText(scriptsDir, target, script.code);
            if (conflict.kind === 'possible-move' && conflict.path !== target && currentFile !== undefined) {
                await removeFile(scriptsDir, conflict.path);
            }
            script.filePath = target;
            script.folderPath = folderOf(target);
            const updatedEntry = entryFor(script, target, await hashCode(script.code));
            state.entries = state.entries.map(item => item.id === script.id ? updatedEntry : item);
        } else {
            if (currentFile === undefined || !scriptIdentity(currentFile)) throw new Error('File has no valid @name metadata.');
            const updated = withFileMetadata(script, currentFile, conflict.path);
            scripts[scripts.findIndex(item => item.id === script.id)] = updated;
            const updatedEntry = entryFor(updated, conflict.path, await hashCode(updated.code));
            state.entries = state.entries.map(item => item.id === script.id ? updatedEntry : item);
        }
    }
    await applyLibrary(scripts, appFolders);
    await saveState(root, state);
    await saveSnapshot(root, scripts, appFolders, 'Conflict resolved');
}

export async function synchronizeWorkspace(
    root: FileSystemDirectoryHandle,
    scripts: Script[],
    folders: string[],
    applyLibrary: (scripts: Script[], folders: string[]) => Promise<void>,
): Promise<Reconciliation> {
    const state = await readWorkspaceState(root);
    if (!state) throw new Error('This folder is not initialized.');
    const { files, folders: diskFolders } = await collectFiles(root);
    const result = await reconcileWorkspace(state, scripts, folders, files, diskFolders);
    if (!result.changed) return result;
    await saveSnapshot(root, result.scripts, result.folders, 'Workspace change');
    const scriptsDir = await root.getDirectoryHandle('scripts', { create: true });
    for (const folder of result.folders) {
        let directory = scriptsDir;
        for (const part of folder.split('/')) directory = await directory.getDirectoryHandle(part, { create: true });
    }
    for (const operation of result.operations.filter(op => op.kind === 'write')) await writeText(scriptsDir, operation.path, operation.code!);
    for (const operation of result.operations.filter(op => op.kind === 'remove')) await removeFile(scriptsDir, operation.path);
    await removeEmptyFolders(scriptsDir, new Set(result.folders));
    await applyLibrary(result.scripts, result.folders);
    await saveState(root, result.state);
    return result;
}

export async function listWorkspaceHistory(root: FileSystemDirectoryHandle): Promise<WorkspaceHistoryItem[]> {
    const history = await root.getDirectoryHandle('history');
    const items: WorkspaceHistoryItem[] = [];
    for await (const [name, handle] of history.entries()) {
        if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
        const snapshot = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()) as WorkspaceSnapshot;
        if (snapshot.format === 1 && Array.isArray(snapshot.scripts)) {
            items.push({ name, timestamp: snapshot.timestamp, reason: snapshot.reason, count: snapshot.scripts.length });
        }
    }
    return items.sort((a, b) => b.name.localeCompare(a.name));
}

export async function readWorkspaceHistory(root: FileSystemDirectoryHandle, name: string): Promise<WorkspaceSnapshot> {
    if (!/^[\w-]+\.json$/.test(name)) throw new Error('Invalid history item.');
    const snapshot = JSON.parse(await readText(await root.getDirectoryHandle('history'), name)) as WorkspaceSnapshot;
    if (snapshot.format !== 1 || !Array.isArray(snapshot.scripts) || !Array.isArray(snapshot.folders)) throw new Error('Damaged history item.');
    return snapshot;
}

export async function restoreCurrentWorkspace(
    root: FileSystemDirectoryHandle,
    currentScripts: Script[],
    currentFolders: string[],
    applyLibrary: (scripts: Script[], folders: string[]) => Promise<void>,
): Promise<number> {
    const state = await readWorkspaceState(root);
    if (!state) throw new Error('This folder is not initialized.');
    const scriptsDir = await root.getDirectoryHandle('scripts');
    const scripts: Script[] = [];
    const entries: WorkspaceEntry[] = [];
    for (const entry of state.entries) {
        const code = await readText(scriptsDir, entry.path);
        if (!scriptIdentity(code)) throw new Error(`Invalid userscript metadata: ${entry.path}`);
        const script = withFileMetadata({ ...entry.metadata, id: entry.id, code }, code, entry.path);
        scripts.push(script);
        entries.push(entryFor(script, entry.path, await hashCode(code)));
    }
    const identities = scripts.map(script => scriptIdentity(script.code));
    if (identities.some((identity, index) => identity && identities.indexOf(identity) !== index)) {
        throw new Error('The workspace contains duplicate @name and @namespace values.');
    }
    await saveSnapshot(root, currentScripts, currentFolders, 'Before folder restore');
    await applyLibrary(scripts, state.folders);
    await saveState(root, { ...state, entries });
    await saveSnapshot(root, scripts, state.folders, 'Restore from folder');
    return scripts.length;
}

export async function restoreWorkspaceHistory(
    root: FileSystemDirectoryHandle,
    name: string,
    scriptId: string | undefined,
    currentScripts: Script[],
    currentFolders: string[],
    applyLibrary: (scripts: Script[], folders: string[]) => Promise<void>,
): Promise<number> {
    const snapshot = await readWorkspaceHistory(root, name);
    const state = await readWorkspaceState(root);
    if (!state) throw new Error('This folder is not initialized.');
    const currentFiles = await collectFiles(root);
    const trackedPaths = new Set(state.entries.map(entry => entry.path));
    if ([...currentFiles.files.keys()].some(path => !trackedPaths.has(path))) {
        throw new Error('Unreviewed script files are present. Refresh and resolve changes before restoring history.');
    }
    for (const entry of state.entries) {
        const current = currentFiles.files.get(entry.path);
        if (current !== undefined && await hashCode(current) !== entry.hash) {
            throw new Error('Files changed outside ShieldMonkey. Refresh and resolve changes before restoring history.');
        }
    }
    let scripts: Script[];
    let folders: string[];
    if (scriptId) {
        const selected = snapshot.scripts.find(script => script.id === scriptId);
        if (!selected) throw new Error('Script not present in this history item.');
        scripts = [...currentScripts.filter(script => script.id !== scriptId), { ...selected, token: crypto.randomUUID() }];
        folders = unique([...currentFolders, ...snapshot.folders]);
    } else {
        scripts = snapshot.scripts.map(script => ({ ...script, token: crypto.randomUUID() }));
        folders = [...snapshot.folders];
    }
    const identities = scripts.map(scriptIdentityFromScript);
    if (identities.some((identity, index) => identity && identities.indexOf(identity) !== index)) {
        throw new Error('Restore would create duplicate @name and @namespace values.');
    }
    await saveSnapshot(root, currentScripts, currentFolders, 'Before history restore');
    const scriptsDir = await root.getDirectoryHandle('scripts', { create: true });
    await ensureFolders(scriptsDir, folders);
    const occupied = new Set<string>();
    const entries: WorkspaceEntry[] = [];
    for (const script of scripts) {
        let path = script.filePath;
        if (!path || occupied.has(path)) path = pathForNewScript(script, occupied);
        else occupied.add(path);
        script.filePath = path;
        script.folderPath = folderOf(path);
        await writeText(scriptsDir, path, script.code);
        entries.push(entryFor(script, path, await hashCode(script.code)));
    }
    for (const entry of state.entries) {
        if (!entries.some(item => item.path === entry.path) && currentFiles.files.has(entry.path)) await removeFile(scriptsDir, entry.path);
    }
    await removeEmptyFolders(scriptsDir, new Set(folders));
    const nextState = { ...state, folders, entries };
    await applyLibrary(scripts, folders);
    await saveState(root, nextState);
    await saveSnapshot(root, scripts, folders, scriptId ? 'Restore script' : 'Restore all');
    return scriptId ? 1 : scripts.length;
}

function scriptIdentityFromScript(script: Script): string | undefined {
    return scriptIdentity(script.code);
}
