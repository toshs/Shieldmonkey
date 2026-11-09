import { parseMetadata } from '../utils/metadataParser';
import type { ApprovedScope, Script } from './types';

export const SUPPORTED_GRANTS = new Set([
    'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues',
    'GM_getValues', 'GM_setValues', 'GM_deleteValues',
    'GM_addValueChangeListener', 'GM_removeValueChangeListener',
    'GM_notification', 'GM_openInTab', 'GM_download', 'GM_closeTab',
    'GM_setClipboard', 'GM_addStyle', 'GM_addElement', 'GM_log', 'GM_info',
]);
export function canonicalGrant(value: string): string {
    if (value === 'window.close' || value === 'close') return 'GM_closeTab';
    return value.replace(/^GM\./, 'GM_');
}
export function requestedGrants(code: string): string[] {
    return [...new Set(parseMetadata(code).grant.filter(p => p !== 'none').map(canonicalGrant))].sort();
}
export function scopeFor(code: string): ApprovedScope {
    const metadata = parseMetadata(code);
    const sorted = (list: string[]) => [...new Set(list)].sort();
    return { match: sorted(metadata.match), include: sorted(metadata.include), exclude: sorted(metadata.exclude) };
}
export function needsApproval(script: Pick<Script, 'code'>, previous?: Script): boolean {
    if (!previous?.approvedScope) return true;
    const granted = new Set((previous.grantedPermissions ?? []).map(canonicalGrant));
    return requestedGrants(script.code).some(grant => !granted.has(grant)) ||
        (['match', 'include', 'exclude'] as const).some(key => JSON.stringify(scopeFor(script.code)[key]) !== JSON.stringify(previous.approvedScope![key]));
}
export function hasGrant(grants: string[], operation: string): boolean {
    const allowed = new Set(grants.map(canonicalGrant));
    if (allowed.has(operation)) return true;
    const bulk: Record<string, string> = { GM_getValues: 'GM_getValue', GM_setValues: 'GM_setValue', GM_deleteValues: 'GM_deleteValue' };
    return !!bulk[operation] && allowed.has(bulk[operation]);
}
export function validateScript(value: unknown): asserts value is Script {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid script.');
    const script = value as Script;
    if (typeof script.id !== 'string' || !script.id.trim() || script.id.length > 256 || script.id.includes('\0') || typeof script.code !== 'string' || typeof script.name !== 'string') throw new Error('Invalid script.');
    if (script.enabled !== undefined && typeof script.enabled !== 'boolean') throw new Error('Invalid enabled state.');
    for (const key of ['folderPath', 'filePath', 'namespace', 'sourceUrl', 'referrerUrl'] as const) {
        if (script[key] !== undefined && typeof script[key] !== 'string') throw new Error('Invalid script field: ' + key);
    }
    for (const key of ['folderPath', 'filePath'] as const) {
        const path = script[key];
        if (path && path.split('/').some(part => !part || part === '.' || part === '..' || (part.includes('\\') || [...part].some(char => char.charCodeAt(0) < 32)))) throw new Error('Invalid script path.');
    }
}
export function protectScript(input: Script, previous: Script | undefined, approved = false): Script {
    validateScript(input);
    const metadata = parseMetadata(input.code);
    const requested = requestedGrants(input.code);
    const pending = !approved && needsApproval(input, previous);
    const grants = approved ? requested : requested.filter(grant => (previous?.grantedPermissions ?? []).map(canonicalGrant).includes(grant));
    const enabled = !pending && input.enabled !== false;
    const changed = !previous || previous.code !== input.code || previous.enabled !== enabled ||
        JSON.stringify(previous.grantedPermissions) !== JSON.stringify(grants);
    return {
        id: input.id, name: metadata.name || input.name, code: input.code,
        namespace: metadata.namespace || '', enabled, grantedPermissions: grants,
        approvedScope: approved ? scopeFor(input.code) : previous?.approvedScope,
        pendingApproval: pending,
        sourceUrl: input.sourceUrl ?? previous?.sourceUrl, referrerUrl: input.referrerUrl ?? previous?.referrerUrl,
        folderPath: input.folderPath ?? previous?.folderPath ?? '', filePath: input.filePath ?? previous?.filePath,
        installDate: previous?.installDate ?? input.installDate ?? Date.now(),
        updateDate: changed ? Date.now() : previous?.updateDate,
        token: changed || !previous?.token ? crypto.randomUUID() : previous.token,
    };
}
export function exportScript(script: Script): Script {
    const { token, lastSavedCode, approvedScope, pendingApproval, ...data } = script;
    void token; void lastSavedCode; void approvedScope; void pendingApproval;
    return data;
}
export function publicScript(script: Script): Script {
    const { token, ...data } = script;
    void token;
    return data;
}
