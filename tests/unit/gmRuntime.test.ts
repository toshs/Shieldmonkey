import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { getGMAPIScript } from '../../src/utils/scriptGenerator';
import type { Script } from '../../src/shared/types';

class Event<T extends (...args: never[]) => unknown> {
    listeners = new Set<T>();
    addListener = (listener: T) => { this.listeners.add(listener); };
    removeListener = (listener: T) => { this.listeners.delete(listener); };
    emit(...args: Parameters<T>) { for (const listener of this.listeners) listener(...args); }
}
const scriptCode = '// ==UserScript==\n// @name Private\n// @match https://example.com/*\n// ==/UserScript==';
let stored: Record<string, unknown>;
let connections: Event<(port: chrome.runtime.Port) => void>;
let storageEvents: Event<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>;
let tabsRemove: ReturnType<typeof vi.fn>;
let ports: Array<ReturnType<typeof createPort>>;
function createPort(url = 'https://example.com/', extensionId = 'test-extension') {
    const clientMessages = new Event<(message: unknown) => void>();
    const serverMessages = new Event<(message: unknown) => void>();
    const clientDisconnect = new Event<() => void>();
    const serverDisconnect = new Event<() => void>();
    const messages: Array<Record<string, unknown>> = [];
    let disconnected = false;
    const disconnect = () => { if (disconnected) return; disconnected = true; clientDisconnect.emit(); serverDisconnect.emit(); };
    const server = { name: 'shieldmonkey-gm-v1', sender: { id: extensionId, url, tab: { id: ports.length + 1 }, frameId: 0 }, onMessage: serverMessages, onDisconnect: serverDisconnect, disconnect,
        postMessage(message: unknown) { messages.push(message as Record<string, unknown>); queueMicrotask(() => clientMessages.emit(message)); } } as unknown as chrome.runtime.Port;
    const client = { name: 'shieldmonkey-gm-v1', onMessage: clientMessages, onDisconnect: clientDisconnect, disconnect,
        postMessage(message: unknown) { queueMicrotask(() => serverMessages.emit(message)); } };
    const pair = { client, server, messages, get disconnected() { return disconnected; } };
    ports.push(pair); connections.emit(server); return pair;
}
function prefix(id = 'private', origin = 'https://example.com') { return 'gmv1:' + JSON.stringify([id, origin]) + ':'; }
async function init(port: ReturnType<typeof createPort>, id = 'private', token = 'private-token') {
    port.client.postMessage({ type: 'INIT', scriptId: id, token });
    await vi.waitFor(() => expect(port.messages.some(message => message.type === 'READY' || message.type === 'REVOKED')).toBe(true));
}
beforeEach(async () => {
    vi.resetModules(); ports = []; connections = new Event(); storageEvents = new Event(); tabsRemove = vi.fn();
    stored = { securityVersion: 1, extensionEnabled: true, scripts: [{ id: 'private', name: 'Private', code: scriptCode, enabled: true, grantedPermissions: ['GM_getValue', 'GM_setValue', 'GM_listValues'], token: 'private-token' }],
        [prefix()+'secret']: 'own-secret', [prefix('other')+'secret']: 'other-script-secret', [prefix('private', 'https://other.example')+'secret']: 'other-origin-secret' };
    vi.stubGlobal('chrome', {
        runtime: { id: 'test-extension', getURL: (path: string) => 'chrome-extension://test-extension/'+path, onUserScriptConnect: connections },
        storage: { onChanged: storageEvents, local: {
            setAccessLevel: vi.fn().mockResolvedValue(undefined),
            get: vi.fn(async (keys: string | string[] | null) => keys === null ? { ...stored } : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in stored).map(key => [key, stored[key]]))),
            set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
            remove: vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete stored[key]; }),
        } },
        tabs: { remove: tabsRemove, create: vi.fn() }, downloads: { download: vi.fn() }, notifications: { create: vi.fn() },
    });
    const { setupGMListener } = await import('../../src/background/gmRequestHandler'); setupGMListener();
});
afterEach(async () => {
    for (const port of ports) port.server.postMessage({ type: 'REVOKED', error: 'test finished' });
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const port of ports) port.client.disconnect();
    vi.unstubAllGlobals();
});
describe('private GM runtime', () => {
    it('authenticates before returning values and only returns this script and origin', async () => {
        const port = createPort(); await init(port);
        expect(port.messages[0]).toEqual({ type: 'READY', values: { secret: 'own-secret' }, keys: ['secret'] });
    });
    it('rejects missing or invalid tokens and origins outside the matching scope', async () => {
        for (const [url, token] of [['https://example.com/', ''], ['https://example.com/', 'wrong'], ['https://other.example/', 'private-token']]) {
            const port = createPort(url); await init(port, 'private', token); expect(port.disconnected).toBe(true); expect(port.messages[0].type).toBe('REVOKED');
        }
    });
    it('does not allow the legacy ungranted close-tab exception', async () => {
        const port = createPort(); await init(port);
        port.client.postMessage({ type: 'REQUEST', id: 1, operation: 'GM_closeTab', data: {} });
        await vi.waitFor(() => expect(port.messages.some(message => message.id === 1)).toBe(true));
        expect(port.messages.find(message => message.id === 1)?.error).toMatch(/Permission denied/); expect(tabsRemove).not.toHaveBeenCalled();
    });
    it('revokes an already connected script when its token changes', async () => {
        const port = createPort(); await init(port);
        (stored.scripts as Script[])[0].token = 'rotated';
        port.client.postMessage({ type: 'REQUEST', id: 2, operation: 'GM_getValue', data: { key: 'secret' } });
        await vi.waitFor(() => expect(port.messages.some(message => message.id === 2)).toBe(true));
        expect(port.messages.find(message => message.id === 2)?.error).toMatch(/revoked/);
    });
    it('does not expose values when only key-listing was granted', async () => {
        (stored.scripts as Script[])[0].grantedPermissions = ['GM_listValues'];
        const port = createPort(); await init(port);
        expect(port.messages[0]).toEqual({ type: 'READY', values: {}, keys: ['secret'] });
    });
    it('starts generated code only after bootstrap, keeps sync reads, and never writes a site cache', async () => {
        const siteData = new Map([['other', 'keep'], ['sm_cache_private_secret', 'untrusted-site-value']]);
        const setSiteValue = vi.fn();
        const context = vm.createContext({ console, Map, Set, Promise, Object, String, Error, JSON,
            setTimeout: (fn: () => void, delay: number) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; }, clearTimeout,
            chrome: { runtime: { connect: () => createPort().client } },
            localStorage: { get length() { return siteData.size; }, key: (index: number) => [...siteData.keys()][index], removeItem: (name: string) => siteData.delete(name), setItem: setSiteValue },
            history: { pushState() {}, replaceState() {} }, addEventListener() {}, location: { href: 'https://example.com/' }, navigator: {},
        });
        context.window = context;
        const source = getGMAPIScript({id:'private',name:'Private',version:'1',permissions:['GM_getValue','GM_setValue','GM_listValues'],token:'private-token'}, 'window.loaded = GM_getValue("secret"); const saving = GM_setValue("new", 42); window.immediate = GM_getValue("new"); window.saving = saving;');
        await vm.runInContext(source, context); await context.saving;
        expect(context.loaded).toBe('own-secret'); expect(context.immediate).toBe(42); expect(stored[prefix()+'new']).toBe(42);
        expect(setSiteValue).not.toHaveBeenCalled(); expect(siteData).toEqual(new Map([['other','keep']]));
    });
    it('rejects privileged and cross-origin blob destinations', async () => {
        const {validateGMUrl} = await import('../../src/background/gmRequestHandler');
        for (const url of ['chrome://settings', 'javascript:alert(1)', 'file:///tmp/private', 'blob:https://other.example/id']) {
            expect(() => validateGMUrl(url, 'download', 'https://example.com')).toThrow();
        }
        expect(() => validateGMUrl('data:text/html,test', 'tab', 'https://example.com')).toThrow();
        expect(validateGMUrl('blob:https://example.com/id', 'download', 'https://example.com')).toBe('blob:https://example.com/id');
    });
    it('reconnects after a worker-side port closes, without executing the body twice', async () => {
        const context = vm.createContext({console,Map,Set,Promise,Object,String,Error,JSON,
            setTimeout:(fn:()=>void,delay:number)=>{const timer=setTimeout(fn,delay);timer.unref();return timer;},clearTimeout,
            chrome:{runtime:{connect:()=>createPort().client}},localStorage:{length:0},history:{pushState(){},replaceState(){}},
            addEventListener(){},location:{href:'https://example.com/'},navigator:{},
        });context.window=context;
        await vm.runInContext(getGMAPIScript({id:'private',name:'Private',version:'1',permissions:['GM_getValue','GM_setValue'],token:'private-token'},'window.starts=(window.starts||0)+1;'),context);
        ports[0].client.disconnect();
        await vi.waitFor(()=>expect(ports.length).toBe(2));
        await vi.waitFor(()=>expect(ports[1].messages.some(message=>message.type==='READY')).toBe(true));
        await vm.runInContext('GM_setValue("after-reconnect",42)',context);
        expect(context.starts).toBe(1);expect(stored[prefix()+'after-reconnect']).toBe(42);
    });
    it('does not execute user code in a world without extension messaging', async () => {
        const context = vm.createContext({ console, Set, Map, JSON, chrome: {} }); context.window = context;
        await vm.runInContext(getGMAPIScript({ id:'private', name:'Private',version:'1',permissions:[],token:'private-token' }, 'window.ran = true;'), context);
        expect(context.ran).toBeUndefined();
    });
});
