import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// Firefox on macOS needs an unlocked WindowServer. CI runs this smoke test
// on Linux in a disposable profile, using an official Playwright browser.
test.skipIf(process.platform !== 'linux' || !process.env.CI)('Firefox loads 0.5 and preserves private GM values across reload', () => {
    const require = createRequire(import.meta.url);
    const tools = mkdtempSync(path.join(tmpdir(), 'shieldmonkey-firefox-tools-'));
    try {
        execFileSync(process.execPath, [path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', '--with-deps', 'firefox'], {stdio:'inherit',timeout:240000});
        execFileSync('npm', ['install','--prefix',tools,'--ignore-scripts','--no-audit','--no-fund','web-ext@8.9.0'], {stdio:'inherit',timeout:120000});
        execFileSync(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),'build','--configLoader','runner'], {env:{...process.env,TARGET_BROWSER:'firefox'},stdio:'inherit',timeout:120000});
        const output = execFileSync(process.execPath, ['tests/firefox/smoke.mjs'], {encoding:'utf8',timeout:120000,env:{...process.env,WEB_EXT_REMOTE_MODULE:path.join(tools,'node_modules/web-ext/lib/firefox/remote.js')}});
        console.log(output); expect(output).toContain('FIREFOX_SMOKE_PASS');
    } finally { rmSync(tools,{recursive:true,force:true}); }
}, 600000);
