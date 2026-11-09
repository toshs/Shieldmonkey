import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
import { firefox as playwrightFirefox } from 'playwright';
const require = createRequire(import.meta.url);
const {Builder, By} = require(process.env.SELENIUM_PACKAGE);
const {Options, ServiceBuilder} = require(path.join(process.env.SELENIUM_PACKAGE, 'firefox.js'));
const profile = await mkdtemp(path.join(tmpdir(), 'shieldmonkey-firefox-'));
const addonId = 'shieldmonkey@toshs.dev';
const server = createServer((_request, response) => {response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Firefox smoke</title><body>Test</body>');});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const site = 'http://127.0.0.1:' + server.address().port + '/';
let driver;
try {
    const options = new Options().setBinary(playwrightFirefox.executablePath()).setProfile(profile)
        .addArguments('-headless');
    // System access is used only to set up the requested optional permission
    // inside this new disposable profile. Existing profiles are never used.
    driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
        .setFirefoxService(new ServiceBuilder(process.env.GECKODRIVER_PATH).addArguments('--allow-system-access')).build();
    await driver.manage().setTimeouts({pageLoad:20000,script:15000,implicit:0});
    assert.equal(await driver.installAddon(path.resolve('dist-firefox'),true),addonId);
    await driver.setContext('chrome');
    const optionsUrl = await driver.executeScript(async id => {
        const {ExtensionPermissions} = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
        const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        await ExtensionPermissions.add(id,{permissions:['userScripts'],origins:['<all_urls>']},WebExtensionPolicy.getByID(id).extension);
        return (await AddonManager.getAddonByID(id)).optionsURL;
    },addonId);
    await driver.setContext('content');
    await driver.get(optionsUrl + '#/options/scripts');
    assert.equal(await driver.executeScript(() => chrome.permissions.contains({permissions:['userScripts']})),true);
    await driver.wait(async()=> (await driver.findElements(By.css('.scripts-page'))).length > 0,15000);
    assert.equal((await driver.findElements(By.css('iframe'))).length,0);
    const code = `// ==UserScript==\n// @name Firefox Smoke\n// @match http://127.0.0.1/*\n// @grant GM_getValue\n// @grant GM_setValue\n// ==/UserScript==\n(async()=>{const value=GM_getValue('counter',0);document.documentElement.dataset.sm050=String(value);await GM_setValue('counter',value+1);document.documentElement.dataset.sm050Saved='yes';})();`;
    const response = await driver.executeScript(script=>chrome.runtime.sendMessage({type:'SAVE_SCRIPT',approved:true,script}),{id:'firefox-smoke',name:'Firefox Smoke',code,enabled:true});
    assert.equal(response.success,true,response.error);
    const worlds = await driver.executeScript(()=>chrome.userScripts.getWorldConfigurations());
    assert.ok(worlds.some(world=>world.worldId?.startsWith('sm-') && world.messaging));
    assert.ok(!worlds.some(world=>!world.worldId && world.messaging));
    await driver.get(site);
    await driver.wait(()=>driver.executeScript(()=>document.documentElement.dataset.sm050Saved==='yes'),15000);
    assert.equal(await driver.executeScript(()=>document.documentElement.dataset.sm050),'0');
    await driver.navigate().refresh();
    await driver.wait(()=>driver.executeScript(()=>document.documentElement.dataset.sm050Saved==='yes'),15000);
    assert.equal(await driver.executeScript(()=>document.documentElement.dataset.sm050),'1');
    assert.deepEqual(await driver.executeScript(()=>({gm:typeof window.GM,cache:Object.keys(localStorage).filter(key=>key.startsWith('sm_cache_'))})),{gm:'undefined',cache:[]});
    await driver.get(optionsUrl);
    assert.equal(await driver.executeScript(async url=>{try{await fetch(url);return false;}catch{return true;}},site),true);
    console.log('FIREFOX_SMOKE_PASS ' + (await driver.getCapabilities()).get('browserVersion'));
} finally {
    await driver?.quit(); await new Promise(resolve=>server.close(resolve)); await rm(profile,{recursive:true,force:true});
}
