import { type BrowserContext, type Page, chromium } from 'playwright';
import { readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'node:os';
import path from 'path';
import { createHash } from 'node:crypto';

// Constants
export const EXTENSION_PATH = path.join(process.cwd(), 'dist');
export const USER_DATA_DIR = path.join(process.cwd(), 'test-user-data-dir');
export const TIMEOUT = {
    SHORT: 300,
    MEDIUM: 1000,
    LONG: 2000,
    VERY_LONG: 3000,
} as const;

// Types
export interface ExtensionContext {
    browserContext: BrowserContext;
    page: Page;
    extensionId: string;
}

export interface MockScript {
    id: string;
    name: string;
    code: string;
    enabled: boolean;
}

// Main extension launcher
export async function launchExtension(): Promise<ExtensionContext> {
    const profile = mkdtempSync(path.join(tmpdir(), 'shieldmonkey-e2e-'));
    const browserContext = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: process.env.HEADLESS !== 'false',
        ignoreDefaultArgs: ['--disable-extensions'], locale: 'en',
        args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    console.log('[launch] Chromium started');
    browserContext.on('close', () => { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Chromium can still be finishing profile writes. */ } });

    browserContext.setDefaultTimeout(30000);
    await browserContext.route(/^https:\/\/(shieldmonkey\.github\.io|example\.com)(?:\/|$)/, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>ShieldMonkey Test</title><body>Test page</body>' }));

    try {
        const page = await browserContext.newPage();

        page.on('console', msg => console.log(`[PAGE CONSOLE] ${msg.text()}`));
        page.on('pageerror', exception => console.log(`[PAGE ERROR] ${exception}`));

        // Discover the installed extension before requiring a worker. Its
        // first worker may need the user-scripts toggle enabled and a reload.
        console.log('[launch] opening extension manager');
        await page.goto('chrome://extensions/', { waitUntil: 'commit' });
        console.log('[launch] manager loaded');
        const extensionId = await page.evaluate(async expectedPath => {
            type Info = { id: string; path: string; manifestErrors: unknown[] };
            const api = (chrome as unknown as { developerPrivate: { getExtensionsInfo: (options: object, callback: (items: Info[]) => void) => void } }).developerPrivate;
            const items = await new Promise<Info[]>(resolve => api.getExtensionsInfo({ includeDisabled: true }, resolve));
            const extension = items.find(item => item.path === expectedPath);
            if (!extension || extension.manifestErrors.length) throw new Error('Extension was not loaded: ' + JSON.stringify(items.map(item => ({ id: item.id, errors: item.manifestErrors }))));
            return extension.id;
        }, EXTENSION_PATH);
        console.log('[launch] extension discovered', extensionId);
        await enableUserScriptsIfNeeded(page, extensionId);
        console.log('[launch] script permission enabled');
        await waitForServiceWorker(browserContext);
        console.log(`Extension ready: ${extensionId}`);

        await page.goto(getExtensionUrl(extensionId, '/src/options/index.html'), { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => chrome.runtime.sendMessage({ type: 'RELOAD_SCRIPTS' }));
        await waitForServiceWorker(browserContext);
        return { browserContext, page, extensionId };
    } catch (error) {
        await browserContext.close().catch(() => { }); // Ignore close errors
        throw error;
    }
}

// Helper: Wait for service worker to be available
async function waitForServiceWorker(browserContext: BrowserContext): Promise<void> {
    const maxAttempts = 60;
    const delayMs = 500;

    for (let i = 0; i < maxAttempts; i++) {
        const serviceWorkers = browserContext.serviceWorkers();
        if (serviceWorkers.length > 0) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    throw new Error('Service worker did not start within expected time');
}

// Helper: Enable User Scripts API if needed
async function enableUserScriptsIfNeeded(
    settingPage: Page,
    extensionId: string
): Promise<void> {
    await settingPage.evaluate(async id => {
        const api = (chrome as unknown as { developerPrivate: { updateExtensionConfiguration: (config: { extensionId: string; userScriptsAccess: boolean }, callback: () => void) => void; reload: (id: string, options: object, callback: () => void) => void } }).developerPrivate;
        await new Promise<void>((resolve, reject) => api.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
    }, extensionId);
    for (let attempt = 0; attempt < 100; attempt++) {
        const state = await settingPage.evaluate(id => new Promise<string>(resolve => {
            (chrome as unknown as { developerPrivate: { getExtensionsInfo: (options: object, callback: (items: { id: string; state: string; disableReasons?: { reloading?: boolean } }[]) => void) => void } }).developerPrivate.getExtensionsInfo({ includeDisabled: true }, items => {
                const item = items.find(item => item.id === id);
                resolve(item && !item.disableReasons?.reloading ? item.state : 'RELOADING');
            });
        }), extensionId);
        if (state === 'ENABLED') return;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Extension did not finish reloading.');
}

// Helper: Navigate to extension page
export function getExtensionUrl(extensionId: string, path: string): string {
    return `chrome-extension://${extensionId}${path}`;
}

// Helper: Clear all scripts
export async function clearAllScripts(page: Page): Promise<void> {
    await page.evaluate(() => chrome.storage.local.set({ scripts: [] }));
}

export function createMockFileSystemHandle(initialData?: { name: string; content: string }[]) {
    // Process scripts with permissions
    const scripts = initialData ? initialData.map((d) => {
        const grants: string[] = [];
        // Extract @grant
        const lines = d.content.split('\n');
        for (const line of lines) {
            const match = line.match(/^\s*\/\/\s*@grant\s+(\S+)/);
            if (match) {
                grants.push(match[1]);
            }
        }

        // Simple hash for ID to be unique based on name
        let hash = 0;
        for (let i = 0; i < d.name.length; i++) {
            const char = d.name.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        const safeId = 'restored-script-' + Math.abs(hash);

        return {
            id: safeId,
            name: d.name,
            code: d.content,
            enabled: true,
            grantedPermissions: grants
        };
    }) : [{
        id: 'restored-script-default',
        name: 'Restored Script',
        code: '// ==UserScript==\n// @name Restored Script\n// @match https://example.com/*\n// ==/UserScript==\n',
        enabled: true,
        grantedPermissions: []
    }];

    const mockBackupData = {
        timestamp: new Date().toISOString(),
        version: '1.0',
        scripts: scripts
    };

    const mockBackupDataJson = JSON.stringify(mockBackupData);

    return `
    (() => {
        const mockBackupData = ${mockBackupDataJson};

        const makeDirectory = (name) => {
            const files = new Map();
            const directories = new Map();
            return {
                kind: 'directory',
                name,
                files,
                getFileHandle: async (fileName, options) => {
                    if (!files.has(fileName) && !options?.create) throw new DOMException('Missing file', 'NotFoundError');
                    return {
                        kind: 'file',
                        name: fileName,
                        createWritable: async () => {
                            let content = '';
                            return {
                                write: async (value) => { content = value; },
                                close: async () => { files.set(fileName, content); }
                            };
                        },
                        getFile: async () => new Blob([files.get(fileName) || ''], { type: 'application/json' })
                    };
                },
                getDirectoryHandle: async (childName, options) => {
                    if (!directories.has(childName)) {
                        if (!options?.create) throw new DOMException('Missing directory', 'NotFoundError');
                        directories.set(childName, makeDirectory(childName));
                    }
                    return directories.get(childName);
                },
                removeEntry: async (fileName) => { files.delete(fileName); },
                queryPermission: async () => 'granted',
                requestPermission: async () => 'granted'
            };
        };
        const mockHandle = makeDirectory('mock-backup-dir');
        mockHandle.files.set('shieldmonkey_dump.json', JSON.stringify(mockBackupData));

        window.showDirectoryPicker = async () => {
            console.log('[MOCK] showDirectoryPicker called');
            return mockHandle;
        };

        window.__mockBackupDirectoryHandle = mockHandle;
    })();
    `;
}

export function createMockWorkspaceHandle(initialData?: { name: string; content: string }[]) {
    const inputs = initialData ?? [{
        name: 'Restored Script.user.js',
        content: '// ==UserScript==\n// @name Restored Script\n// @namespace mock\n// @match https://shieldmonkey.github.io/*\n// ==/UserScript==\nconsole.log(1);',
    }];
    const scripts = inputs.map((input, index) => {
        const name = input.content.match(/^\s*\/\/\s*@name\s+(.+)$/m)?.[1]?.trim() || input.name.replace(/\.user\.js$/, '');
        const namespace = input.content.match(/^\s*\/\/\s*@namespace\s+(.+)$/m)?.[1]?.trim() || '';
        return {
            id: `restored-script-${index}`, name, namespace, code: input.content,
            enabled: true, grantedPermissions: [], folderPath: '', filePath: input.name,
        };
    });
    const state = {
        format: 1, workspaceId: 'mock-workspace', folders: [],
        entries: scripts.map(script => ({
            id: script.id, path: script.filePath,
            hash: createHash('sha256').update(script.code).digest('hex'),
            identity: `${script.namespace}\u0000${script.name}`,
            metadata: Object.fromEntries(Object.entries(script).filter(([key]) => key !== 'code')),
        })),
    };
    const snapshot = { format: 1, timestamp: new Date().toISOString(), reason: 'Initial workspace', folders: [], scripts };
    const files = {
        'state.json': JSON.stringify(state),
        'scripts': Object.fromEntries(inputs.map(input => [input.name, input.content])),
        'history': { '2026-01-01T00-00-00-000Z-initial.json': JSON.stringify(snapshot) },
    };
    return `
    (() => {
        const initial = ${JSON.stringify(files)};
        function makeFile(name, content = '') {
            return {
                kind: 'file', name, content,
                getFile: async function () { return new Blob([this.content]); },
                createWritable: async function () {
                    let next = '';
                    return {
                        write: async value => { next = typeof value === 'string' ? value : String(value); },
                        close: async () => { this.content = next; },
                    };
                }
            };
        }
        function makeDirectory(name, contents = {}) {
            const entries = new Map(Object.entries(contents).map(([key, value]) =>
                [key, typeof value === 'string' ? makeFile(key, value) : makeDirectory(key, value)]));
            return {
                kind: 'directory', name,
                getFileHandle: async (key, options) => {
                    const item = entries.get(key);
                    if (item?.kind === 'file') return item;
                    if (item) throw new DOMException('Wrong kind', 'TypeMismatchError');
                    if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
                    const file = makeFile(key);
                    entries.set(key, file);
                    return file;
                },
                getDirectoryHandle: async (key, options) => {
                    const item = entries.get(key);
                    if (item?.kind === 'directory') return item;
                    if (item) throw new DOMException('Wrong kind', 'TypeMismatchError');
                    if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
                    const dir = makeDirectory(key);
                    entries.set(key, dir);
                    return dir;
                },
                removeEntry: async key => {
                    const item = entries.get(key);
                    if (!item) throw new DOMException('Missing', 'NotFoundError');
                    if (item.kind === 'directory') {
                        for await (const _child of item.entries()) throw new DOMException('Not empty', 'InvalidModificationError');
                    }
                    entries.delete(key);
                },
                entries: async function* () { yield* entries.entries(); },
                queryPermission: async () => 'granted',
                requestPermission: async () => 'granted',
            };
        }
        const root = makeDirectory('mock-backup-dir', initial);
        window.__mockBackupDirectoryHandle = root;
        window.showDirectoryPicker = async () => root;
    })();`;
}

// Helper: Inject script directly into storage and reload
export async function injectScriptToStorage(page: Page, scriptPath: string) {
    const filename = path.basename(scriptPath);
    const content = readFileSync(scriptPath, 'utf-8');

    // Generate consistent ID
    let hash = 0;
    for (let i = 0; i < filename.length; i++) {
        const char = filename.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    const safeId = 'test-script-' + Math.abs(hash);

    // Extract @grant
    const grants: string[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const match = line.match(/^\s*\/\/\s*@grant\s+(\S+)/);
        if (match) {
            grants.push(match[1]);
        }
    }

    const scriptObj = {
        id: safeId,
        name: filename,
        code: content,
        enabled: true,
        grantedPermissions: grants
    };

    // Inject via background page or any extension page
    if (!page.url().startsWith('chrome-extension://')) {
        throw new Error('injectScriptToStorage requires the page to be on a chrome-extension:// URL');
    }

    const response = await page.evaluate(script => chrome.runtime.sendMessage({ type: 'SAVE_SCRIPT', script, approved: true }), scriptObj);
    if (!response?.success) throw new Error(response?.error || 'Fixture save failed.');
}

// Helper: Install script via mock backup restore
export async function installScriptFromPath(page: Page, extensionId: string, scriptPath: string) {
    const filename = path.basename(scriptPath);
    const content = readFileSync(scriptPath, 'utf-8');

    // 1. Setup mock handle with the script content
    await page.addInitScript(createMockWorkspaceHandle([{ name: filename, content }]));

    // 2. Navigate to settings to trigger restore
    const settingsUrl = `chrome-extension://${extensionId}/src/options/index.html#/settings`;
    if (page.url() === settingsUrl) {
        await page.reload();
    } else {
        await page.goto(settingsUrl);
    }

    // Wait for page to fully initialize, especially important in CI environments
    await page.waitForTimeout(TIMEOUT.MEDIUM);

    // 3. Trigger restore
    const frame = page;
    const selectBtn = frame.getByRole('button', { name: /Select$/i });
    await selectBtn.waitFor({ state: 'visible' });
    await selectBtn.click();

    const restoreBtn = frame.getByRole('button', { name: /Restore from backup folder/i });
    await restoreBtn.waitFor({ state: 'visible' });
    await restoreBtn.click();

    // 4. Confirm modal
    const modal = frame.locator('.modal-content');
    await modal.waitFor({ state: 'visible' });
    // Note: Modal might be in a Portal? If so, where is it rendered?
    // In React App, usually at document.body or a specific root.
    // If it is in the iframe, frame locator works.
    const confirmBtn = modal.getByRole('button', { name: /OK/i });
    await confirmBtn.click();

    // 5. Wait for success modal
    const successModal = frame.locator('.modal-content').filter({ hasText: /Restore Complete|Restore Successful/i }); // Matches translation keys roughly
    // Or better, just wait for any modal that says "Complete" or "Success"
    // The previous modal was "Confirm Restore", now we expect "Restore Complete"

    // We already clicked OK on confirm. Use a slightly more robust wait.
    // Wait for the restore process to finish (loading false)
    // But easier to wait for the success message in the UI if possible.

    // Settings.tsx: showModal('success', t('restoreCompleteTitle'), ...)
    // we need to find the success modal.

    // Let's assume the "Confirm" modal disappears and a new "Success" modal appears.
    // Or the same modal updates.

    await successModal.waitFor({ state: 'visible', timeout: 5000 });
    await successModal.getByRole('button', { name: /OK/i }).click();

    // 6. Verification: Check if script is in list
    // navigate to scripts page? No, let's just wait a bit.
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/scripts'));
    await page.getByRole('switch').first().click();
    await page.locator('.permission-dialog').getByRole('button', { name: 'Allow', exact: true }).click();
    await page.waitForTimeout(500);
}
