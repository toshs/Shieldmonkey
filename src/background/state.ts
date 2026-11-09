import type { Script } from '../shared/types';
import { canonicalGrant, needsApproval, scopeFor } from '../shared/policy';

export const stateReady = (async () => {
    if (chrome.storage.local.setAccessLevel) await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const data = await chrome.storage.local.get(null);
    if (data.securityVersion === 1) return;
    if (data.scripts !== undefined && !Array.isArray(data.scripts)) throw new Error('Invalid saved library. Migration stopped.');
    const scripts = ((data.scripts ?? []) as Script[]).map(script => {
        const previous = { ...script, approvedScope: scopeFor(script.code), grantedPermissions: (script.grantedPermissions ?? []).map(canonicalGrant) };
        const pendingApproval = needsApproval(script, previous);
        return { ...previous, token: crypto.randomUUID(), pendingApproval, enabled: pendingApproval ? false : script.enabled !== false };
    });
    await chrome.storage.local.set({ scripts, legacyGMIds: scripts.map(script => script.id), securityVersion: 1, backupRestoreMarker: crypto.randomUUID() });
    const pendingKeys = Object.keys(data).filter(key => key.startsWith('pending_install_'));
    if (pendingKeys.length) await chrome.storage.local.remove(pendingKeys);
})();
// Keep the rejected promise available to callers; initialization errors must not
// accidentally start scripts with weaker settings.
void stateReady.catch(error => console.error('Security migration stopped:', error));
