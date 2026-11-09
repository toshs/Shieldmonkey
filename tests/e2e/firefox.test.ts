import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
// Firefox on macOS needs an unlocked WindowServer. CI runs this smoke test
// on Linux in a disposable profile, using an official Playwright browser.
test.skipIf(process.platform !== 'linux' || !process.env.CI)('Firefox loads 0.5 and preserves private GM values across reload', async () => {
    const require = createRequire(import.meta.url);
    const tools = mkdtempSync(path.join(tmpdir(), 'shieldmonkey-firefox-tools-'));
    try {
        execFileSync(process.execPath, [path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', '--with-deps', 'firefox'], {stdio:'inherit',timeout:240000});
        execFileSync('npm', ['install','--prefix',tools,'--ignore-scripts','--no-audit','--no-fund','selenium-webdriver@4.38.0'], {stdio:'inherit',timeout:120000});
        const archive = Buffer.from(await (await fetch('https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux64.tar.gz',{signal:AbortSignal.timeout(60000)})).arrayBuffer());
        expect(createHash('sha256').update(archive).digest('hex')).toBe('e815130ea95983e162ae91843b48d3a3ce991735635fce83a647afde21e09f7e');
        const tarball = path.join(tools,'geckodriver.tar.gz');
        writeFileSync(tarball,archive);
        execFileSync('tar',['-xzf',tarball,'-C',tools],{timeout:30000});
        execFileSync(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),'build','--configLoader','runner'], {env:{...process.env,TARGET_BROWSER:'firefox'},stdio:'inherit',timeout:120000});
        const output = execFileSync(process.execPath, ['tests/firefox/smoke.mjs'], {encoding:'utf8',timeout:120000,env:{...process.env,SELENIUM_PACKAGE:path.join(tools,'node_modules/selenium-webdriver'),GECKODRIVER_PATH:path.join(tools,'geckodriver')}});
        console.log(output); expect(output).toContain('FIREFOX_SMOKE_PASS');
    } finally { rmSync(tools,{recursive:true,force:true}); }
}, 600000);
