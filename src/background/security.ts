export async function setupSecurityRules() {
    const domain = new URL(chrome.runtime.getURL('')).hostname;
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1, 2],
        addRules: [{
            id: 2, priority: 1, action: { type: 'block' },
            condition: { initiatorDomains: [domain], excludedRequestDomains: ['shieldmonkey.github.io', 'github.com'], resourceTypes: ['main_frame', 'sub_frame'], regexFilter: '^http' },
        }],
    });
}
