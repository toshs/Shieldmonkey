import { expect, test } from 'vitest';
import type { BrowserContext } from 'playwright';
import { launchExtension, getExtensionUrl } from './test-utils';

let browserContext: BrowserContext;
test.afterEach(async () => { await browserContext?.close(); });

test('notification URL and callback payloads cannot bypass the source origin, scope, or GM grants', async () => {
    const context = await launchExtension(); browserContext = context.browserContext;
    const { page, extensionId } = context;
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html'));
    const code = `// ==UserScript==
// @name Notification Boundary
// @match https://example.com/allowed/*
// @grant GM_notification
// ==/UserScript==
(async () => {
    const outcomes = [];
    for (const url of ['https://other.example/', 'https://example.com:444/allowed/', '/outside', 'javascript:alert(1)', 'chrome://settings/']) {
        try { await GM.notification({ text: 'boundary check', url, onclick: () => {} }); outcomes.push('unexpected'); }
        catch (error) { outcomes.push(error.message); }
    }
    try { await GM.openInTab('https://other.example/'); outcomes.push('unexpected'); }
    catch (error) { outcomes.push(error.message); }
    document.documentElement.dataset.notificationBoundary = JSON.stringify(outcomes);
})();`;
    const saved = await page.evaluate(async code => chrome.runtime.sendMessage({
        type: 'SAVE_SCRIPT', approved: true, script: { id: 'notification-boundary', name: 'Notification Boundary', code, enabled: true }
    }), code);
    expect(saved.success).toBe(true);
    await page.goto('https://example.com/allowed/source');
    await page.waitForFunction(() => !!document.documentElement.dataset.notificationBoundary);
    const outcomes = await page.evaluate(() => JSON.parse(document.documentElement.dataset.notificationBoundary!) as string[]);
    expect(outcomes).toHaveLength(6);
    expect(outcomes.slice(0, 2).every(error => error.includes('source origin'))).toBe(true);
    expect(outcomes[2]).toContain('approved script scope');
    expect(outcomes.slice(3, 5).every(error => error.includes('source origin'))).toBe(true);
    expect(outcomes[5]).toContain('Permission denied: GM_openInTab');
    expect(await browserContext.serviceWorkers()[0].evaluate(() => chrome.notifications.getAll())).toEqual({});
    expect(browserContext.pages().some(page => page.url().startsWith('https://other.example/'))).toBe(false);
});
