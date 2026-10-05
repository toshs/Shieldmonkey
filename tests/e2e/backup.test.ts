import { test, expect } from 'vitest';
import { launchExtension, getExtensionUrl, TIMEOUT } from './test-utils';
import type { BrowserContext } from 'playwright';

let browserContext: BrowserContext;
let extensionId: string;

test.beforeEach(async () => {
    const context = await launchExtension();
    browserContext = context.browserContext;
    extensionId = context.extensionId;
});

test.afterEach(async () => {
    await browserContext.close();
});

import { createMockFileSystemHandle } from './test-utils';

test('Backup and Restore Logic', async () => {
    const newPage = await browserContext.newPage();
    await newPage.addInitScript(createMockFileSystemHandle());
    await newPage.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));

    // Wait for page to fully initialize, especially on first run
    await newPage.waitForTimeout(TIMEOUT.MEDIUM);

    const frame = newPage.frameLocator('iframe');

    const selectBtn = frame.getByRole('button', { name: /Select$/i });
    await selectBtn.waitFor({ state: 'visible' });
    await selectBtn.click();

    await expect.poll(async () => frame.getByText('mock-backup-dir').isVisible(), { timeout: 10000 }).toBe(true);

    const restoreBtn = frame.getByRole('button', { name: /^Restore$/i });
    await restoreBtn.click();

    const modal = frame.locator('.modal-content');
    await modal.waitFor({ state: 'visible' });
    await expect.poll(async () => modal.getByText(/Add:\s*1/i).isVisible()).toBe(true);

    const confirmBtn = modal.getByRole('button', { name: /^Restore$/i });
    await confirmBtn.click();
    await expect.poll(async () => modal.getByText(/Successfully restored 1 scripts/i).isVisible()).toBe(true);
    await modal.getByRole('button', { name: /OK/i }).click();

    const backupBtn = frame.getByRole('button', { name: /Backup Now/i });
    await backupBtn.click();
    await expect.poll(async () => frame.getByText(/Saved 1 scripts/).isVisible()).toBe(true);

    await newPage.goto(getExtensionUrl(extensionId, '/src/options/index.html#/scripts'));

    // Scripts list is also in iframe
    const scriptsFrame = newPage.frameLocator('iframe');
    await expect.poll(async () => scriptsFrame.getByRole('table').getByText('Restored Script').isVisible()).toBe(true);
});

test('desktop shows folder backup controls without a picker mock', async () => {
    const page = await browserContext.newPage();
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: /^Select$/i }).waitFor({ state: 'visible' });
});

test('desktop auto backup runs in the background and reports a missing folder', async () => {
    const worker = browserContext.serviceWorkers()[0];
    await worker.evaluate(async () => {
        await chrome.storage.local.set({
            scripts: [{ id: 'auto-one', name: 'Auto', code: '// auto', enabled: true }],
            autoBackup: true
        });
    });
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('lastBackupError')).lastBackupError))
        .toContain('No backup folder selected');
});

