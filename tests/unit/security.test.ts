import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupSecurityRules } from '../../src/background/security';
afterEach(() => vi.unstubAllGlobals());
describe('network protection', () => {
    it('removes the legacy CORS rule and preserves the navigation block', async () => {
        const update = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://test-id/' }, declarativeNetRequest: { updateDynamicRules: update } });
        await setupSecurityRules();
        expect(update).toHaveBeenCalledWith({ removeRuleIds: [1, 2], addRules: [{ id: 2, priority: 1, action: { type: 'block' }, condition: { initiatorDomains: ['test-id'], excludedRequestDomains: ['shieldmonkey.github.io', 'github.com'], resourceTypes: ['main_frame', 'sub_frame'], regexFilter: '^http' } }] });
    });
    it('does not silently ignore protection setup failures', async () => {
        vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://test-id/' }, declarativeNetRequest: { updateDynamicRules: vi.fn().mockRejectedValue(new Error('failed')) } });
        await expect(setupSecurityRules()).rejects.toThrow('failed');
    });
});
