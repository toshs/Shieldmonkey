import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Script } from '../../src/shared/types';
import type { GMServerMessage } from '../../src/shared/gm';
import type { NotificationSource } from '../../src/background/notifications';

let api: typeof import('../../src/background/notifications');
let source: NotificationSource;
let script: Script;
let click: (id: string) => void;
let closed: (id: string) => void;
const code = '// ==UserScript==\n// @name Notice\n// @match https://example.com/allowed/*\n// @exclude https://example.com/allowed/private*\n// ==/UserScript==';
const input = (extra: Record<string, unknown> = {}) => ({ text: 'Message', callbackId: 1, hasOnClick: false, ...extra });
const id = () => vi.mocked(chrome.notifications.create).mock.calls.at(-1)![0] as string;

beforeEach(async () => {
    vi.resetModules();
    script = { id: 'notice', name: 'Notice', code, enabled: true, grantedPermissions: ['GM_notification'], token: 'notice-token' };
    source = { key: {}, scriptId: 'notice', token: 'notice-token', tabId: 17, frameId: 0, documentId: 'document-a', origin: 'https://example.com', authorize: vi.fn(async () => script), send: vi.fn() };
    const sessionStore: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
        storage: { local: { get: vi.fn(async () => ({securityVersion:1,scripts:[script],extensionEnabled:true})) }, session: { setAccessLevel: vi.fn().mockResolvedValue(undefined), get: vi.fn(async () => ({...sessionStore})), set: vi.fn(async values => { Object.assign(sessionStore,structuredClone(values)); }) } },
        permissions: { contains: vi.fn().mockResolvedValue(true) },
        runtime: { getURL: (p: string) => 'chrome-extension://test/' + p },
        webNavigation: { getFrame: vi.fn(async () => ({ documentId: 'document-a', url: 'https://example.com/allowed/source' })) },
        tabs: { get: vi.fn(async () => ({ id: 17, windowId: 1, url: 'https://example.com/allowed/source' })), update: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
        windows: { update: vi.fn(async () => ({})) },
        notifications: {
            create: vi.fn(async (id: string) => id), clear: vi.fn(async () => true), getAll: vi.fn(async () => ({})),
            onClicked: { addListener: vi.fn(listener => { click = listener; }) },
            onClosed: { addListener: vi.fn(listener => { closed = listener; }) },
        },
    });
    api = await import('../../src/background/notifications');
    api.setupNotificationListeners();
});
afterEach(() => { api.clearSourceNotifications(source.key); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('origin-bound userscript notifications', () => {
    it('accepts relative URLs only inside the same origin and approved scope', () => {
        expect(api.validateNotificationUrl('/allowed/next?q=1', source.origin, 'https://example.com/allowed/source', code)).toBe('https://example.com/allowed/next?q=1');
        expect(api.validateNotificationUrl('https://EXAMPLE.com:443/allowed/next', source.origin, source.origin, code)).toBe('https://example.com/allowed/next');
    });
    it.each([
        'https://other.example/allowed/', 'http://example.com/allowed/', 'https://example.com:444/allowed/',
        'https://example.com.evil.test/allowed/', '//evil.test/allowed/', 'https://user:pass@example.com/allowed/',
        'javascript:alert(1)', 'data:text/html,test', 'blob:https://example.com/id', 'file:///tmp/test',
        'chrome://settings', 'chrome-extension://test/options.html', 'about:blank',
        '/outside', '/allowed/private', '/allowed/line\nbreak',
    ])('rejects forbidden destination %s', url => {
        expect(() => api.validateNotificationUrl(url, source.origin, 'https://example.com/allowed/source', code)).toThrow();
    });
    it('focuses only the browser-bound source tab, ignoring supplied tab IDs and origins', async () => {
        await api.createGMNotification(source, input({ tabId: 999, frameId: 99, origin: 'https://evil.test' }));
        await api.handleNotificationClick(id());
        expect(chrome.tabs.get).toHaveBeenCalledWith(17);
        expect(chrome.tabs.update).toHaveBeenCalledWith(17, { active: true });
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(source.send).toHaveBeenCalledWith({ type: 'NOTIFICATION_EVENT', callbackId: 1, phase: 'done', clicked: true });
    });
    it('opens an allowed URL in a new tab without an opener or navigating another tab', async () => {
        await api.createGMNotification(source, input({ url: '/allowed/next' }));
        await api.handleNotificationClick(id());
        expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://example.com/allowed/next', active: true });
        expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(17,{active:true});
    });
    it('rejects cross-origin URLs before showing a notification and does not fetch remote icons', async () => {
        await expect(api.createGMNotification(source, input({ url: 'https://evil.test/' }))).rejects.toThrow(/origin/);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
        await api.createGMNotification(source, input({ image: 'https://evil.test/tracker.png' }));
        expect(vi.mocked(chrome.notifications.create).mock.calls[0][1]).toMatchObject({ iconUrl: 'chrome-extension://test/icons/icon48.png', title: 'https://example.com · Notice' });
    });
    it('does not promote a subframe notification into top-level navigation', async () => {
        source.frameId = 4;
        await expect(api.createGMNotification(source, input({ url: '/allowed/next' }))).rejects.toThrow(/Subframe/);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
    it.each(['document', 'missing document ID', 'inactive document', 'origin', 'scope', 'pending', 'authorization'])('cancels a stale %s before focus, callback, or URL action', async kind => {
        await api.createGMNotification(source, input({ url: '/allowed/next', hasOnClick: true }));
        if (kind === 'document') vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({ documentId: 'replacement', url: 'https://example.com/allowed/source' } as chrome.webNavigation.GetFrameResultDetails);
        if (kind === 'missing document ID') vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({ url: 'https://example.com/allowed/source' } as chrome.webNavigation.GetFrameResultDetails);
        if (kind === 'inactive document') vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({ documentId: 'document-a', documentLifecycle: 'cached', url: 'https://example.com/allowed/source' } as chrome.webNavigation.GetFrameResultDetails);
        if (kind === 'origin') vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({ documentId: 'document-a', url: 'https://evil.test/' } as chrome.webNavigation.GetFrameResultDetails);
        if (kind === 'scope') script.code = code.replace('/allowed/*', '/another/*');
        if (kind === 'pending') vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 17, url: 'https://example.com/allowed/source', pendingUrl: 'https://evil.test/' } as chrome.tabs.Tab);
        if (kind === 'authorization') vi.mocked(source.authorize).mockRejectedValue(new Error('Revoked'));
        await api.handleNotificationClick(id());
        expect(chrome.tabs.create).not.toHaveBeenCalled(); expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(source.send).not.toHaveBeenCalled(); expect(chrome.notifications.clear).toHaveBeenCalled();
    });
    it('honors preventDefault and requires a nonce bound to the exact source', async () => {
        const wrongSource = {};
        const errors: string[] = [];
        vi.mocked(source.send).mockImplementation((message: GMServerMessage) => {
            if (message.type !== 'NOTIFICATION_EVENT' || message.phase !== 'click') return;
            void (async () => {
                for (const [key, nonce] of [[wrongSource, message.nonce], [source.key, 'forged']] as const) {
                    try { await api.acknowledgeNotificationClick(key, { callbackId: 1, nonce, preventDefault: false }); }
                    catch (error) { errors.push((error as Error).message); }
                }
                await api.acknowledgeNotificationClick(source.key, { callbackId: 1, nonce: message.nonce, preventDefault: true });
            })();
        });
        await api.createGMNotification(source, input({ url: '/allowed/next', hasOnClick: true }));
        await api.handleNotificationClick(id());
        expect(errors).toHaveLength(2); expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(source.send).toHaveBeenLastCalledWith({ type: 'NOTIFICATION_EVENT', callbackId: 1, phase: 'done', clicked: true });
        await expect(api.acknowledgeNotificationClick(source.key, { callbackId: 1, nonce: 'replay', preventDefault: false })).rejects.toThrow(/expired/);
    });
    it('does not follow a URL when the callback never acknowledges the click', async () => {
        await api.createGMNotification(source, input({ url: '/allowed/next', hasOnClick: true }));
        vi.useFakeTimers();
        const result = api.handleNotificationClick(id());
        await vi.waitFor(() => expect(source.send).toHaveBeenCalledWith(expect.objectContaining({ phase: 'click' })));
        await vi.advanceTimersByTimeAsync(5000); await result;
        expect(chrome.tabs.create).not.toHaveBeenCalled();
    });
    it('clears disconnected notifications and ignores unknown or replayed native clicks', async () => {
        await api.createGMNotification(source, input()); const nativeId = id();
        api.clearSourceNotifications(source.key);
        await api.handleNotificationClick(nativeId); await api.handleNotificationClick('unrelated-notification');
        expect(chrome.tabs.update).not.toHaveBeenCalled(); expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(source.send).not.toHaveBeenCalled();
    });
    it('delivers ondone once when closed, without treating dismissal as a click', async () => {
        await api.createGMNotification(source, input());
        closed(id()); closed(id());
        await vi.waitFor(() => expect(source.send).toHaveBeenCalledTimes(1));
        expect(source.send).toHaveBeenCalledWith({ type: 'NOTIFICATION_EVENT', callbackId: 1, phase: 'done', clicked: false });
        expect(chrome.tabs.update).not.toHaveBeenCalled();
    });
    it('routes the actual browser click event and cleans up old worker notifications only', async () => {
        await api.createGMNotification(source, input()); click(id());
        await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalledWith(17, { active: true }));
        vi.mocked(chrome.notifications.getAll).mockResolvedValue({ 'sm-notification:old-worker': true, 'other-notification': true });
        // A fresh module models a worker restart; it never recovers callbacks from untrusted IDs.
        vi.resetModules(); const fresh = await import('../../src/background/notifications'); fresh.setupNotificationListeners();
        await vi.waitFor(() => expect(chrome.notifications.clear).toHaveBeenCalledWith('sm-notification:old-worker'));
        expect(chrome.notifications.clear).not.toHaveBeenCalledWith('other-notification');
    });
    it('restores a suspended worker only to the same script, token, origin and document', async () => {
        await api.registerNotificationSource(source);
        await api.createGMNotification(source,input({url:'/allowed/next',hasOnClick:true}));
        const nativeId=id();
        vi.resetModules(); const fresh=await import('../../src/background/notifications');fresh.setupNotificationListeners();
        const reconnected: NotificationSource={...source,key:{},send:vi.fn(message=>{
            if(message.type==='NOTIFICATION_EVENT'&&message.phase==='click')void fresh.acknowledgeNotificationClick(reconnected.key,{callbackId:1,nonce:message.nonce,preventDefault:true});
        })};
        expect(await fresh.registerNotificationSource(reconnected)).toEqual([1]);
        await fresh.handleNotificationClick(nativeId);
        expect(reconnected.send).toHaveBeenCalledWith(expect.objectContaining({phase:'click'}));
        expect(source.send).not.toHaveBeenCalled();expect(chrome.tabs.create).not.toHaveBeenCalled();
        await fresh.handleNotificationClick(nativeId);
        expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
        expect((await chrome.storage.session.get('gmNotificationRoutesV1')).gmNotificationRoutesV1).toEqual([]);
        fresh.clearSourceNotifications(reconnected.key);
    });
    it('rejects restored metadata after the document is replaced, before any focus or callback', async () => {
        await api.createGMNotification(source,input({hasOnClick:true}));const nativeId=id();
        vi.resetModules();const fresh=await import('../../src/background/notifications');fresh.setupNotificationListeners();
        vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({documentId:'replacement',url:'https://example.com/allowed/source'} as chrome.webNavigation.GetFrameResultDetails);
        const replacement={...source,key:{},documentId:'replacement'};
        expect(await fresh.registerNotificationSource(replacement)).toEqual([]);
        await fresh.handleNotificationClick(nativeId);
        expect(chrome.tabs.update).not.toHaveBeenCalled();expect(source.send).not.toHaveBeenCalled();
        fresh.clearSourceNotifications(replacement.key);
    });
    it('bounds active notifications per source', async () => {
        for (let callbackId = 1; callbackId <= 32; callbackId++) await api.createGMNotification(source, input({ callbackId }));
        await expect(api.createGMNotification(source, input({ callbackId: 33 }))).rejects.toThrow(/Too many/);
    });
});
