import type { Script } from '../../src/shared/types';
import { beforeEach, afterEach, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import { launchExtension, getExtensionUrl } from './test-utils';

let context: BrowserContext, page: Page, extensionId: string;
const code = (body = 'console.log(1);', grant = 'none') => `// ==UserScript==\n// @name Update Review\n// @namespace review\n// @match https://example.com/*\n// @grant ${grant}\n// ==/UserScript==\n${body}`;
const dataKey = 'gmv1:' + JSON.stringify(['update-review', 'https://example.com']) + ':progress';
beforeEach(async () => {
    const launched = await launchExtension(); context = launched.browserContext; page = launched.page; extensionId = launched.extensionId;
    const saved = await page.evaluate(source => chrome.runtime.sendMessage({ type: 'SAVE_SCRIPT', approved: true, script: { id: 'update-review', name: 'Update Review', code: source, enabled: false, folderPath: 'Tools' } }), code());
    expect(saved.success).toBe(true);
    await page.evaluate(key => chrome.storage.local.set({ [key]: 7 }), dataKey);
});
afterEach(async () => { await context?.close(); });

test('file update review keeps ID, saved data and folders and cancels new grants safely', async () => {
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/scripts'));
    for (const grant of ['none', 'GM_download']) {
        await page.evaluate(source => {
            (window as unknown as { showOpenFilePicker: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker = async () => [{ getFile: async () => new File([source], 'review.user.js', { type: 'text/javascript' }) } as FileSystemFileHandle];
        }, code('console.log("updated");', grant));
        await page.getByRole('button', { name: /Import file/i }).click();
        const update = page.locator('.permission-dialog');
        await update.getByRole('heading', { name: 'Review script update' }).waitFor();
        expect(await update.locator('pre').count()).toBe(2);
        await update.getByRole('button', { name: 'Update', exact: true }).click();
        if (grant === 'GM_download') {
            await page.locator('.permission-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
        } else {
            await page.locator('.modal-content').getByRole('button', { name: 'OK', exact: true }).click();
        }
        const stored = await page.evaluate(async key => chrome.storage.local.get(['scripts', key]), dataKey);
        expect(stored.scripts).toHaveLength(1);
        expect((stored.scripts as Script[])[0]).toMatchObject({ id: 'update-review', folderPath: 'Tools', enabled: false, grantedPermissions: [] });
        expect((stored.scripts as Script[])[0].code).toBe(code('console.log("updated");'));
        expect(stored[dataKey]).toBe(7);
    }
});

test('JSON export opts into saved data and restore keeps its origin boundaries', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/settings'));
    const exportButton = page.getByRole('button', { name: 'Export Scripts', exact: true });
    const exportFile = async () => {
        const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]); const path = await download.path();
        expect(path).toBeTruthy(); return readFileSync(path!, 'utf8');
    };
    const codeOnly = JSON.parse(await exportFile());
    expect(codeOnly.gmValues).toBeUndefined();
    await page.getByRole('checkbox', { name: /Include script saved data in JSON backups/ }).check();
    const text = await exportFile(), full = JSON.parse(text);
    expect(full.formatVersion).toBe(3);
    expect(full.gmValues).toEqual([{ scriptId: 'update-review', origin: 'https://example.com', values: { progress: 7 } }]);
    expect(full.scripts[0].token).toBeUndefined(); expect(full.scripts[0].approvedScope).toBeUndefined();
    const other = 'gmv1:' + JSON.stringify(['update-review', 'https://example.org']) + ':progress';
    await page.evaluate(({ key, other }) => chrome.storage.local.set({ [key]: 99, [other]: 55 }), { key: dataKey, other });
    await page.locator('input[type=file]').setInputFiles({ name: 'saved-data.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    const preview = page.locator('.modal-content');
    await preview.getByRole('checkbox', { name: 'Restore 1 saved values (1 existing keys will be overwritten)' }).waitFor();
    await preview.locator('.btn-primary').click();
    await expect.poll(async () => (await page.evaluate(key => chrome.storage.local.get(key), dataKey))[dataKey]).toBe(7);
    const stored = await page.evaluate(async other => chrome.storage.local.get(['scripts', other]), other);
    expect(stored[other]).toBe(55); expect((stored.scripts as Script[])[0].id).toBe('update-review');
});

test('independent management tabs share the library lock and stale editor saves are rejected', async () => {
    const holder = await context.newPage();
    await holder.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/settings'));
    await holder.evaluate(() => {
        const w = window as unknown as { release: () => void; held: boolean };
        void navigator.locks.request('shieldmonkey-library-v1', async () => {
            w.held = true; await new Promise<void>(resolve => { w.release = resolve; });
        });
    });
    await expect.poll(async () => holder.evaluate(() => (window as unknown as { held: boolean }).held)).toBe(true);
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/scripts/update-review'));
    const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+End'); await editor.pressSequentially(' // my edit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(((await page.evaluate(() => chrome.storage.local.get('scripts'))).scripts as Script[])[0].code).not.toContain('my edit');
    // A newer trusted save simulates the library changing during pending work.
    await holder.evaluate(source => chrome.runtime.sendMessage({ type: 'SAVE_SCRIPT', approved: true, script: { id: 'update-review', name: 'Update Review', code: source, enabled: false } }), code('console.log("other editor");'));
    await holder.evaluate(() => (window as unknown as { release: () => void }).release());
    await page.locator('.modal-content').getByText(/changed in another editor/).waitFor();
    expect(await editor.innerText()).toContain('my edit');
    expect(((await page.evaluate(() => chrome.storage.local.get('scripts'))).scripts as Script[])[0].code).toContain('other editor');
});
