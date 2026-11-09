import { worldIdFor } from '../shared/identity';
import type { Script } from '../shared/types';
import { canonicalGrant, hasGrant } from '../shared/policy';
import { GM_PORT, type GMClientMessage, type GMServerMessage } from '../shared/gm';
import { isScriptMatchingUrl } from '../utils/scriptMatcher';
import { stateReady } from './state';

interface Session { port: chrome.runtime.Port; scriptId: string; token: string; origin: string; url: string; sender: chrome.runtime.MessageSender; initialized: boolean }
const sessions = new Set<Session>();
let writeQueue: Promise<unknown> = Promise.resolve();
function send(session: Session, message: GMServerMessage) { try { session.port.postMessage(message); } catch { sessions.delete(session); } }
function prefix(session: Session) { return 'gmv1:' + JSON.stringify([session.scriptId, session.origin]) + ':'; }
async function authenticate(session: Session): Promise<Script> {
    await stateReady;
    const [data, allowed] = await Promise.all([chrome.storage.local.get(['scripts', 'extensionEnabled']), chrome.permissions.contains({permissions:['userScripts']})]);
    const script = (data.scripts as Script[] | undefined)?.find(script => script.id === session.scriptId);
    if (!allowed || data.extensionEnabled === false || !script || !script.enabled || script.pendingApproval || !script.token || script.token !== session.token || !isScriptMatchingUrl(script.code, session.url)) throw new Error('Script access revoked.');
    return script;
}
function key(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid value key.');
    return value;
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request data.');
    return value as Record<string, unknown>;
}
export function validateGMUrl(value: unknown, operation: 'tab' | 'download', origin: string): string {
    if (typeof value !== 'string') throw new Error('Invalid URL.');
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:' || (operation === 'tab' && value === 'about:blank')) return value;
    if (operation === 'download' && (url.protocol === 'data:' || (url.protocol === 'blob:' && url.origin === origin))) return value;
    throw new Error('URL scheme is not allowed.');
}
async function notifyValue(source: Session, name: string, value: unknown) {
    for (const target of sessions) {
        if (!target.initialized || target.scriptId !== source.scriptId || target.origin !== source.origin) continue;
        try {
            const script = await authenticate(target);
            const grants = script.grantedPermissions || [];
            if (hasGrant(grants, 'GM_getValue') || hasGrant(grants, 'GM_getValues') || hasGrant(grants, 'GM_addValueChangeListener')) send(target, { type: 'VALUE_CHANGED', key: name, value, remote: target !== source });
            else if (hasGrant(grants, 'GM_listValues')) {
                const all = await chrome.storage.local.get(null);
                send(target, { type: 'KEYS_CHANGED', keys: Object.keys(all).filter(key => key.startsWith(prefix(target))).map(key => key.slice(prefix(target).length)) });
            }
        } catch { target.port.disconnect(); sessions.delete(target); }
    }
}
async function execute(session: Session, operation: string, input: unknown): Promise<unknown> {
    const script = await authenticate(session);
    const data = object(input);
    const grants = script.grantedPermissions || [];
    operation = canonicalGrant(operation);
    if (!hasGrant(grants, operation)) throw new Error('Permission denied: ' + operation);
    const base = prefix(session);
    switch (operation) {
        case 'GM_getValue': { const name = key(data.key); return (await chrome.storage.local.get(base + name))[base + name]; }
        case 'GM_listValues': return Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith(base)).map(k => k.slice(base.length));
        case 'GM_getValues': {
            if (!Array.isArray(data.keys)) throw new Error('Invalid value keys.');
            const names = data.keys.map(key); const stored = await chrome.storage.local.get(names.map(name => base + name));
            return Object.fromEntries(names.filter(name => Object.hasOwn(stored, base + name)).map(name => [name, stored[base + name]]));
        }
        case 'GM_setValue': case 'GM_setValues': {
            const values = operation === 'GM_setValue' ? { [key(data.key)]: data.value } : object(data.values);
            const entries = Object.entries(values).map(([name, value]) => { if (value === undefined) throw new Error('Undefined values cannot be stored.'); return [key(name), value] as const; });
            await chrome.storage.local.set(Object.fromEntries(entries.map(([name, value]) => [base + name, value])));
            for (const [name, value] of entries) await notifyValue(session, name, value);
            return null;
        }
        case 'GM_deleteValue': case 'GM_deleteValues': {
            const names = operation === 'GM_deleteValue' ? [key(data.key)] : Array.isArray(data.keys) ? data.keys.map(key) : (() => { throw new Error('Invalid value keys.'); })();
            await chrome.storage.local.remove(names.map(name => base + name));
            for (const name of names) await notifyValue(session, name, undefined);
            return null;
        }
        case 'GM_openInTab': {
            const options = data.options === undefined ? {} : object(data.options);
            await chrome.tabs.create({ url: validateGMUrl(data.url, 'tab', session.origin), active: options.active !== false }); return null;
        }
        case 'GM_closeTab':
            if (session.sender.tab?.id !== undefined) await chrome.tabs.remove(session.sender.tab.id);
            return null;
        case 'GM_download': {
            if (data.name !== undefined && (typeof data.name !== 'string' || data.name.split(/[\\/]/).some(part => part === '..' || part === '.') || [...data.name].some(char => char.charCodeAt(0) < 32))) throw new Error('Invalid download name.');
            return chrome.downloads.download({ url: validateGMUrl(data.url, 'download', session.origin), filename: data.name as string | undefined, saveAs: false, conflictAction: 'uniquify' });
        }
        case 'GM_notification': {
            if (typeof data.text !== 'string' || (data.title !== undefined && typeof data.title !== 'string')) throw new Error('Invalid notification.');
            const iconUrl = typeof data.image === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(data.image) ? data.image : chrome.runtime.getURL('icons/icon48.png');
            return chrome.notifications.create({ type: 'basic', iconUrl, title: data.title as string || script.name, message: data.text });
        }
        default: throw new Error('Unsupported GM API: ' + operation);
    }
}
export function notifyUrlChange(tabId: number, frameId: number, url: string) {
    for (const session of sessions) {
        if (session.sender.tab?.id === tabId && session.sender.frameId === frameId) { session.url = url; send(session, { type: 'URL_CHANGED', url }); }
    }
}
function acceptPort(port: chrome.runtime.Port) {
        if (port.name !== GM_PORT || port.sender?.id !== chrome.runtime.id || !port.sender.url || port.sender.tab?.id === undefined) { port.disconnect(); return; }
        let url: URL;
        try { url = new URL(port.sender.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { port.disconnect(); return; }
        const session: Session = { port, scriptId: '', token: '', origin: url.origin, url: url.href, sender: port.sender, initialized: false };
        sessions.add(session);
        let serial: Promise<unknown> = Promise.resolve();
        const timeout = setTimeout(() => { if (!session.initialized) port.disconnect(); }, 5000);
        port.onDisconnect.addListener(() => { void chrome.runtime.lastError; clearTimeout(timeout); sessions.delete(session); });
        port.onMessage.addListener((message: GMClientMessage) => {
            serial = serial.then(async () => {
                if (!message || typeof message !== 'object') throw new Error('Invalid GM message.');
                if (!session.initialized) {
                    if (message.type !== 'INIT' || typeof message.scriptId !== 'string' || typeof message.token !== 'string' || !message.token) throw new Error('Invalid GM initialization.');
                    session.scriptId = message.scriptId; session.token = message.token;
                    const initialize = writeQueue.then(async () => {
                    const script = await authenticate(session);
                    const actualWorld = (port.sender as chrome.runtime.MessageSender & { userScriptWorldId?: string }).userScriptWorldId;
                    if (actualWorld !== undefined) {
                        if (actualWorld !== await worldIdFor(script.id)) throw new Error('Wrong script world.');
                    }
                    const grants = script.grantedPermissions || [];
                    const canRead = hasGrant(grants, 'GM_getValue') || hasGrant(grants, 'GM_getValues') || hasGrant(grants, 'GM_addValueChangeListener');
                    const canList = canRead || hasGrant(grants, 'GM_listValues');
                    const stored = canList ? await chrome.storage.local.get(null) : {};
                    const migrationKey = 'gmMigration:' + JSON.stringify([session.scriptId, session.origin]);
                    if (canList && !stored[migrationKey] && Array.isArray(stored.legacyGMIds) && stored.legacyGMIds.includes(session.scriptId)) {
                        const legacyPrefix = `val_${session.scriptId}_${session.origin}_`;
                        const migrated: Record<string, unknown> = { [migrationKey]: true };
                        for (const [key, value] of Object.entries(stored)) {
                            if (key.startsWith(legacyPrefix) && !Object.hasOwn(stored, prefix(session) + key.slice(legacyPrefix.length))) migrated[prefix(session) + key.slice(legacyPrefix.length)] = value;
                        }
                        await chrome.storage.local.set(migrated);
                        Object.assign(stored, migrated);
                    }
                    const names = Object.keys(stored).filter(name => name.startsWith(prefix(session)));
                    const values = canRead ? Object.fromEntries(names.map(name => [name.slice(prefix(session).length), stored[name]])) : {};
                    session.initialized = true; clearTimeout(timeout);
                    send(session, { type: 'READY', values, keys: names.map(name => name.slice(prefix(session).length)) });
                    });
                    writeQueue = initialize.catch(() => {});
                    await initialize;
                    return;
                }
                if (message.type !== 'REQUEST' || !Number.isSafeInteger(message.id) || typeof message.operation !== 'string') throw new Error('Invalid GM request.');
                const task = () => execute(session, message.operation, message.data);
                try {
                    const result = writeQueue.then(task, task); writeQueue = result.catch(() => {});
                    send(session, { type: 'RESPONSE', id: message.id, result: await result });
                } catch (error) { send(session, { type: 'RESPONSE', id: message.id, error: error instanceof Error ? error.message : String(error) }); }
            }).catch(error => { send(session, { type: 'REVOKED', error: error instanceof Error ? error.message : String(error) }); port.disconnect(); });
        });
}
let connectionEvent: typeof chrome.runtime.onUserScriptConnect | undefined;
let storageListening = false;
export function revokeGMSessions() {
    for (const session of sessions) { send(session, {type:'REVOKED', error:'User script permission revoked.'}); session.port.disconnect(); }
}
export function setupGMListener() {
    const event = chrome.runtime.onUserScriptConnect;
    if (connectionEvent !== event) {
        try { connectionEvent?.removeListener(acceptPort); } catch { /* The optional permission may already be gone. */ }
        connectionEvent = event;
        event?.addListener(acceptPort);
    }
    if (storageListening) return;
    storageListening = true;
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || (!changes.scripts && !changes.extensionEnabled)) return;
        for (const session of sessions) void authenticate(session).catch(() => { send(session, { type: 'REVOKED', error: 'Script access revoked.' }); session.port.disconnect(); });
    });
}
