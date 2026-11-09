import { describe, expect, it } from 'vitest';
import { exportScript, hasGrant, needsApproval, protectScript, scopeFor } from '../../src/shared/policy';
import type { Script } from '../../src/shared/types';
const code = (grant = 'none', match = 'https://example.com/*') => `// ==UserScript==\n// @name Test\n// @match ${match}\n// @grant ${grant}\n// ==/UserScript==\nvoid 0;`;
const candidate: Script = { id: 'test', name: 'Test', code: code(), enabled: true };
describe('script permission policy', () => {
    it('stages a new script without trusting permission fields from a file', () => {
        const result = protectScript({ ...candidate, code: code('GM_download'), grantedPermissions: ['GM_download'], approvedScope: scopeFor(code('GM_download')), token: 'attacker' }, undefined);
        expect(result.enabled).toBe(false); expect(result.pendingApproval).toBe(true); expect(result.grantedPermissions).toEqual([]); expect(result.token).not.toBe('attacker');
    });
    it('records explicit approval and normalizes dot notation', () => {
        const approved = protectScript({ ...candidate, code: code('GM.getValue') }, undefined, true);
        expect(approved.enabled).toBe(true); expect(approved.pendingApproval).toBe(false); expect(approved.grantedPermissions).toEqual(['GM_getValue']); expect(needsApproval(approved, approved)).toBe(false);
    });
    it('pauses a workspace edit that adds grants or changes sites', () => {
        const old = protectScript(candidate, undefined, true);
        for (const changed of [code('GM_download'), code('none', '*://*/*')]) {
            const result = protectScript({ ...old, code: changed, grantedPermissions: ['GM_download'] }, old);
            expect(result.pendingApproval).toBe(true); expect(result.enabled).toBe(false); expect(result.token).not.toBe(old.token);
        }
    });
    it('keeps approvals for ordinary edits, and drops removed permissions', () => {
        const old = protectScript({ ...candidate, code: code('GM_getValue') }, undefined, true);
        const edited = protectScript({ ...old, code: old.code + '\nconsole.log(1)' }, old);
        expect(edited.enabled).toBe(true); expect(edited.pendingApproval).toBe(false);
        const reduced = protectScript({ ...old, code: code() }, old);
        expect(reduced.grantedPermissions).toEqual([]); expect(reduced.pendingApproval).toBe(false);
    });
    it('preserves approvals after browser storage sorts object properties', () => {
        const old = protectScript(candidate, undefined, true);
        old.approvedScope = { exclude: [], include: [], match: ['https://example.com/*'] };
        expect(needsApproval(old, old)).toBe(false);
        expect(protectScript({ ...old, enabled: false }, old).pendingApproval).toBe(false);
    });
    it('never records unsupported API names as granted authority', () => {
        const script = protectScript({ ...candidate, code: code('GM_futureApi') }, undefined, true);
        expect(script.grantedPermissions).toEqual([]);
        expect(needsApproval(script, script)).toBe(false);
        expect(script.pendingApproval).toBe(false);
    });
    it('does not export live credentials or profile-local approvals', () => {
        const script = protectScript(candidate, undefined, true);
        const exported = exportScript(script);
        expect(exported).not.toHaveProperty('token'); expect(exported).not.toHaveProperty('approvedScope'); expect(exported).not.toHaveProperty('pendingApproval'); expect(exported.id).toBe(script.id);
    });
    it('permits documented aliases and bulk operations without allowing tab closure', () => {
        expect(hasGrant(['GM.setValue'], 'GM_setValues')).toBe(true);
        expect(hasGrant(['window.close'], 'GM_closeTab')).toBe(true);
        expect(hasGrant([], 'GM_closeTab')).toBe(false);
    });
});
