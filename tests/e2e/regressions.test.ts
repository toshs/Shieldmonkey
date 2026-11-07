import { test, expect } from 'vitest';
import { launchExtension, getExtensionUrl } from './test-utils';
import type { BrowserContext, Page } from 'playwright';

let browserContext: BrowserContext;
let page: Page;
let extensionId: string;

const scriptCode = (name: string, match = 'https://example.com/*') =>
    `// ==UserScript==\n// @name ${name}\n// @match ${match}\n// ==/UserScript==\nconsole.log('${name}');`;

test.beforeEach(async () => {
    const context = await launchExtension();
    browserContext = context.browserContext;
    page = context.page;
    extensionId = context.extensionId;
});

test.afterEach(async () => {
    await browserContext.close();
});

test('invalid registration does not overwrite a saved script or enable a broken script', async () => {
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html'));
    const good = scriptCode('Working');
    const saved = await page.evaluate(async code => chrome.runtime.sendMessage({
        type: 'SAVE_SCRIPT', script: { id: 'working', name: 'Working', code, enabled: true }
    }) as Promise<{ success: boolean }>, good);
    expect(saved.success).toBe(true);

    const bad = scriptCode('Broken', 'invalid-pattern');
    const rejected = await page.evaluate(async code => chrome.runtime.sendMessage({
        type: 'SAVE_SCRIPT', script: { id: 'working', name: 'Broken', code, enabled: true }
    }) as Promise<{ success: boolean; error?: string }>, bad);
    expect(rejected.success).toBe(false);
    expect(rejected.error).toBeTruthy();

    const worker = browserContext.serviceWorkers()[0];
    const state = await worker.evaluate(async () => ({
        scripts: (await chrome.storage.local.get('scripts')).scripts as { id: string; code: string; enabled: boolean }[],
        registered: await chrome.userScripts.getScripts({ ids: ['working'] })
    }));
    expect(state.scripts.find(s => s.id === 'working')?.code).toBe(good);
    expect(state.registered).toHaveLength(1);

    await worker.evaluate(async ({ good, bad }) => chrome.storage.local.set({
        scripts: [
            { id: 'working', name: 'Working', code: good, enabled: true },
            { id: 'broken-disabled', name: 'Broken', code: bad, enabled: false }
        ]
    }), { good, bad });
    const toggled = await page.evaluate(async () => chrome.runtime.sendMessage({
        type: 'TOGGLE_SCRIPT', scriptId: 'broken-disabled', enabled: true
    }) as Promise<{ success: boolean }>);
    expect(toggled.success).toBe(false);
    const afterToggle = await worker.evaluate(async () => (await chrome.storage.local.get('scripts')).scripts as { id: string; enabled: boolean }[]);
    expect(afterToggle.find(s => s.id === 'broken-disabled')?.enabled).toBe(false);
});

test('editor switches scripts and asks before discarding unsaved changes from hash navigation', async () => {
    const worker = browserContext.serviceWorkers()[0];
    await worker.evaluate(async scripts => chrome.storage.local.set({ scripts }), [
        { id: 'editor-a', name: 'Editor A', code: scriptCode('Editor A'), enabled: true },
        { id: 'editor-b', name: 'Editor B', code: scriptCode('Editor B'), enabled: true }
    ]);
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/scripts/editor-a'));
    const frame = page.frameLocator('iframe');
    await expect.poll(async () => frame.locator('.script-name-input').innerText()).toBe('Editor A');
    await page.evaluate(() => { window.location.hash = '#/options/scripts/editor-b'; });
    await expect.poll(async () => frame.locator('.script-name-input').innerText()).toBe('Editor B');
    expect(await frame.locator('.cm-content').innerText()).toContain('Editor B');

    const editor = frame.locator('.cm-content');
    await editor.click();
    await editor.type(' // unsaved');
    await page.evaluate(() => { window.location.hash = '#/options/scripts/editor-a'; });
    const modal = frame.locator('.modal-content');
    await modal.waitFor({ state: 'visible' });
    await expect.poll(async () => page.url()).toContain('#/options/scripts/editor-b');
    await modal.locator('.modal-close').click();
    expect(await editor.innerText()).toContain('unsaved');

    await page.evaluate(() => { window.location.hash = '#/options/scripts/editor-a'; });
    await modal.waitFor({ state: 'visible' });
    await modal.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => frame.locator('.script-name-input').innerText()).toBe('Editor A');
    expect(await frame.locator('.cm-content').innerText()).toContain('Editor A');
});

test('new script uses the popup URL and mobile editor has no bottom navigation gap', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const match = encodeURIComponent('https://example.com:8443/some/page?q=1');
    await page.goto(getExtensionUrl(extensionId, `/src/options/index.html?match=${match}#/options/new`));
    const frame = page.frameLocator('iframe');
    const code = await frame.locator('.cm-content').innerText();
    expect(code).toContain('@match       https://example.com/*');
    const padding = await frame.locator('.script-editor-page > .main-content').evaluate(element => getComputedStyle(element).paddingBottom);
    expect(padding).toBe('0px');
});

test('filtering clears a hidden bulk selection', async () => {
    const worker = browserContext.serviceWorkers()[0];
    await worker.evaluate(async scripts => chrome.storage.local.set({ scripts }), [
        { id: 'alpha', name: 'Alpha', code: scriptCode('Alpha'), enabled: true },
        { id: 'beta', name: 'Beta', code: scriptCode('Beta'), enabled: true }
    ]);
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/options/scripts'));
    const frame = page.frameLocator('iframe');
    await frame.getByRole('row').filter({ hasText: 'Alpha' }).locator('input[type="checkbox"]').first().check();
    await frame.locator('.bulk-actions').waitFor({ state: 'visible' });
    await frame.getByRole('searchbox').fill('Beta');
    await expect.poll(async () => frame.locator('.bulk-actions').count()).toBe(0);
    expect(await frame.getByRole('row').filter({ hasText: 'Beta' }).count()).toBe(1);
});
