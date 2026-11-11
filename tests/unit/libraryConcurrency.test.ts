import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Script } from '../../src/shared/types';
import { scopeFor } from '../../src/shared/policy';
import { withLibraryLock } from '../../src/shared/library';

const code = (body: string) => '// ==UserScript==\n// @name Review\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\n' + body;
let stored: Record<string, unknown>;
beforeEach(() => {
    vi.resetModules();
    stored = { securityVersion: 1, libraryRevision: 'initial', scripts: [{ id: 'review', name: 'Review', code: code('initial'), enabled: false, token: 'old', grantedPermissions: [], approvedScope: scopeFor(code('initial')) }] };
    vi.stubGlobal('chrome', { storage: { local: {
        get: async (keys: string | string[] | null) => structuredClone(keys === null ? stored : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in stored).map(key => [key, stored[key]]))),
        set: vi.fn(async (fields: object) => { Object.assign(stored, structuredClone(fields)); }),
    } }, tabs: { query: async () => [] }, runtime: { getManifest: () => ({ version: '0.5.3' }) } });
});
afterEach(() => vi.unstubAllGlobals());

it('rejects a stale workspace snapshot without overwriting the newer save', async () => {
    const { handleApplyLibrary, handleSaveScript } = await import('../../src/background/scripts');
    const initial = structuredClone(stored.scripts) as Script[];
    await handleSaveScript({ ...initial[0], code: code('newer save') }, false, initial[0].code);
    await expect(handleApplyLibrary(initial, [], true, 'initial')).rejects.toThrow('library changed');
    expect((stored.scripts as Script[])[0].code).toBe(code('newer save'));
});
it('rejects stale editor code and stale permission approvals', async () => {
    const { handleSaveScript, handleToggleScript } = await import('../../src/background/scripts');
    const original = (stored.scripts as Script[])[0];
    await handleSaveScript({ ...original, code: code('newer save') }, false, original.code);
    await expect(handleSaveScript({ ...original, code: code('stale editor') }, false, original.code)).rejects.toThrow('another editor');
    await expect(handleToggleScript('review', true, true, 'initial')).rejects.toThrow('library changed');
    expect((stored.scripts as Script[])[0].code).toBe(code('newer save'));
});
it('uses one shared lock for independent UI operations and releases it on failure', async () => {
    let queue = Promise.resolve<unknown>(undefined);
    const request = vi.fn((_name: string, work: () => Promise<unknown>) => { const result = queue.then(work, work); queue = result.catch(() => {}); return result; });
    vi.stubGlobal('navigator', { locks: { request } });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const scan = withLibraryLock(async () => { order.push('read'); await barrier; order.push('commit'); throw new Error('disk failure'); });
    const saving = withLibraryLock(async () => { order.push('save'); });
    await Promise.resolve(); expect(order).toEqual(['read']);
    release(); await expect(scan).rejects.toThrow('disk failure'); await saving;
    expect(order).toEqual(['read', 'commit', 'save']);
    expect(request.mock.calls.map(call => call[0])).toEqual(['shieldmonkey-library-v1', 'shieldmonkey-library-v1']);
});
it('restores data atomically with the library, keeps other scopes and rotates affected tokens', async () => {
    const { gmValuePrefix } = await import('../../src/shared/valueBackup');
    const { handleExportBackup, handleApplyLibrary } = await import('../../src/background/scripts');
    const one = gmValuePrefix('review', 'https://example.com') + 'progress';
    const other = gmValuePrefix('review', 'https://example.org') + 'progress';
    stored[one] = 1; stored[other] = 9; stored['gmNotificationRoutesV1'] = ['never-export'];
    const backup = await handleExportBackup(true);
    expect(backup.text).not.toContain('never-export'); expect(backup.text).not.toContain('"token"');
    const scripts = stored.scripts as Script[];
    await handleApplyLibrary(scripts, [], true, 'initial', { values: [{ scriptId: 'review', origin: 'https://example.com', values: { progress: 2 } }], revision: backup.valueRevision });
    expect(stored[one]).toBe(2); expect(stored[other]).toBe(9);
    expect((stored.scripts as Script[])[0].token).not.toBe('old');
    expect((stored.scripts as Script[])[0].grantedPermissions).toEqual([]);
    expect(stored['gmMigration:' + JSON.stringify(['review', 'https://example.com'])]).toBe(true);
});
it('rejects changed data previews and foreign script IDs before any restore write', async () => {
    const { handleExportBackup, handleApplyLibrary } = await import('../../src/background/scripts');
    const { changedGMValues } = await import('../../src/background/gmQueue');
    const backup = await handleExportBackup(true);
    changedGMValues();
    await expect(handleApplyLibrary(stored.scripts, [], true, 'initial', { values: [], revision: backup.valueRevision })).rejects.toThrow('data changed');
    const fresh = await handleExportBackup(true);
    await expect(handleApplyLibrary(stored.scripts, [], true, 'initial', { values: [{ scriptId: 'foreign', origin: 'https://example.com', values: { key: 1 } }], revision: fresh.valueRevision })).rejects.toThrow('Invalid');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
});
it('leaves library and values untouched when a restore storage write fails', async () => {
    const { handleExportBackup, handleApplyLibrary } = await import('../../src/background/scripts');
    const backup = await handleExportBackup(true);
    const before = structuredClone(stored);
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('QUOTA_BYTES exceeded'));
    await expect(handleApplyLibrary(stored.scripts, [], true, 'initial', { values: [{ scriptId: 'review', origin: 'https://example.com', values: { key: 1 } }], revision: backup.valueRevision })).rejects.toThrow('QUOTA_BYTES');
    expect(stored).toEqual(before);
});
