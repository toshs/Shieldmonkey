import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSecurityRules } from '../../src/background/security';
import userScriptRules from '../../src/rules.json';

const extensionId = 'test-extension-id';
const unrelatedRule: chrome.declarativeNetRequest.Rule = {
    id: 99,
    action: { type: 'block' },
    condition: { urlFilter: 'unrelated.example' },
};
let manifest: chrome.runtime.Manifest;
let savedRules: Map<number, chrome.declarativeNetRequest.Rule>;
const updateDynamicRules = vi.fn(async (update: chrome.declarativeNetRequest.UpdateRuleOptions) => {
    for (const id of update.removeRuleIds ?? []) savedRules.delete(id);
    for (const rule of update.addRules ?? []) {
        if (savedRules.has(rule.id)) throw new Error('Duplicate rule ID');
        savedRules.set(rule.id, rule);
    }
});

beforeEach(() => {
    manifest = { manifest_version: 3, name: 'ShieldMonkey', version: '0.4.3' };
    savedRules = new Map([[unrelatedRule.id, unrelatedRule]]);
    updateDynamicRules.mockClear();
    vi.stubGlobal('chrome', {
        runtime: {
            getURL: () => `chrome-extension://${extensionId}/`,
            getManifest: () => manifest,
        },
        declarativeNetRequest: { updateDynamicRules },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('network security rules', () => {
    it('keeps the packaged userscript response-header rule when static rules are absent', async () => {
        await setupSecurityRules();
        expect(savedRules.get(1)).toEqual(userScriptRules[0]);
        const rule = savedRules.get(1)!;
        expect(rule.action).toEqual({
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' }],
        });
        expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest']);
        const filter = new RegExp(rule.condition.regexFilter!);
        expect(filter.test('https://example.com/test.user.js?version=2')).toBe(true);
        expect(filter.test('https://example.com/test.js')).toBe(false);
    });

    it('retains the extension navigation block and its trusted-domain exceptions', async () => {
        await setupSecurityRules();
        expect(savedRules.get(2)).toEqual({
            id: 2,
            priority: 1,
            action: { type: 'block' },
            condition: {
                initiatorDomains: [extensionId],
                excludedRequestDomains: ['shieldmonkey.github.io', 'github.com'],
                resourceTypes: ['main_frame', 'sub_frame'],
                regexFilter: '^http',
            },
        });
    });

    it('replaces owned rules on repeated worker starts without deleting other dynamic rules', async () => {
        await setupSecurityRules();
        await setupSecurityRules();
        expect(updateDynamicRules).toHaveBeenCalledTimes(2);
        expect([...savedRules.keys()].sort()).toEqual([1, 2, 99]);
        expect(savedRules.get(99)).toEqual(unrelatedRule);
    });

    it('removes a migrated dynamic header rule when returning to a static-rules build', async () => {
        await setupSecurityRules();
        manifest.declarative_net_request = {
            rule_resources: [{ id: 'ruleset_1', enabled: true, path: 'src/rules.json' }],
        };
        await setupSecurityRules();
        expect(savedRules.has(1)).toBe(false);
        expect(savedRules.has(2)).toBe(true);
        expect(savedRules.get(99)).toEqual(unrelatedRule);
    });

    it('reports an API failure without an unhandled rejection', async () => {
        const error = new Error('DNR unavailable');
        updateDynamicRules.mockRejectedValueOnce(error);
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(setupSecurityRules()).resolves.toBeUndefined();
        expect(report).toHaveBeenCalledWith('Failed to setup DNR dynamic security rules', error);
    });
});
