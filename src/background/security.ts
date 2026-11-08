import userScriptRules from '../rules.json';

export async function setupSecurityRules() {
    try {
        const extensionUrl = chrome.runtime.getURL('');
        const extensionDomain = new URL(extensionUrl).hostname;

        const hasStaticRules = Boolean(
            chrome.runtime.getManifest().declarative_net_request?.rule_resources?.length
        );
        const rules: chrome.declarativeNetRequest.Rule[] = [
            // Vivaldi uses profile-managed dynamic rules to avoid creating
            // _metadata/generated_indexed_rulesets in the unpacked source.
            ...(!hasStaticRules ? userScriptRules as chrome.declarativeNetRequest.Rule[] : []),
            {
                id: 2,
                priority: 1,
                action: { type: 'block' },
                condition: {
                    initiatorDomains: [extensionDomain],
                    excludedRequestDomains: ['shieldmonkey.github.io', 'github.com'],
                    resourceTypes: ['main_frame', 'sub_frame'],
                    regexFilter: "^http"
                }
            }
        ];

        await chrome.declarativeNetRequest.updateDynamicRules({
            // Also remove rule 1 when switching back to a static-rules build.
            removeRuleIds: [...userScriptRules.map(rule => rule.id), 2],
            addRules: rules
        });
        console.log("DNR dynamic security rules configured");
    } catch (e) {
        console.error("Failed to setup DNR dynamic security rules", e);
    }
}
