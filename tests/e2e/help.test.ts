import { test, expect } from 'vitest';
import { launchExtension, getExtensionUrl, TIMEOUT } from './test-utils';
import type { BrowserContext, Page } from 'playwright';

let browserContext: BrowserContext;
let page: Page;
let extensionId: string;

test.beforeEach(async () => {
    const context = await launchExtension();
    browserContext = context.browserContext;
    page = context.page;
    extensionId = context.extensionId;
});

test.afterEach(async () => {
    await browserContext?.close();
});

test('Help page - Links open in new tab via app OPEN_URL', async () => {
    // Navigate to the Help page
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/help'));

    // Wait for the iframe to load
    const frame = page;

    // Wait for the Github repo link to be visible inside the iframe
    // The Help page has an anchor targeting the repo link
    const repoLink = frame.getByRole('link', { name: /Github/i });
    await repoLink.waitFor({ state: 'visible', timeout: TIMEOUT.LONG });

    // Click the link, which should trigger app.call('OPEN_URL') instead of default link behavior
    // and open a new tab
    const [newPage] = await Promise.all([
        browserContext.waitForEvent('page'),
        repoLink.click()
    ]);

    // Check if the new page URL matches the github repo URL
    await newPage.waitForLoadState();
    const url = newPage.url();
    expect(url).toContain('github.com/shieldmonkey/shieldmonkey');

    await newPage.close();
});

test('page messages cannot invoke the removed UI bridge', async () => {
    await page.goto(getExtensionUrl(extensionId, '/src/options/index.html#/help'));
    expect(page.mainFrame().childFrames()).toHaveLength(0);
    const before = browserContext.pages().length;
    await page.evaluate(() => window.postMessage({ id: 'test-evil-url', type: 'OPEN_URL', payload: 'https://evil.com/' }, '*'));
    await page.waitForTimeout(500);
    expect(browserContext.pages()).toHaveLength(before);
});
