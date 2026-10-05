import { parseMetadata } from '../utils/metadataParser';
import { getGMAPIScript } from '../utils/scriptGenerator';
import type { Script } from './types';
import { updateActiveTabBadge } from './badge';
import {
    isUserScriptsAvailable,
    configureUserScriptsWorld,
    getUserScripts,
    unregisterUserScripts,
    registerUserScripts
} from '../utils/browserPolyfill';

function registrationFor(script: Script): chrome.userScripts.UserScript {
    const metadata = parseMetadata(script.code);
    const matches = [...metadata.match, ...metadata.include];
    return {
        id: script.id,
        matches: matches.length > 0 ? matches : ['<all_urls>'],
        excludeMatches: metadata.exclude,
        js: [{ code: getGMAPIScript({
            id: script.id,
            name: script.name,
            version: metadata.version || '1.0',
            permissions: script.grantedPermissions || [],
            namespace: metadata.namespace,
            description: metadata.description,
            token: script.token || ''
        }) + '\n' + script.code }],
        runAt: (metadata['run-at'] || 'document_end') as 'document_start' | 'document_end' | 'document_idle',
        world: 'USER_SCRIPT'
    };
}

// The browser is the source of truth for pattern and run-at validation. A
// harmless temporary registration also validates scripts saved while disabled.
async function validateRegistration(script: Script): Promise<void> {
    const probeId = `shieldmonkey-validation-${crypto.randomUUID()}`;
    const registration = registrationFor(script);
    try {
        await registerUserScripts([{ ...registration, id: probeId, js: [{ code: 'void 0;' }] }]);
    } finally {
        await unregisterUserScripts({ ids: [probeId] }).catch(() => undefined);
    }
}

async function restoreRegistration(previous: Script | undefined, wasRegistered: boolean): Promise<void> {
    if (!previous || !wasRegistered) return;
    try {
        await registerUserScripts([registrationFor(previous)]);
    } catch (error) {
        console.error(`Could not restore registration for ${previous.id}:`, error);
    }
}