test('desktop auto backup writes a selected directory after the page closes', async () => {
    const page = await browserContext.newPage();
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('auto-backup-test', { create: true });
        const request = indexedDB.open('shieldmonkey-db', 1);
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('settings')) request.result.createObjectStore('settings'); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction('settings', 'readwrite');
            transaction.objectStore('settings').put(folder, 'backup-directory-handle');
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    });
    await page.close();

    const worker = browserContext.serviceWorkers()[0];
    await worker.evaluate(async () => {
        await chrome.storage.local.set({
            scripts: [{ id: 'background-one', name: 'Background', code: '// background', enabled: true }],
            autoBackup: true
        });
    });
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get(['lastBackupTime', 'lastBackupError'])).lastBackupTime))
        .toBeTypeOf('string');
    const inspect = await browserContext.newPage();
    await inspect.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));
    const text = await inspect.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('auto-backup-test');
        const file = await folder.getFileHandle('shieldmonkey_dump.json');
        return (await file.getFile()).text();
    });
    expect(JSON.parse(text).scripts[0].id).toBe('background-one');

    await inspect.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('auto-backup-test');
        const dump = JSON.parse(await (await (await folder.getFileHandle('shieldmonkey_dump.json')).getFile()).text());
        const scriptsFolder = await folder.getDirectoryHandle('scripts');
        const scriptFile = await scriptsFolder.getFileHandle(dump.files['background-one'].name);
        const writable = await scriptFile.createWritable();
        await writable.write('// edited in folder');
        await writable.close();
        await chrome.storage.local.set({ scripts: [{ id: 'background-one', name: 'Background', code: '// edited locally', enabled: true }] });
    });
    await expect.poll(async () => inspect.evaluate(async () => (await chrome.storage.local.get('lastBackupError')).lastBackupError))
        .toContain('changed outside ShieldMonkey');

    const frame = inspect.frameLocator('iframe');
    await frame.getByRole('button', { name: /^Restore$/i }).click();
    const modal = frame.locator('.modal-content');
    await expect.poll(async () => modal.getByText(/Files edited in the folder:\s*1/i).isVisible()).toBe(true);
    await modal.getByRole('button', { name: /^Restore$/i }).click();
    await expect.poll(async () => modal.getByText(/Successfully restored 1 scripts/i).isVisible()).toBe(true);
    const synced = await inspect.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('auto-backup-test');
        const dump = await (await (await folder.getFileHandle('shieldmonkey_dump.json')).getFile()).text();
        const data = await chrome.storage.local.get(['scripts', 'lastBackupError']);
        return { dump: JSON.parse(dump), scripts: data.scripts as { code: string }[], error: data.lastBackupError };
    });
    expect(synced.scripts[0].code).toBe('// edited in folder');
    expect(synced.dump.scripts[0].code).toBe('// edited in folder');
    expect(synced.error).toBeNull();
});

test('mobile auto backup downloads JSON from the background worker', async () => {
    const worker = browserContext.serviceWorkers()[0];
    await worker.evaluate(async () => {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Linux; Android 15)' });
        await chrome.storage.local.set({
            scripts: [{ id: 'mobile-one', name: 'Mobile', code: '// mobile', enabled: true }],
            autoBackup: true
        });
    });
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get(['lastBackupTime', 'lastBackupError'])).lastBackupTime))
        .toBeTypeOf('string');
    const downloads = await worker.evaluate(async () => chrome.downloads.search({}));
    expect(downloads.some(item => item.state === 'complete' && decodeURIComponent(item.url).includes('mobile-one'))).toBe(true);
    const sender = await browserContext.newPage();
    await sender.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));
    const response = await sender.evaluate(async () => chrome.runtime.sendMessage({
        type: 'SAVE_SCRIPT',
        script: {
            id: 'mobile-one', name: 'Mobile',
            code: '// ==UserScript==\n// @name Mobile\n// @match https://example.com/*\n// ==/UserScript==\n',
            enabled: true
        }
    }) as Promise<{ success: boolean }>);
    expect(response.success).toBe(true);
    await expect.poll(async () => worker.evaluate(async () => (await chrome.downloads.search({})).length)).toBe(downloads.length + 1);
});

test('mobile JSON restore previews and imports a backup', async () => {
    const page = await browserContext.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Linux; Android 15)' });
    });
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));
    const frame = page.frameLocator('iframe');
    const input = frame.locator('input[type="file"]');
    const backup = { scripts: [{
        id: 'mobile-restored',
        name: 'Mobile Restored',
        code: '// ==UserScript==\n// @name Mobile Restored\n// @match https://example.com/*\n// ==/UserScript==\n',
        enabled: true
    }] };
    await input.setInputFiles({ name: 'mobile-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    const modal = frame.locator('.modal-content');
    await expect.poll(async () => modal.getByText(/Add:\s*1/i).isVisible()).toBe(true);
    await modal.getByLabel(/Replace:/i).check();
    await modal.getByRole('button', { name: /^Restore$/i }).click();
    await expect.poll(async () => modal.getByText(/Successfully restored 1 scripts/i).isVisible()).toBe(true);
    const stored = await page.evaluate(async () => (await chrome.storage.local.get('scripts')).scripts as { id: string; name: string; token: string }[]);
    expect(stored).toMatchObject([{ id: 'mobile-restored', name: 'Mobile Restored' }]);
    expect(stored[0].token).toMatch(/^[0-9a-f-]{36}$/);
});
