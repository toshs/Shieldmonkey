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
    await browserContext?.close();
});

import { createMockWorkspaceHandle } from './test-utils';

test('Backup and Restore Logic', async () => {
    const newPage = await browserContext.newPage();
    await newPage.addInitScript(createMockWorkspaceHandle());
    await newPage.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));

    // Wait for page to fully initialize, especially on first run
    await newPage.waitForTimeout(TIMEOUT.MEDIUM);

    const frame = newPage;

    const selectBtn = frame.getByRole('button', { name: /Select$/i });
    await selectBtn.waitFor({ state: 'visible' });
    await selectBtn.click();

    await expect.poll(async () => frame.getByText('mock-backup-dir').isVisible(), { timeout: 10000 }).toBe(true);

    const restoreBtn = frame.getByRole('button', { name: /Restore from backup folder/i });
    await restoreBtn.click();

    const modal = frame.locator('.modal-content');
    await modal.waitFor({ state: 'visible' });

    const confirmBtn = modal.getByRole('button', { name: /OK/i });
    await confirmBtn.click();
    await expect.poll(async () => modal.getByText(/Successfully restored 1 scripts/i).isVisible()).toBe(true);
    await modal.getByRole('button', { name: /OK/i }).click();

    const backupBtn = frame.getByRole('button', { name: /Backup Now/i });
    await backupBtn.click();
    await expect.poll(async () => frame.getByText(/Saved 1 scripts/).isVisible()).toBe(true);

    await newPage.goto(getExtensionUrl(extensionId, '/src/options/index.html#/scripts'));

    // Scripts list is also in iframe
    const scriptsFrame = newPage;
    await expect.poll(async () => scriptsFrame.getByText('Restored Script').first().isVisible()).toBe(true);
    await expect.poll(async () => scriptsFrame.getByRole('button', { name: /History|履歴/ }).isVisible()).toBe(true);
});

test('Folder move, external edit, and individual history restore', async () => {
    const page = await browserContext.newPage();
    await page.addInitScript(createMockWorkspaceHandle());
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/settings'));
    const frame = page;
    await frame.getByRole('button', { name: /Select$/i }).click();
    await frame.getByRole('button', { name: /Restore from backup folder/i }).click();
    await frame.locator('.modal-content').getByRole('button', { name: /OK/i }).click();
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/scripts'));
    const scripts = page;
    await expect.poll(async () => scripts.getByText('Restored Script').first().isVisible()).toBe(true);

    await scripts.getByRole('button', { name: /Create folder|フォルダーを作成/ }).click();
    await scripts.getByRole('textbox', { name: /Folder name|フォルダー名/ }).fill('Tools');
    await scripts.locator('.scripts-folder-tools').getByRole('button', { name: /Create folder|フォルダーを作成/ }).click();
    await scripts.locator('.scripts-folder-open').filter({ hasText: 'Tools' }).click();
    await expect.poll(async () => scripts.locator('.scripts-breadcrumbs [aria-current="page"]').innerText()).toBe('Tools');
    await scripts.locator('.scripts-parent-row').click();
    await scripts.getByRole('row').filter({ hasText: 'Restored Script' }).getByRole('button', { name: /Move|移動/ }).click();
    await scripts.locator('.scripts-move-list').getByRole('button', { name: /Tools/ }).click();
    await scripts.getByRole('button', { name: /Move here|ここへ移動/ }).click();
    await expect.poll(async () => page.evaluate(async () => {
        const root = (window as unknown as { __mockBackupDirectoryHandle: FileSystemDirectoryHandle }).__mockBackupDirectoryHandle;
        const directory = await (await root.getDirectoryHandle('scripts')).getDirectoryHandle('Tools');
        try { return !!await directory.getFileHandle('Restored Script.user.js'); }
        catch { return false; }
    })).toBe(true);

    await page.evaluate(async () => {
        const root = (window as unknown as { __mockBackupDirectoryHandle: FileSystemDirectoryHandle }).__mockBackupDirectoryHandle;
        const file = await (await (await root.getDirectoryHandle('scripts')).getDirectoryHandle('Tools')).getFileHandle('Restored Script.user.js');
        const writable = await file.createWritable();
        await writable.write('// ==UserScript==\n// @name Restored Script\n// @namespace mock\n// @match https://shieldmonkey.github.io/*\n// ==/UserScript==\nconsole.log(2);');
        await writable.close();
    });
    await scripts.getByRole('button', { name: /Reload files|ファイルを再読込/ }).click();
    await expect.poll(async () => page.evaluate(async () => {
        const data = await chrome.storage.local.get('scripts');
        return (data.scripts as { code: string }[])[0]?.code.includes('console.log(2)');
    })).toBe(true);

    await scripts.getByRole('button', { name: /History|履歴/ }).click();
    const history = page;
    await history.getByRole('region', { name: /History list|履歴一覧/ }).locator('button').last().click();
    await history.getByRole('region', { name: /History contents|履歴の内容/ }).locator('details summary').first().click();
    await history.getByRole('button', { name: /Restore this script|このスクリプトを復元/ }).click();
    await history.locator('.modal-content').getByRole('button', { name: /OK/i }).click();
    await expect.poll(async () => page.evaluate(async () => {
        const data = await chrome.storage.local.get('scripts');
        return (data.scripts as { code: string }[])[0]?.code.includes('console.log(1)');
    })).toBe(true);
});


test('Remembered workspace restores persistent access and reconnects temporary access without another picker', async () => {
    for (const persistent of [true, false]) {
        const page = await browserContext.newPage();
        await page.addInitScript(createMockWorkspaceHandle() + `
            (() => {
                const root = window.__mockBackupDirectoryHandle;
                let permission = 'prompt';
                window.__workspaceRequests = 0;
                window.__workspacePickers = 0;
                root.queryPermission = async () => permission;
                root.requestPermission = async () => {
                    window.__workspaceRequests++;
                    if (!${persistent} && !navigator.userActivation.isActive) throw new DOMException('Click required', 'SecurityError');
                    permission = 'granted';
                    return permission;
                };
                window.showDirectoryPicker = async () => { window.__workspacePickers++; throw Error('Must reuse the saved folder'); };
            })();
        `);
        await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/settings'));
        await page.getByText('mock-backup-dir', { exact: true }).waitFor();
        if (!persistent) await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
        await expect.poll(async () => page.getByRole('button', { name: 'Reconnect', exact: true }).count()).toBe(0);
        const state = await page.evaluate(() => {
            const w = window as unknown as { __workspaceRequests: number; __workspacePickers: number };
            return { requests: w.__workspaceRequests, pickers: w.__workspacePickers };
        });
        expect(state.requests).toBe(persistent ? 1 : 2);
        expect(state.pickers).toBe(0);
        // Access to a different workspace still requires Restore; reconnect must not overwrite it.
        expect(await page.getByRole('button', { name: /Restore from backup folder/i }).isEnabled()).toBe(true);
        expect(await page.getByText(/Restore this workspace from Settings before editing it/).count()).toBe(0);
        await page.close();
    }
});
