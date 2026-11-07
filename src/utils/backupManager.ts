import { getBackupFingerprint, getDirectoryHandle, saveBackupFingerprint, verifyPermission } from './backupStorage';
import type { Script } from '../sandbox/options/types';
import { parseMetadata } from './metadataParser';

export type { Script } from '../sandbox/options/types';

interface ScriptFile { name: string; sha256: string }
export interface BackupDocument {
    formatVersion?: number;
    timestamp: string;
    version: string;
    scripts: Script[];
    files?: Record<string, ScriptFile>;
}
export interface RestorePlan {
    count: number;
    added: number;
    updated: number;
    unchanged: number;
    localOnly: number;
    fileEdits: number;
    missingFiles: number;
    sourceFingerprint?: string;
    backupScripts: Script[];
    mergedScripts: Script[];
}

const DUMP_NAME = 'shieldmonkey_dump.json';

function cleanScript(script: Script): Script {
    const { lastSavedCode: _lastSavedCode, token: _token, ...saved } = script as Script & { token?: string };
    void _lastSavedCode;
    void _token;
    return saved;
}

function normalize(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(normalize).join(',') + ']';
    if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return '{' + Object.keys(object).filter(key => key !== 'lastSavedCode' && key !== 'token').sort()
            .map(key => JSON.stringify(key) + ':' + normalize(object[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

export function sameScript(a: Script, b: Script): boolean {
    return normalize(a) === normalize(b);
}

export function parseBackup(text: string): BackupDocument {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('Invalid backup JSON.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid backup format.');
    const object = data as Record<string, unknown>;
    if (!Array.isArray(object.scripts)) throw new Error('Backup has no scripts array.');
    if (object.formatVersion !== undefined && object.formatVersion !== 2) throw new Error('Unsupported backup format version.');
    const ids = new Set<string>();
    for (const [index, value] of object.scripts.entries()) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid script at position ' + (index + 1) + '.');
        const script = value as Record<string, unknown>;
        if (typeof script.id !== 'string' || !script.id.trim() || typeof script.name !== 'string' || typeof script.code !== 'string') {
            throw new Error('Invalid script at position ' + (index + 1) + '.');
        }
        if (ids.has(script.id)) throw new Error('Duplicate script ID: ' + script.id);
        ids.add(script.id);
        if (script.enabled !== undefined && typeof script.enabled !== 'boolean') throw new Error('Invalid enabled state for ' + script.name + '.');
        if (script.grantedPermissions !== undefined && (!Array.isArray(script.grantedPermissions) || !script.grantedPermissions.every(permission => typeof permission === 'string'))) {
            throw new Error('Invalid permissions for ' + script.name + '.');
        }
    }
    if (object.files !== undefined) {
        if (!object.files || typeof object.files !== 'object' || Array.isArray(object.files)) throw new Error('Invalid script file manifest.');
        const fileNames = new Set<string>();
        for (const [id, value] of Object.entries(object.files)) {
            const file = value as ScriptFile | null;
            if (!ids.has(id) || !file || typeof file.name !== 'string' || !/^[^/\\]+\.user\.js$/.test(file.name) || fileNames.has(file.name) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
                throw new Error('Invalid script file manifest.');
            }
            fileNames.add(file.name);
        }
    }
    return {
        formatVersion: object.formatVersion as number | undefined,
        timestamp: typeof object.timestamp === 'string' ? object.timestamp : '',
        version: typeof object.version === 'string' ? object.version : '',
        scripts: (object.scripts as Script[]).map(cleanScript),
        files: object.files as Record<string, ScriptFile> | undefined
    };
}

export function planRestore(backupScripts: Script[], currentScripts: Script[], mode: 'merge' | 'replace' = 'merge'): RestorePlan {
    const current = new Map(currentScripts.map(script => [script.id, script]));
    const incoming = new Map(backupScripts.map(script => [script.id, cleanScript(script)]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const script of incoming.values()) {
        const prior = current.get(script.id);
        if (!prior) added++;
        else if (sameScript(prior, script)) unchanged++;
        else updated++;
    }
    const localOnly = currentScripts.filter(script => !incoming.has(script.id)).length;
    const mergedScripts = mode === 'replace'
        ? Array.from(incoming.values())
        : [...currentScripts.map(script => incoming.get(script.id) ?? script), ...backupScripts.filter(script => !current.has(script.id)).map(cleanScript)];
    return { count: backupScripts.length, added, updated, unchanged, localOnly, fileEdits: 0, missingFiles: 0, backupScripts: Array.from(incoming.values()), mergedScripts };
}

export function serializeBackup(scripts: Script[], version: string, files?: Record<string, ScriptFile>): string {
    return JSON.stringify({
        formatVersion: 2,
        timestamp: new Date().toISOString(),
        version,
        scripts: scripts.map(cleanScript),
        ...(files ? { files } : {})
    }, null, 2);
}

async function sha256(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isNotFound(error: unknown): boolean {
    return (error as Error)?.name === 'NotFoundError';
}

async function readFile(directory: FileSystemDirectoryHandle, name: string): Promise<string | undefined> {
    try {
        const handle = await directory.getFileHandle(name);
        return (await handle.getFile()).text();
    } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
    }
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, content: string): Promise<void> {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
        await writable.write(content);
    } finally {
        await writable.close();
    }
}

async function directoryHandle(existingHandle?: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
    const handle = existingHandle ?? await getDirectoryHandle();
    if (!handle) throw new Error('No backup folder selected.');
    return handle;
}

export async function performBackup(existingHandle: FileSystemDirectoryHandle | undefined, scripts: Script[], version: string, allowPermissionPrompt = true, repairMissing = false): Promise<number> {
    const handle = await directoryHandle(existingHandle);
    if (!await verifyPermission(handle, true, allowPermissionPrompt)) throw new Error('Backup folder permission is required. Open Settings and select the folder again.');
    parseBackup(serializeBackup(scripts, version));
    const previousText = await readFile(handle, DUMP_NAME);
    const previous = previousText === undefined ? undefined : parseBackup(previousText);
    const previousFingerprint = await getBackupFingerprint();
    if (previousText !== undefined) {
        if (previousFingerprint && await sha256(previousText) !== previousFingerprint) {
            throw new Error('The backup JSON changed outside ShieldMonkey. Restore it first or choose another folder.');
        }
        if (!previousFingerprint && normalize(previous?.scripts) !== normalize(scripts)) {
            throw new Error('This folder has a different backup. Restore it first or choose another folder.');
        }
    }

    const scriptsDir = await handle.getDirectoryHandle('scripts', { create: true });
    const files: Record<string, ScriptFile> = Object.create(null);
    const writes: { name: string; code: string }[] = [];
    for (const script of scripts) {
        const idHash = (await sha256(script.id)).slice(0, 16);
        const safeName = Array.from(script.name.normalize('NFC').replace(/[<>:"/\\|?*]/g, '_'))
            .map(char => char.codePointAt(0)! < 32 ? '_' : char).join('')
            .replace(/[. ]+$/g, '').slice(0, 60) || 'script';
        const name = safeName + '_' + idHash + '.user.js';
        const digest = await sha256(script.code);
        files[script.id] = { name, sha256: digest };
        const existing = await readFile(scriptsDir, name);
        const oldEntry = previous?.files && Object.hasOwn(previous.files, script.id) ? previous.files[script.id] : undefined;
        if (existing !== undefined && oldEntry?.name !== name && existing !== script.code) {
            throw new Error('The file ' + name + ' already exists and differs. Choose another folder.');
        }
        if (oldEntry) {
            const oldCode = oldEntry.name === name ? existing : await readFile(scriptsDir, oldEntry.name);
            if ((oldCode === undefined && !repairMissing) || (oldCode !== undefined && await sha256(oldCode) !== oldEntry.sha256 && oldCode !== script.code)) {
                throw new Error('The file ' + oldEntry.name + ' changed outside ShieldMonkey. Restore or import it before backing up.');
            }
        }
        if (existing !== script.code) writes.push({ name, code: script.code });
    }
    for (const [id, oldEntry] of Object.entries(previous?.files ?? {})) {
        if (files[id]?.name === oldEntry.name) continue;
        const oldCode = await readFile(scriptsDir, oldEntry.name);
        if ((oldCode === undefined && !repairMissing) || (oldCode !== undefined && await sha256(oldCode) !== oldEntry.sha256 && await sha256(oldCode) !== files[id]?.sha256)) {
            throw new Error('The file ' + oldEntry.name + ' changed outside ShieldMonkey. Restore or import it before backing up.');
        }
    }

    const nextText = serializeBackup(scripts, version, files);
    if (previousText !== undefined && normalize(previous?.scripts) !== normalize(scripts)) {
        const history = await handle.getDirectoryHandle('history', { create: true });
        const stamp = (previous?.timestamp || new Date().toISOString()).replace(/[^0-9A-Za-z_-]/g, '-');
        await writeFile(history, stamp + '_' + (await sha256(previousText)).slice(0, 8) + '.json', JSON.stringify(previous, null, 2));
    }
    for (const write of writes) await writeFile(scriptsDir, write.name, write.code);
    await writeFile(handle, DUMP_NAME, nextText);
    await saveBackupFingerprint(await sha256(nextText));
    for (const [id, oldEntry] of Object.entries(previous?.files ?? {})) {
        if (files[id]?.name !== oldEntry.name) {
            try {
                const oldCode = await readFile(scriptsDir, oldEntry.name);
                if (oldCode === undefined) continue;
                const digest = await sha256(oldCode);
                if (digest !== oldEntry.sha256 && digest !== files[id]?.sha256) {
                    console.warn('Keeping an externally changed script file:', oldEntry.name);
                    continue;
                }
                await scriptsDir.removeEntry(oldEntry.name);
            } catch (error) {
                console.warn('Could not remove an old script copy:', oldEntry.name, error);
            }
        }
    }
    return scripts.length;
}

export async function performBackupLegacy(scripts: Script[], version: string): Promise<number> {
    const data = serializeBackup(scripts, version);
    const filename = 'shieldmonkey_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    const { bridge } = await import('../sandbox/bridge/client');
    await bridge.call('DOWNLOAD_JSON', { data, filename });
    return scripts.length;
}

export async function performRestoreLegacy(file: File, currentScripts: Script[]): Promise<RestorePlan> {
    const backup = parseBackup(await file.text());
    return planRestore(backup.scripts, currentScripts);
}

async function readFolderSnapshot(handle: FileSystemDirectoryHandle) {
    const text = await readFile(handle, DUMP_NAME);
    if (text === undefined) throw new Error(DUMP_NAME + ' was not found in the selected folder.');
    const backup = parseBackup(text);
    const codes = new Map<string, string | undefined>();
    const fingerprintParts: unknown[] = [text];
    if (backup.files) {
        let scriptsDir: FileSystemDirectoryHandle | undefined;
        try { scriptsDir = await handle.getDirectoryHandle('scripts'); }
        catch (error) { if (!isNotFound(error)) throw error; }
        for (const [id, fileEntry] of Object.entries(backup.files).sort(([a], [b]) => a.localeCompare(b))) {
            const code = scriptsDir ? await readFile(scriptsDir, fileEntry.name) : undefined;
            codes.set(id, code);
            fingerprintParts.push([id, fileEntry.name, code ?? null]);
        }
    }
    return { backup, codes, fingerprint: await sha256(JSON.stringify(fingerprintParts)) };
}

export async function performRestore(existingHandle: FileSystemDirectoryHandle | undefined, currentScripts: Script[]): Promise<RestorePlan> {
    const handle = await directoryHandle(existingHandle);
    if (!await verifyPermission(handle)) throw new Error('Backup folder permission is required.');
    const snapshot = await readFolderSnapshot(handle);
    let fileEdits = 0;
    let missingFiles = 0;
    const restored = snapshot.backup.scripts.map(script => ({ ...script }));
    if (snapshot.backup.files) {
        for (const script of restored) {
            const fileEntry = Object.hasOwn(snapshot.backup.files, script.id) ? snapshot.backup.files[script.id] : undefined;
            if (!fileEntry) continue;
            const fileCode = snapshot.codes.get(script.id);
            if (fileCode === undefined) {
                missingFiles++;
                continue;
            }
            if (await sha256(fileCode) !== fileEntry.sha256) {
                script.code = fileCode;
                const name = parseMetadata(fileCode).name;
                if (name !== 'New Script') script.name = name;
                fileEdits++;
            }
        }
    }
    return { ...planRestore(restored, currentScripts), fileEdits, missingFiles, sourceFingerprint: snapshot.fingerprint };
}

export async function verifyRestoredFolder(expectedFingerprint: string, existingHandle?: FileSystemDirectoryHandle): Promise<void> {
    const handle = await directoryHandle(existingHandle);
    const snapshot = await readFolderSnapshot(handle);
    if (snapshot.fingerprint !== expectedFingerprint) throw new Error('The backup folder changed during the restore preview. Review it again.');
}

export async function acknowledgeRestoredFolder(expectedFingerprint: string, existingHandle?: FileSystemDirectoryHandle): Promise<void> {
    await verifyRestoredFolder(expectedFingerprint, existingHandle);
    const handle = await directoryHandle(existingHandle);
    const text = await readFile(handle, DUMP_NAME);
    if (text === undefined) throw new Error(DUMP_NAME + ' was not found in the selected folder.');
    await saveBackupFingerprint(await sha256(text));
}
