import type { Script } from '../shared/types';
import type { GMServerMessage } from '../shared/gm';
import { forgetNotificationSource, loadNotificationRoutes, notificationBinding, rememberNotificationSource, restoreNotificationSource, saveNotificationRoutes } from './notificationStorage';
import { isScriptMatchingUrl } from '../utils/scriptMatcher';

const PREFIX = 'sm-notification:';
const records = new Map<string, Notice>();
const MAX_PER_SOURCE = 32;
const MAX_TOTAL = 128;
export interface NotificationSource {
    key: object;
    scriptId: string;
    token: string;
    tabId: number;
    frameId: number;
    documentId?: string;
    origin: string;
    authorize(): Promise<Script>;
    send(message: GMServerMessage): void | Promise<void>;
}
interface Notice {
    id: string;
    source: NotificationSource;
    callbackId: number;
    url?: string;
    onclick: boolean;
    clicking: boolean;
    expiresAt: number;
    timeout?: ReturnType<typeof setTimeout>;
    closing?: ReturnType<typeof setTimeout>;
    pending?: { nonce: string; resolve(prevented: boolean): void };
}

let loaded: Promise<void> = Promise.resolve();
function persist() {
    return saveNotificationRoutes(() => [...records.values()].filter(record => record.source.documentId && !record.clicking).map(record => ({
        id: record.id, scriptId: record.source.scriptId, token: record.source.token, documentId: record.source.documentId!,
        tabId: record.source.tabId, frameId: record.source.frameId, origin: record.source.origin,
        callbackId: record.callbackId, url: record.url, onclick: record.onclick, expiresAt: record.expiresAt,
    })));
}
export async function registerNotificationSource(source: NotificationSource): Promise<number[]> {
    try { await loaded; } catch { return []; }
    rememberNotificationSource(source);
    const key = notificationBinding(source);
    for (const record of records.values()) if (source.documentId && notificationBinding(record.source) === key) record.source = source;
    return [...records.values()].filter(record => record.source.key === source.key && !record.clicking).map(record => record.callbackId);
}

