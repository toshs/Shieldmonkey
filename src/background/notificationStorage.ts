import type { Script } from '../shared/types';
import { hasGrant } from '../shared/policy';
import { stateReady } from './state';
import type { NotificationSource } from './notifications';

const STORE_KEY = 'gmNotificationRoutesV1';
export interface NotificationRoute {
    id: string; scriptId: string; token: string; documentId: string;
    tabId: number; frameId: number; origin: string;
    callbackId: number; url?: string; onclick: boolean; expiresAt: number;
}
export function notificationBinding(source: Pick<NotificationSource, 'scriptId' | 'token' | 'documentId' | 'tabId' | 'frameId' | 'origin'>) {
    return JSON.stringify([source.scriptId, source.token, source.documentId, source.tabId, source.frameId, source.origin]);
}
const sources = new Map<string, NotificationSource>();
const waiting = new Map<string, Set<(source: NotificationSource) => void>>();
export function rememberNotificationSource(source: NotificationSource) {
    const key = notificationBinding(source); sources.set(key, source);
    for (const done of waiting.get(key) ?? []) done(source);
}
export function forgetNotificationSource(sourceKey: object) {
    for (const [key, source] of sources) if (source.key === sourceKey) sources.delete(key);
}
async function currentSource(route: NotificationRoute): Promise<NotificationSource> {
    const key = notificationBinding(route), source = sources.get(key);
    if (source) return source;
    return new Promise((resolve, reject) => {
        const listeners = waiting.get(key) ?? new Set(); waiting.set(key, listeners);
        const done = (source: NotificationSource) => { clearTimeout(timer); listeners.delete(done); if (!listeners.size) waiting.delete(key); resolve(source); };
        const timer = setTimeout(() => { listeners.delete(done); if (!listeners.size) waiting.delete(key); reject(new Error('Notification document did not reconnect.')); }, 4000);
        listeners.add(done);
    });
}
export function restoreNotificationSource(route: NotificationRoute): NotificationSource {
    return { ...route, key: {},
        authorize: async () => {
            await stateReady;
            const [data, allowed] = await Promise.all([chrome.storage.local.get(['scripts', 'extensionEnabled']), chrome.permissions.contains({permissions:['userScripts']})]);
            const script = (data.scripts as Script[] | undefined)?.find(script => script.id === route.scriptId);
            if (!allowed || data.extensionEnabled === false || !script?.enabled || script.pendingApproval || script.token !== route.token || !hasGrant(script.grantedPermissions || [], 'GM_notification')) throw new Error('Notification access revoked.');
            return script;
        },
        send: async message => { const live = await currentSource(route); await live.authorize(); await live.send(message); },
    };
}
export async function loadNotificationRoutes(): Promise<NotificationRoute[]> {
    if (chrome.storage.session.setAccessLevel) await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    const saved = (await chrome.storage.session.get(STORE_KEY))[STORE_KEY];
    if (!Array.isArray(saved)) return [];
    return saved.slice(0,128).filter((route: NotificationRoute) => {
        if (!route || typeof route.id !== 'string' || !route.id.startsWith('sm-notification:') || route.id.length > 128
            || typeof route.scriptId !== 'string' || !route.scriptId || typeof route.token !== 'string' || !route.token
            || typeof route.documentId !== 'string' || !route.documentId || typeof route.origin !== 'string'
            || !Number.isSafeInteger(route.tabId) || route.tabId < 0 || !Number.isSafeInteger(route.frameId) || route.frameId < 0
            || !Number.isSafeInteger(route.callbackId) || route.callbackId < 1 || typeof route.onclick !== 'boolean'
            || typeof route.expiresAt !== 'number' || !Number.isFinite(route.expiresAt) || route.expiresAt <= Date.now()
            || (route.url !== undefined && typeof route.url !== 'string')) return false;
        try { return ['http:','https:'].includes(new URL(route.origin).protocol); } catch { return false; }
    });
}
let saving: Promise<unknown> = Promise.resolve();
export function saveNotificationRoutes(snapshot: () => NotificationRoute[]) {
    const work = () => chrome.storage.session.set({[STORE_KEY]:snapshot()});
    const next = saving.then(work,work); saving=next.catch(()=>{});return next;
}
