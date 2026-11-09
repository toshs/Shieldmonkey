(async function(scope) {
    const SCRIPT_NAME = "__SCRIPT_NAME__";
    const SCRIPT_ID = "__SCRIPT_ID__";
    const SCRIPT_TOKEN = "__SCRIPT_TOKEN__";
    const granted = new Set(JSON.parse('__GRANTED_PERMISSIONS__'));
    const info = { script: JSON.parse('__SCRIPT_OBJ__'), scriptHandler: 'Shieldmonkey', version: '0.5.0' };
    const api = typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
    // The default shared world has messaging disabled. Never execute the user
    // body there, including after Chromium's per-document world limit fallback.
    if (!api?.runtime?.connect) { console.warn('ShieldMonkey: isolated execution unavailable for ' + SCRIPT_NAME); return; }
    const connectNative = api.runtime.connect.bind(api.runtime);
    const values = new Map(), keys = new Set(), changes = new Map(), requests = new Map(), revisions = new Map();
    let port, nextId = 0, listenerId = 0, ready = false, revoked = false, reconnecting = false;
    let initialResolve, initialReject;
    const initial = new Promise((resolve, reject) => { initialResolve = resolve; initialReject = reject; });
    function permitted(operation) {
        if (granted.has(operation)) return true;
        const single = { GM_getValues: 'GM_getValue', GM_setValues: 'GM_setValue', GM_deleteValues: 'GM_deleteValue' };
        return !!single[operation] && granted.has(single[operation]);
    }
    function check(operation) { if (!permitted(operation)) throw new Error('Permission denied: ' + operation); }
    function notify(name, oldValue, value, remote) {
        for (const listener of changes.values()) if (listener.key === name) {
            try { listener.callback(name, oldValue, value, remote); } catch (error) { console.error('GM value listener failed:', error); }
        }
    }
    function apply(name, value) { if (value === undefined) { values.delete(name); keys.delete(name); } else { values.set(name, value); keys.add(name); } }
    function rejectRequests(error) { for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error); } requests.clear(); }
    function connect() {
        return new Promise(resolve => {
        try {
            port = connectNative({ name: 'shieldmonkey-gm-v1' });
            const current = port;
            const timeout = setTimeout(() => { if (!ready && current === port) current.disconnect(); resolve(false); }, 5000);
            current.onMessage.addListener(message => {
                if (current !== port || !message) return;
                if (message.type === 'READY') {
                    clearTimeout(timeout); values.clear(); keys.clear();
                    for (const [name, value] of Object.entries(message.values)) values.set(name, value);
                    for (const name of message.keys) keys.add(name);
                    ready = true; initialResolve(); resolve(true);
                } else if (message.type === 'RESPONSE') {
                    const request = requests.get(message.id);
                    if (request) { clearTimeout(request.timer); requests.delete(message.id); if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result); }
                } else if (message.type === 'VALUE_CHANGED' && message.remote) {
                    const old = values.get(message.key); apply(message.key, message.value); notify(message.key, old, message.value, true);
                } else if (message.type === 'KEYS_CHANGED') {
                    keys.clear(); for (const name of message.keys) keys.add(name);
                } else if (message.type === 'URL_CHANGED') {
                    checkUrlChange();
                } else if (message.type === 'REVOKED') {
                    revoked = true; initialReject(new Error(message.error)); rejectRequests(new Error(message.error)); current.disconnect();
                }
            });
            current.onDisconnect.addListener(() => {
                void api.runtime.lastError;
                clearTimeout(timeout);
                if (current !== port) return;
                const wasReady = ready; ready = false; resolve(false);
                rejectRequests(new Error('GM connection closed.'));
                if (!wasReady && !reconnecting) { initialReject(new Error('Isolated initialization failed.')); return; }
                if (!revoked && !reconnecting) void reconnect();
            });
            current.postMessage({ type: 'INIT', scriptId: SCRIPT_ID, token: SCRIPT_TOKEN });
        } catch (error) { initialReject(error); revoked = true; rejectRequests(error); resolve(false); }
        });
    }
    async function reconnect() {
        reconnecting = true;
        for (let attempt = 0; attempt < 10 && !revoked && !ready; attempt++) {
            await new Promise(resolve => setTimeout(resolve, Math.min(5000, 250 * 2 ** attempt)));
            await connect();
        }
        reconnecting = false;
    }
    function request(operation, data) {
        check(operation);
        return new Promise((resolve, reject) => {
            if (!ready || revoked) { reject(new Error('GM connection is not ready.')); return; }
            const id = ++nextId;
            const timer = setTimeout(() => { requests.delete(id); reject(new Error('GM operation timed out.')); }, 15000);
            requests.set(id, { resolve, reject, timer });
            try { port.postMessage({ type: 'REQUEST', id, operation, data }); }
            catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
        });
    }
    async function write(operation, entries, deleting = false) {
        check(operation);
        const previous = entries.map(([name]) => [name, values.get(name)]);
        const versions = entries.map(([name]) => { const version = (revisions.get(name) || 0) + 1; revisions.set(name, version); return version; });
        entries.forEach(([name, value], index) => { apply(name, deleting ? undefined : value); notify(name, previous[index][1], deleting ? undefined : value, false); });
        const data = operation === 'GM_setValue' ? { key: entries[0][0], value: entries[0][1] }
            : operation === 'GM_deleteValue' ? { key: entries[0][0] }
            : deleting ? { keys: entries.map(([name]) => name) } : { values: Object.fromEntries(entries) };
        try {
            await request(operation, data);
            entries.forEach(([name, value], index) => { if (revisions.get(name) === versions[index]) apply(name, deleting ? undefined : value); });
        } catch (error) {
            previous.forEach(([name, value], index) => { if (revisions.get(name) === versions[index]) apply(name, value); });
            console.error('ShieldMonkey: GM save failed:', error); throw error;
        }
    }
    connect();
    try { await initial; } catch (error) { console.warn('ShieldMonkey: ' + SCRIPT_NAME + ' did not start:', error); return; }
    // Remove only this script's legacy public cache, without trusting its values.
    try {
        const prefix = 'sm_cache_' + SCRIPT_ID + '_';
        for (let i = localStorage.length - 1; i >= 0; i--) { const name = localStorage.key(i); if (name?.startsWith(prefix)) localStorage.removeItem(name); }
    } catch { /* Storage can be unavailable on privacy-restricted pages. */ }
    const getValue = (name, fallback) => { check('GM_getValue'); return values.has(String(name)) ? values.get(String(name)) : fallback; };
    const getValues = input => {
        check('GM_getValues');
        const names = Array.isArray(input) ? input : Object.keys(input);
        return Object.fromEntries(names.filter(name => values.has(name) || !Array.isArray(input)).map(name => [name, values.has(name) ? values.get(name) : input[name]]));
    };
    const setValue = (name, value) => write('GM_setValue', [[String(name), value]]);
    const deleteValue = name => write('GM_deleteValue', [[String(name), undefined]], true);
    const listValues = () => { check('GM_listValues'); return [...keys]; };
    const setValues = input => write('GM_setValues', Object.entries(input));
    const deleteValues = names => write('GM_deleteValues', names.map(name => [String(name), undefined]), true);
    const addListener = (name, callback) => { check('GM_addValueChangeListener'); const id = ++listenerId; changes.set(id, { key: String(name), callback }); return id; };
    const removeListener = id => { if (!permitted('GM_removeValueChangeListener')) check('GM_addValueChangeListener'); changes.delete(id); };
    const openInTab = (url, options) => request('GM_openInTab', { url: String(url), options });
    const closeTab = () => request('GM_closeTab', {});
    const download = (details, name) => {
        const data = typeof details === 'string' ? { url: details, name } : { url: details.url, name: details.name };
        void request('GM_download', data).catch(error => console.error('GM_download failed:', error));
        return { abort() { console.warn('Download cancellation is not supported.'); } };
    };
    const notification = (text, title, image) => {
        const input = typeof text === 'string' ? { text, title, image } : { text: text.text, title: text.title, image: text.image };
        void request('GM_notification', input).catch(error => console.error('GM_notification failed:', error));
    };
    const setClipboard = data => { check('GM_setClipboard'); return navigator.clipboard.writeText(String(data)); };
    const addStyle = css => { const style = document.createElement('style'); style.textContent = css; (document.head || document.documentElement).append(style); return style; };
    const addElement = (parent, tag, attributes) => {
        if (typeof parent === 'string') { attributes = tag; tag = parent; parent = document.body || document.documentElement; }
        const element = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes || {})) { if (name === 'textContent') element.textContent = value; else element.setAttribute(name, value); }
        parent.append(element); return element;
    };
    const GM = { info, getValue: async (...args) => getValue(...args), getValues: async (...args) => getValues(...args),
        setValue, setValues, deleteValue, deleteValues, listValues: async () => listValues(),
        addValueChangeListener: addListener, removeValueChangeListener: removeListener,
        openInTab, closeTab, download, notification, setClipboard, addStyle, addElement, log: console.log.bind(console, 'GM:') };
    scope.GM = GM; scope.GM_info = info;
    const bindings = { GM_getValue: getValue, GM_getValues: getValues, GM_setValue: setValue, GM_setValues: setValues,
        GM_deleteValue: deleteValue, GM_deleteValues: deleteValues, GM_listValues: listValues,
        GM_addValueChangeListener: addListener, GM_removeValueChangeListener: removeListener,
        GM_openInTab: openInTab, GM_closeTab: closeTab, GM_download: download, GM_notification: notification, GM_setClipboard: setClipboard };
    for (const [name, fn] of Object.entries(bindings)) if (permitted(name) || (name === 'GM_removeValueChangeListener' && permitted('GM_addValueChangeListener'))) scope[name] = fn;
    scope.GM_addStyle = addStyle; scope.GM_addElement = addElement; scope.GM_log = GM.log;
    for (const name of ['getResourceText', 'getResourceURL', 'getTab', 'saveTab', 'getTabs', 'webRequest', 'cookie', 'registerMenuCommand', 'unregisterMenuCommand', 'xmlhttpRequest']) {
        const unsupported = () => { throw new Error('GM_' + name + ' is not supported by ShieldMonkey.'); };
        GM[name] = unsupported;
        if (name !== 'xmlhttpRequest' || granted.has('GM_xmlhttpRequest')) scope['GM_' + name] = unsupported;
    }
    Object.defineProperty(scope, 'unsafeWindow', { get: () => scope, configurable: false });
    scope.close = () => { if (permitted('GM_closeTab')) void closeTab().catch(console.error); else console.warn('Permission denied: window.close'); };
    function checkUrlChange() { if (typeof scope.onurlchange === 'function') scope.onurlchange(scope.location.href); }
    for (const name of ['pushState', 'replaceState']) { const original = history[name]; history[name] = function(...args) { const result = original.apply(history, args); checkUrlChange(); return result; }; }
    scope.addEventListener('popstate', checkUrlChange); scope.addEventListener('hashchange', checkUrlChange);
    (function() {
"__USER_SCRIPT_BODY__";
    }).call(scope);
})(window);
