import { worldIdFor } from '../shared/identity';
import { parseMetadata } from '../utils/metadataParser';
import { getGMAPIScript } from '../utils/scriptGenerator';
import type { Script } from '../shared/types';
import { protectScript, validateScript } from '../shared/policy';
import { updateActiveTabBadge } from './badge';
import { isUserScriptsAvailable, getUserScripts, unregisterUserScripts, registerUserScripts, browserAPI } from '../utils/browserPolyfill';
import { stateReady } from './state';

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work); queue = result.catch(() => {}); return result;
}
export function runAtFor(value?: string): chrome.extensionTypes.RunAt {
    const normalized = value?.replace(/-/g, '_');
    if (normalized === 'document_start' || normalized === 'document_idle') return normalized;
    return 'document_end';
}
export async function registrationFor(script: Script): Promise<chrome.userScripts.RegisteredUserScript> {
    const metadata = parseMetadata(script.code);
    const patterns = [...metadata.match, ...metadata.include];
    for (const pattern of metadata.match) {
        if (pattern !== '<all_urls>' && !/^(\*|http|https|file|ftp):\/\/[^/]*\/.*$/.test(pattern)) throw new Error('Invalid @match pattern: ' + pattern);
    }
    const native = patterns.every(pattern => /^(\*|http|https|file|ftp):\/\/[^/]*\/.*$/.test(pattern) || pattern === '<all_urls>');
    const matchGlobs = metadata.match.flatMap(pattern => {
        if (pattern === '<all_urls>') return ['*'];
        const variants = [pattern, pattern.replace('://*.', '://')];
        return variants.flatMap(value => [value, value.replace(/^(.*?:\/\/[^/]+)(\/.*)$/, '$1:*$2')]);
    });
    return {
        id: script.id,
        matches: native ? (patterns.length ? patterns : ['<all_urls>']) : ['<all_urls>'],
        ...(!native ? { includeGlobs: [...matchGlobs, ...metadata.include] } : {}),
        js: [{ code: getGMAPIScript({ id: script.id, name: script.name, version: metadata.version || '1.0', permissions: script.grantedPermissions || [], namespace: metadata.namespace, description: metadata.description, token: script.token || '' }, script.code) }],
        runAt: runAtFor(metadata['run-at']),
        world: 'USER_SCRIPT', worldId: await worldIdFor(script.id),
    };
}
async function configureWorlds(scripts: Script[]) {
    const api = browserAPI.userScripts;
    if (!api?.getWorldConfigurations || !api.resetWorldConfiguration) throw new Error('This browser does not support isolated script worlds.');
    const existing = await api.getWorldConfigurations();
    await api.configureWorld({ messaging: false });
    const wanted = new Set(await Promise.all(scripts.map(script => worldIdFor(script.id))));
    for (const config of existing) {
        if (config.worldId && !wanted.has(config.worldId)) await api.resetWorldConfiguration(config.worldId);
    }
    for (const worldId of wanted) {
        if (!existing.some(config => config.worldId === worldId && config.messaging === true)) {
            await api.configureWorld({ worldId, messaging: true });
        }
    }
}
async function validateRegistration(script: Script) {
    const id = `shieldmonkey-validation-${crypto.randomUUID()}`;
    try { await registerUserScripts([{ ...await registrationFor(script), id, js: [{ code: 'void 0;' }] }]); }
    finally { await unregisterUserScripts({ ids: [id] }).catch(() => {}); }
}
function validateLibrary(values: unknown): asserts values is Script[] {
    if (!Array.isArray(values)) throw new Error('Invalid library.');
    const ids = new Set<string>(), identities = new Set<string>();
    for (const script of values) {
        validateScript(script);
        const metadata = parseMetadata(script.code);
        const identity = `${metadata.namespace || ''}\0${metadata.name}`;
        if (ids.has(script.id) || identities.has(identity)) throw new Error('Duplicate script ID or name/namespace.');
        ids.add(script.id); identities.add(identity);
    }
}
async function commitLibrary(scripts: Script[], previous: Script[], fields: Record<string, unknown> = {}) {
    validateLibrary(scripts);
    const available = await isUserScriptsAvailable();
    const settings = await chrome.storage.local.get('extensionEnabled');
    const active = settings.extensionEnabled !== false ? scripts.filter(script => script.enabled && !script.pendingApproval) : [];
    if (!available && active.length) throw new Error('User scripts are unavailable. Enable Allow User Scripts in the extension settings.');
    const registrations = available ? await getUserScripts() : [];
    try {
        if (available) {
            for (const script of scripts) {
                const old = previous.find(item => item.id === script.id);
                if (!old || old.code !== script.code) await validateRegistration(script);
            }
            await configureWorlds(active);
            const wanted = await Promise.all(active.map(registrationFor));
            const same = (a: chrome.userScripts.RegisteredUserScript, b: chrome.userScripts.RegisteredUserScript) => a.worldId === b.worldId && JSON.stringify(a.js) === JSON.stringify(b.js) && a.runAt === b.runAt;
            const remove = registrations.filter(reg => !wanted.some(next => reg.id === next.id && same(reg, next))).map(reg => reg.id);
            if (remove.length) await unregisterUserScripts({ ids: remove });
            const add = wanted.filter(reg => !registrations.some(old => old.id === reg.id && same(old, reg)));
            if (add.length) await registerUserScripts(add);
        }
        await chrome.storage.local.set({ scripts, ...fields });
    } catch (error) {
        if (available) {
            await unregisterUserScripts().catch(() => {});
            await configureWorlds(previous.filter(script => script.enabled && !script.pendingApproval)).catch(() => {});
            if (registrations.length) await registerUserScripts(registrations).catch(rollback => console.error('Registration rollback failed:', rollback));
        }
        throw error;
    }
    await updateActiveTabBadge();
}
export function reloadAllScripts(): Promise<void> {
    return serialize(async () => {
        await stateReady;
        const { scripts = [] } = await chrome.storage.local.get('scripts');
        await commitLibrary(scripts as Script[], scripts as Script[]);
    });
}
export function handleSaveScript(value: unknown, approved = false): Promise<void> {
    return serialize(async () => {
        await stateReady; validateScript(value);
        const data = await chrome.storage.local.get('scripts');
        const previous = (data.scripts || []) as Script[];
        const old = previous.find(script => script.id === value.id);
        const updated = protectScript(value, old, approved);
        if (updated.pendingApproval) throw new Error('Script permission review is required.');
        await commitLibrary([...previous.filter(script => script.id !== value.id), updated], previous);
    });
}
export function handleToggleScript(id: string, enabled: boolean, approved = false): Promise<void> {
    return serialize(async () => {
        await stateReady;
        const data = await chrome.storage.local.get('scripts');
        const previous = (data.scripts || []) as Script[];
        const old = previous.find(script => script.id === id);
        if (!old) throw new Error('Script not found.');
        const updated = protectScript({ ...old, enabled }, old, approved);
        if (enabled && updated.pendingApproval) throw new Error('Script permission review is required.');
        await commitLibrary(previous.map(script => script.id === id ? updated : script), previous);
    });
}
export function handleToggleGlobal(enabled: boolean): Promise<void> {
    return serialize(async () => {
        await stateReady;
        const before = await chrome.storage.local.get(['scripts', 'extensionEnabled']);
        await chrome.storage.local.set({ extensionEnabled: enabled });
        try { await commitLibrary((before.scripts || []) as Script[], (before.scripts || []) as Script[]); }
        catch (error) { await chrome.storage.local.set({ extensionEnabled: before.extensionEnabled !== false }); throw error; }
    });
}
export function handleDeleteScript(id: string): Promise<void> {
    return serialize(async () => {
        await stateReady;
        const { scripts = [] } = await chrome.storage.local.get('scripts');
        await commitLibrary((scripts as Script[]).filter(script => script.id !== id), scripts as Script[]);
    });
}
export function handleApplyLibrary(values: unknown, folders?: unknown, restoring = false): Promise<void> {
    return serialize(async () => {
        await stateReady; validateLibrary(values);
        if (folders !== undefined && (!Array.isArray(folders) || folders.some(folder => typeof folder !== 'string' || folder.split('/').some((part: string) => !part || part === '.' || part === '..' || (part.includes('\\') || [...part].some(char => char.charCodeAt(0) < 32)))))) throw new Error('Invalid folders.');
        const data = await chrome.storage.local.get('scripts');
        const previous = (data.scripts || []) as Script[];
        const scripts = values.map(script => protectScript(script, previous.find(old => old.id === script.id)));
        await commitLibrary(scripts, previous, { ...(folders !== undefined ? { scriptFolders: folders } : {}), ...(restoring ? { backupRestoreMarker: crypto.randomUUID() } : {}) });
    });
}

export function handleImportScripts(values: unknown, approvals: unknown): Promise<void> {
    return serialize(async () => {
        await stateReady; validateLibrary(values);
        if (!Array.isArray(approvals) || approvals.some(id => typeof id !== 'string')) throw new Error('Invalid import approval.');
        const { scripts = [] } = await chrome.storage.local.get('scripts');
        const previous = scripts as Script[];
        const approvedIds = new Set(approvals);
        const imported = values.map(script => protectScript(script, previous.find(old => old.id === script.id), approvedIds.has(script.id)));
        if (imported.some(script => script.pendingApproval)) throw new Error('Import permission review is required.');
        const ids = new Set(imported.map(script => script.id));
        await commitLibrary([...previous.filter(script => !ids.has(script.id)), ...imported], previous);
    });
}