export async function reloadAllScripts() {
    const failures: string[] = [];
    if (await isUserScriptsAvailable()) {
        try {
            await configureUserScriptsWorld({
                messaging: true,
            });

            const settings = await chrome.storage.local.get(['extensionEnabled', 'scripts']);
            const extensionEnabled = settings.extensionEnabled !== false;
            const savedScripts = (settings.scripts || []) as Script[];

            if (settings.extensionEnabled === undefined) {
                await chrome.storage.local.set({ extensionEnabled: true });
            }

            try {
                const existing = (await getUserScripts()) as chrome.userScripts.UserScript[];
                const ids = existing.map(s => s.id);
                if (ids.length > 0) {
                    await unregisterUserScripts({ ids });
                }
            } catch (e) {
                console.warn("Failed to unregister existing scripts", e);
                failures.push(e instanceof Error ? e.message : String(e));
            }

            if (extensionEnabled && savedScripts.length > 0) {
                for (const script of savedScripts) {
                    if (!script.enabled) continue;

                    try {
                        await registerUserScripts([registrationFor(script)]);
                    } catch (e) {
                        console.error(`Failed to register script ${script.name}:`, e);
                        failures.push(`${script.name}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }

        } catch (err) {
            console.error("Failed to initialize user scripts:", err);
            failures.push(err instanceof Error ? err.message : String(err));
        }
    } else {
        failures.push('chrome.userScripts API is not available');
    }

    await updateActiveTabBadge();
    if (failures.length > 0) throw new Error(failures.join('\n'));
}

export async function handleToggleGlobal(enabled: boolean) {
    await chrome.storage.local.set({ extensionEnabled: enabled });
    await reloadAllScripts();
}

export async function handleSaveScript(script: Script) {
    if (!await isUserScriptsAvailable()) throw new Error("API unavailable");

    const data = await chrome.storage.local.get(['scripts', 'extensionEnabled']);
    const scripts: Script[] = Array.isArray(data.scripts) ? [...data.scripts] : [];
    const index = scripts.findIndex(s => s.id === script.id);
    const previous = index === -1 ? undefined : scripts[index];
    const updated: Script = { ...script };
    const now = Date.now();

    updated.token = crypto.randomUUID();

    if (previous) {
        updated.installDate = previous.installDate || now;
        updated.updateDate = now;
        if (updated.enabled === undefined) updated.enabled = previous.enabled;
        if (!updated.grantedPermissions) updated.grantedPermissions = previous.grantedPermissions || [];
        if (!updated.sourceUrl && previous.sourceUrl) updated.sourceUrl = previous.sourceUrl;
        if (!updated.referrerUrl && previous.referrerUrl) updated.referrerUrl = previous.referrerUrl;
    } else {
        updated.installDate = now;
        updated.updateDate = now;
        if (updated.enabled === undefined) updated.enabled = true;
        if (!updated.grantedPermissions) updated.grantedPermissions = [];
    }

    const metadata = parseMetadata(updated.code);

    if (metadata.name) updated.name = metadata.name;
    if (metadata.namespace) updated.namespace = metadata.namespace;

    if (metadata.grant && Array.isArray(metadata.grant)) updated.grantedPermissions = metadata.grant;

    let uniqueName = updated.name;
    let counter = 1;
    while (true) {
        const conflict = scripts.find((s) =>
            s.id !== updated.id &&
            s.name === uniqueName &&
            (s.namespace || '') === (updated.namespace || '')
        );
        if (!conflict) break;
        uniqueName = `${updated.name} (${counter})`;
        counter++;
    }
    updated.name = uniqueName;

    const wasRegistered = (await getUserScripts({ ids: [updated.id] })).length > 0;
    const shouldRegister = updated.enabled !== false && data.extensionEnabled !== false;
    if (!shouldRegister) await validateRegistration(updated);

    try {
        if (wasRegistered) await unregisterUserScripts({ ids: [updated.id] });
        if (shouldRegister) await registerUserScripts([registrationFor(updated)]);
        if (index === -1) scripts.push(updated);
        else scripts[index] = updated;
        await chrome.storage.local.set({ scripts });
    } catch (error) {
        if (shouldRegister) await unregisterUserScripts({ ids: [updated.id] }).catch(() => undefined);
        await restoreRegistration(previous, wasRegistered);
        throw error;
    }

    await updateActiveTabBadge();
}

export async function handleToggleScript(scriptId: string, enabled: boolean) {
    if (!await isUserScriptsAvailable()) throw new Error('API unavailable');

    const data = await chrome.storage.local.get(['scripts', 'extensionEnabled']);
    const scripts: Script[] = Array.isArray(data.scripts) ? [...data.scripts] : [];
    const index = scripts.findIndex(s => s.id === scriptId);
    const previous = scripts[index];

    if (previous) {
        const updated = { ...previous, enabled, token: previous.token || crypto.randomUUID() };
        const wasRegistered = (await getUserScripts({ ids: [scriptId] })).length > 0;
        const shouldRegister = enabled && data.extensionEnabled !== false;
        if (enabled && !shouldRegister) await validateRegistration(updated);
        try {
            if (wasRegistered) await unregisterUserScripts({ ids: [scriptId] });
            if (shouldRegister) await registerUserScripts([registrationFor(updated)]);
            scripts[index] = updated;
            await chrome.storage.local.set({ scripts });
        } catch (error) {
            if (shouldRegister) await unregisterUserScripts({ ids: [scriptId] }).catch(() => undefined);
            await restoreRegistration(previous, wasRegistered);
            throw error;
        }
        await updateActiveTabBadge();
    }
}

export async function handleDeleteScript(scriptId: string) {
    if (!await isUserScriptsAvailable()) throw new Error('API unavailable');

    const data = await chrome.storage.local.get('scripts');
    const scripts: Script[] = Array.isArray(data.scripts) ? data.scripts : [];
    const previous = scripts.find(s => s.id === scriptId);
    if (!previous) return;
    const newScripts = scripts.filter((s) => s.id !== scriptId);
    const wasRegistered = (await getUserScripts({ ids: [scriptId] })).length > 0;
    if (wasRegistered) await unregisterUserScripts({ ids: [scriptId] });
    try {
        await chrome.storage.local.set({ scripts: newScripts });
    } catch (error) {
        await restoreRegistration(previous, wasRegistered);
        throw error;
    }
    await updateActiveTabBadge();
}
