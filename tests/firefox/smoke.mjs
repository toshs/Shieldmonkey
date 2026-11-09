import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { firefox } from 'playwright';
const { connectWithMaxRetries } = await import(pathToFileURL(process.env.WEB_EXT_REMOTE_MODULE).href);
const profile = await mkdtemp(path.join(tmpdir(), 'shieldmonkey-firefox-'));
const addonId = 'shieldmonkey@toshs.dev';
const uuid = randomUUID();
// Firefox imports this documented legacy permission store on first startup.
// It grants only the permissions requested by the test add-on, in this new,
// disposable profile. No existing browser profile is read or modified.
await writeFile(path.join(profile, 'extension-preferences.json'), JSON.stringify({[addonId]:{permissions:['userScripts'],origins:['<all_urls>']}}));
const context = await firefox.launchPersistentContext(profile, { headless: true, timeout: 30000,
    args: ['-start-debugger-server', '9225'], firefoxUserPrefs: {
        'extensions.webextensions.uuids': JSON.stringify({[addonId]:uuid}),
        'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false,
        'devtools.chrome.enabled': true, 'extensions.htmlaboutaddons.recommendations.enabled': false, 'extensions.webextensions.userScripts.enabled': true,
    } });
let remote;
try {
    remote = await connectWithMaxRetries({ port: 9225 });
    await remote.installTemporaryAddon(path.resolve('dist-firefox'), false);
    const page = context.pages()[0];
    await page.goto('moz-extension://' + uuid + '/src/options/index.html#/options/scripts');
    assert.equal(await page.evaluate(() => chrome.permissions.contains({permissions:['userScripts']})), true, 'The disposable test profile must grant userScripts.');
    await page.locator('.scripts-page').waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    const code = `// ==UserScript==\n// @name Firefox Smoke\n// @match https://example.com/*\n// @grant GM_getValue\n// @grant GM_setValue\n// ==/UserScript==\n(async()=>{const value=GM_getValue('counter',0);document.documentElement.dataset.sm050=String(value);await GM_setValue('counter',value+1);document.documentElement.dataset.sm050Saved='yes';})();`;
    const response = await page.evaluate(script => chrome.runtime.sendMessage({type:'SAVE_SCRIPT', approved:true, script}), {id:'firefox-smoke',name:'Firefox Smoke',code,enabled:true});
    assert.equal(response.success, true, response.error);
    const configurations = await page.evaluate(() => chrome.userScripts.getWorldConfigurations());
    assert.ok(configurations.some(world => world.worldId?.startsWith('sm-') && world.messaging));
    assert.ok(!configurations.some(world => !world.worldId && world.messaging));
    await context.route('https://example.com/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>Firefox smoke</title><body>Test</body>'}));
    const testPage = await context.newPage();
    await testPage.goto('https://example.com/');
    await testPage.waitForFunction(() => document.documentElement.dataset.sm050Saved === 'yes');
    assert.equal(await testPage.evaluate(() => document.documentElement.dataset.sm050), '0');
    await testPage.reload();
    await testPage.waitForFunction(() => document.documentElement.dataset.sm050Saved === 'yes');
    assert.equal(await testPage.evaluate(() => document.documentElement.dataset.sm050), '1');
    assert.deepEqual(await testPage.evaluate(() => ({gm:typeof window.GM,cache:Object.keys(localStorage).filter(key=>key.startsWith('sm_cache_'))})),{gm:'undefined',cache:[]});
    const csp = await page.evaluate(async () => {try {await fetch('https://example.com/');return false;}catch{return true;}});
    assert.equal(csp, true);
    console.log('FIREFOX_SMOKE_PASS ' + context.browser().version());
} finally {
    remote?.disconnect(); await context.close(); await rm(profile, {recursive:true,force:true});
}