export function validateNotificationUrl(value: unknown, origin: string, base: string, code: string): string {
    if (typeof value !== 'string' || !value || value.length > 8192 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid notification URL.');
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('Notification URLs must stay on the source origin.');
    if (!isScriptMatchingUrl(code, url.href)) throw new Error('Notification URL is outside the approved script scope.');
    return url.href;
}

async function checkSource(source: NotificationSource) {
    const script = await source.authorize();
    const [frame, tab] = await Promise.all([
        chrome.webNavigation.getFrame({ tabId: source.tabId, frameId: source.frameId }),
        chrome.tabs.get(source.tabId),
    ]);
    if (!frame || frame.errorOccurred || (frame.documentLifecycle && frame.documentLifecycle !== 'active') || (source.documentId && source.documentId !== frame.documentId)) throw new Error('Notification document expired.');
    const url = new URL(frame.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== source.origin || !isScriptMatchingUrl(script.code, frame.url)) throw new Error('Notification source changed.');
    if (source.frameId === 0 && (!tab.url || new URL(tab.url).origin !== source.origin || (tab.pendingUrl && tab.pendingUrl !== frame.url))) throw new Error('Notification tab is navigating.');
    await source.authorize();
    return { script, frame, tab };
}

async function finish(record: Notice, deliverDone = true) {
    if (records.get(record.id) !== record) return;
    records.delete(record.id);
    clearTimeout(record.timeout); clearTimeout(record.closing);
    record.pending?.resolve(true); record.pending = undefined;
    try { await persist(); } catch { /* Clear the native surface even if persistence fails. */ }
    try { await chrome.notifications.clear(record.id); } catch { /* It may already be closed. */ }
    if (deliverDone) {
        try {
            await checkSource(record.source);
            await record.source.send({ type: 'NOTIFICATION_EVENT', callbackId: record.callbackId, phase: 'done', clicked: record.clicking });
        } catch { /* Never deliver a callback into a revoked or replacement document. */ }
    }
}

function assertCapacity(sourceKey: object, callbackId: number) {
    const own = [...records.values()].filter(record => record.source.key === sourceKey);
    if (records.size >= MAX_TOTAL || own.length >= MAX_PER_SOURCE) throw new Error('Too many active notifications.');
    if (own.some(record => record.callbackId === callbackId)) throw new Error('Duplicate notification callback.');
}

export async function createGMNotification(source: NotificationSource, data: Record<string, unknown>): Promise<null> {
    await loaded;
    if (!Number.isSafeInteger(data.callbackId) || (data.callbackId as number) < 1 || typeof data.hasOnClick !== 'boolean'
        || typeof data.text !== 'string' || data.text.length > 4096
        || (data.title !== undefined && (typeof data.title !== 'string' || data.title.length > 256))
        || (data.silent !== undefined && typeof data.silent !== 'boolean')
        || (data.timeout !== undefined && (typeof data.timeout !== 'number' || !Number.isSafeInteger(data.timeout) || data.timeout < 0 || data.timeout > 600000))) throw new Error('Invalid notification.');
    assertCapacity(source.key, data.callbackId as number);
    const { script, frame } = await checkSource(source);
    let url: string | undefined;
    if (data.url !== undefined) {
        if (source.frameId !== 0) throw new Error('Subframe notifications cannot open a URL.');
        url = validateNotificationUrl(data.url, source.origin, frame.url, script.code);
    }
    const iconUrl = typeof data.image === 'string' && data.image.length <= 524288 && /^data:image\/(png|jpeg|gif|webp);base64,/.test(data.image) ? data.image : chrome.runtime.getURL('icons/icon48.png');
    assertCapacity(source.key, data.callbackId as number);
    const record: Notice = { id: PREFIX + crypto.randomUUID(), source, callbackId: data.callbackId as number, url, onclick: data.hasOnClick, clicking: false, expiresAt: Date.now() + ((data.timeout as number) || 86400000) };
    records.set(record.id, record);
    try {
        await persist();
        await chrome.notifications.create(record.id, {
            type: 'basic', iconUrl,
            title: `${source.origin} · ${script.name}`,
            message: data.title ? `${data.title}\n${data.text}` : data.text,
            ...(typeof data.silent === 'boolean' && !/Firefox\//.test(globalThis.navigator?.userAgent || '') ? { silent: data.silent } : {}),
        });
        await checkSource(source);
        if (!records.has(record.id)) { await chrome.notifications.clear(record.id); return null; }
        record.timeout = setTimeout(() => void finish(record), Math.max(0,record.expiresAt-Date.now()));
        return null;
    } catch (error) { await finish(record, false); throw error; }
}

export async function acknowledgeNotificationClick(sourceKey: object, data: Record<string, unknown>): Promise<null> {
    const record = [...records.values()].find(record => record.source.key === sourceKey && record.callbackId === data.callbackId);
    if (!record?.pending || typeof data.nonce !== 'string' || data.nonce !== record.pending.nonce || typeof data.preventDefault !== 'boolean') throw new Error('Unknown or expired notification click.');
    await checkSource(record.source);
    const pending = record.pending;
    if (!pending || pending.nonce !== data.nonce) throw new Error('Notification click expired.');
    record.pending = undefined; pending.resolve(data.preventDefault);
    return null;
}

async function focusSource(source: NotificationSource) {
    const { tab } = await checkSource(source);
    await chrome.tabs.update(source.tabId, { active: true });
    if (chrome.windows?.update && tab.windowId !== undefined) {
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* Some mobile browsers have no window API. */ }
    }
}

export async function handleNotificationClick(id: string) {
    try { await loaded; } catch { return; }
    const record = records.get(id);
    if (!record || record.clicking) return;
    record.clicking = true; clearTimeout(record.closing);
    try {
        // Consume the route before any action so a worker restart cannot replay it.
        await persist();
        await chrome.notifications.clear(id);
        await focusSource(record.source);
        let prevented = false;
        if (record.onclick) {
            await checkSource(record.source);
            prevented = await new Promise<boolean>(resolve => {
                const timer = setTimeout(() => { record.pending = undefined; resolve(true); }, 5000);
                const nonce = crypto.randomUUID();
                record.pending = { nonce, resolve: value => { clearTimeout(timer); resolve(value); } };
                Promise.resolve(record.source.send({ type: 'NOTIFICATION_EVENT', callbackId: record.callbackId, phase: 'click', nonce })).catch(() => record.pending?.resolve(true));
            });
        }
        if (!prevented && record.url && records.get(id) === record) {
            const { script, frame } = await checkSource(record.source);
            const url = validateNotificationUrl(record.url, record.source.origin, frame.url, script.code);
            // Never navigate or reuse another tab. No opener links the new tab
            // to the source, and the notification never supplies a tab ID.
            await chrome.tabs.create({ url, active: true });
        }
    } catch { /* Missing authorization or context cancels every default action. */ }
    finally { await finish(record); }
}

export function clearSourceNotifications(sourceKey: object) {
    forgetNotificationSource(sourceKey);
    for (const record of records.values()) if (record.source.key === sourceKey) void finish(record, false);
}
let listening = false;
export function setupNotificationListeners() {
    if (listening) return;
    listening = true;
    chrome.notifications.onClicked.addListener(id => { void handleNotificationClick(id); });
    chrome.notifications.onClosed.addListener(id => {
        void loaded.then(() => {
            const record = records.get(id);
            if (record && !record.clicking) {
                clearTimeout(record.closing);
                record.closing = setTimeout(() => void finish(record),150);
            }
        }).catch(()=>{});
    });
    loaded = loadNotificationRoutes().then(async routes => {
        for (const route of routes) {
            const record: Notice = { ...route, source:restoreNotificationSource(route), clicking:false };
            record.timeout = setTimeout(()=>void finish(record),Math.min(86400000,route.expiresAt-Date.now()));
            records.set(record.id,record);
        }
        await persist();
        const all=await chrome.notifications.getAll();
        await Promise.all(Object.keys(all).filter(id=>id.startsWith(PREFIX)&&!records.has(id)).map(id=>chrome.notifications.clear(id)));
    });
    void loaded.catch(error=>console.error('Notification state unavailable:',error));
}
