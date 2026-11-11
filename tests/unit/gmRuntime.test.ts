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
    const server = { name: 'shieldmonkey-gm-v1', sender: { id: extensionId, url, tab: { id: ports.length + 1 }, frameId: 0, documentId: 'doc-' + (ports.length + 1) }, onMessage: serverMessages, onDisconnect: serverDisconnect, disconnect,
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
    const sessionStore: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
        runtime: { id: 'test-extension', getURL: (path: string) => 'chrome-extension://test-extension/'+path, onUserScriptConnect: connections },
        storage: { session: { setAccessLevel: vi.fn().mockResolvedValue(undefined), get: vi.fn(async () => ({...sessionStore})), set: vi.fn(async values => { Object.assign(sessionStore,structuredClone(values)); }) }, onChanged: storageEvents, local: {
            setAccessLevel: vi.fn().mockResolvedValue(undefined),
            get: vi.fn(async (keys: string | string[] | null) => keys === null ? { ...stored } : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in stored).map(key => [key, stored[key]]))),
            set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
            remove: vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete stored[key]; }),
        } },
        permissions: { contains: vi.fn().mockResolvedValue(true) },
        tabs: { remove: tabsRemove, create: vi.fn(), update: vi.fn().mockResolvedValue({}), get: vi.fn(async (id: number) => ({ id, url: ports[id-1]?.server.sender?.url, windowId: 1 })) },
        webNavigation: { getFrame: vi.fn(async ({tabId}: {tabId: number}) => ({ url: ports[tabId-1]?.server.sender?.url, documentId: 'doc-'+tabId })) },
        downloads: { download: vi.fn() }, notifications: { create: vi.fn(async (id: string) => id), clear: vi.fn().mockResolvedValue(true) },
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
    it('denies requests when the browser userScripts permission is revoked', async () => {
        const port=createPort();await init(port);
        vi.mocked(chrome.permissions.contains).mockResolvedValue(false);
        port.client.postMessage({type:'REQUEST',id:3,operation:'GM_getValue',data:{key:'secret'}});
        await vi.waitFor(()=>expect(port.messages.some(message=>message.id===3)).toBe(true));
        expect(port.messages.find(message=>message.id===3)?.error).toMatch(/revoked/);
    });
    it('initializes safely before Firefox exposes its optional runtime event', async () => {
        const {setupGMListener} = await import('../../src/background/gmRequestHandler');
        const runtime = chrome.runtime as unknown as {onUserScriptConnect?:typeof chrome.runtime.onUserScriptConnect};
        delete runtime.onUserScriptConnect;
        expect(()=>setupGMListener()).not.toThrow();
        runtime.onUserScriptConnect=connections as unknown as typeof chrome.runtime.onUserScriptConnect;
        setupGMListener();
        const port=createPort();await init(port);expect(port.messages[0].type).toBe('READY');
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
    it.each([[false, false, 'own-secret'], [true, false, 'first'], [false, true, 'second']])('keeps confirmed GM values after successive writes: %s / %s', async (firstOK, secondOK, expected) => {
        const originalSet = vi.mocked(chrome.storage.local.set).getMockImplementation()!;
        vi.mocked(chrome.storage.local.set).mockImplementationOnce(async fields => { if (!firstOK) throw new Error('QUOTA_BYTES exceeded'); await originalSet(fields); })
            .mockImplementationOnce(async fields => { if (!secondOK) throw new Error('QUOTA_BYTES exceeded'); await originalSet(fields); });
        const context = vm.createContext({console:{log(){},warn(){},error(){}},Map,Set,Promise,Object,String,Error,JSON,
            setTimeout:(fn:()=>void,delay:number)=>{const timer=setTimeout(fn,delay);timer.unref();return timer;},clearTimeout,
            chrome:{runtime:{connect:()=>createPort().client}},localStorage:{length:0},history:{pushState(){},replaceState(){}},
            addEventListener(){},location:{href:'https://example.com/'},navigator:{},
        });context.window=context;
        await vm.runInContext(getGMAPIScript({id:'private',name:'Private',version:'1',permissions:['GM_getValue','GM_setValue'],token:'private-token'},
            'window.events=[]; window.a=GM.setValue("secret","first").catch(()=>{}); window.b=GM.setValue("secret","second").catch(()=>{});'),context);
        await context.a;await context.b;
        expect(vm.runInContext('GM_getValue("secret")',context)).toBe(expected);
        expect(stored[prefix()+'secret']).toBe(expected);
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
    it('delivers notification callbacks only in their isolated runtime, with preventDefault and legacy forms', async () => {
        (stored.scripts as Script[])[0].grantedPermissions = ['GM_notification'];
        const context = vm.createContext({console,Map,Set,Promise,Object,String,Error,JSON,Event:globalThis.Event,
            setTimeout:(fn:()=>void,delay:number)=>{const timer=setTimeout(fn,delay);timer.unref();return timer;},clearTimeout,
            chrome:{runtime:{connect:()=>createPort().client}},localStorage:{length:0},history:{pushState(){},replaceState(){}},
            addEventListener(){},location:{href:'https://example.com/'},navigator:{},
        }); context.window=context;
        await vm.runInContext(getGMAPIScript({id:'private',name:'Private',version:'1',permissions:['GM_notification'],token:'private-token'},
            'window.completed=GM.notification({text:"hello",url:"/next",onclick:event=>{window.clicked=(window.clicked||0)+1;event.preventDefault();},ondone:()=>{window.done=true;}}); window.legacy=GM_notification("legacy","Title",undefined,()=>{window.legacyClicked=true;});'),context);
        await vi.waitFor(()=>expect(chrome.notifications.create).toHaveBeenCalledTimes(2));
        const {handleNotificationClick}=await import('../../src/background/notifications');
        for(const args of vi.mocked(chrome.notifications.create).mock.calls) await handleNotificationClick(args[0] as string);
        expect(await context.completed).toBe(true); expect(context.clicked).toBe(1);expect(context.done).toBe(true);
        expect(context.legacy).toBeUndefined();expect(context.legacyClicked).toBe(true);
        expect(chrome.tabs.create).not.toHaveBeenCalled();expect(chrome.tabs.update).toHaveBeenCalledWith(1,{active:true});
    });
    it.each(['grant','token','enabled','browser permission'])('rechecks %s at notification click time', async change => {
        const script=(stored.scripts as Script[])[0];script.grantedPermissions=['GM_notification'];
        const port=createPort();await init(port);
        port.client.postMessage({type:'REQUEST',id:1,operation:'GM_notification',data:{text:'notice',callbackId:1,hasOnClick:false,url:'/next'}});
        await vi.waitFor(()=>expect(port.messages.some(message=>message.id===1)).toBe(true));
        expect(port.messages.find(message=>message.id===1)?.error).toBeUndefined();
        if(change==='grant')script.grantedPermissions=[];
        if(change==='token')script.token='rotated';
        if(change==='enabled')script.enabled=false;
        if(change==='browser permission')vi.mocked(chrome.permissions.contains).mockResolvedValue(false);
        const {handleNotificationClick}=await import('../../src/background/notifications');
        await handleNotificationClick(vi.mocked(chrome.notifications.create).mock.calls[0][0] as string);
        expect(chrome.tabs.create).not.toHaveBeenCalled();expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(port.messages.some(message=>message.type==='NOTIFICATION_EVENT')).toBe(false);
    });
    it("cannot acknowledge another origin's notification even for the same script and token", async () => {
        const script=(stored.scripts as Script[])[0];script.grantedPermissions=['GM_notification'];
        script.code=scriptCode.replace('// ==/UserScript==','// @match https://other.example/*\n// ==/UserScript==');
        const source=createPort(),other=createPort('https://other.example/');await init(source);await init(other);
        source.client.postMessage({type:'REQUEST',id:1,operation:'GM_notification',data:{text:'notice',callbackId:1,hasOnClick:true,url:'/next',tabId:999,origin:'https://other.example'}});
        await vi.waitFor(()=>expect(source.messages.some(message=>message.id===1)).toBe(true));
        const {handleNotificationClick}=await import('../../src/background/notifications');
        const handling=handleNotificationClick(vi.mocked(chrome.notifications.create).mock.calls[0][0] as string);
        await vi.waitFor(()=>expect(source.messages.some(message=>message.phase==='click')).toBe(true));
        const nonce=source.messages.find(message=>message.phase==='click')!.nonce;
        other.client.postMessage({type:'REQUEST',id:2,operation:'GM_notification',data:{action:'click',callbackId:1,nonce,preventDefault:false}});
        await vi.waitFor(()=>expect(other.messages.some(message=>message.id===2)).toBe(true));
        expect(other.messages.find(message=>message.id===2)?.error).toMatch(/expired/);
        source.client.postMessage({type:'REQUEST',id:3,operation:'GM_notification',data:{action:'click',callbackId:1,nonce,preventDefault:true}});
        await handling;
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(1,{active:true});
        expect(other.messages.some(message=>message.type==='NOTIFICATION_EVENT')).toBe(false);
    });
    it('does not execute user code in a world without extension messaging', async () => {
        const context = vm.createContext({ console, Set, Map, JSON, chrome: {} }); context.window = context;
        await vm.runInContext(getGMAPIScript({ id:'private', name:'Private',version:'1',permissions:[],token:'private-token' }, 'window.ran = true;'), context);
        expect(context.ran).toBeUndefined();
    });
});
