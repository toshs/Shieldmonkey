export interface GMValueBackup { scriptId: string; origin: string; values: Record<string, unknown> }
export const gmValuePrefix = (scriptId: string, origin: string) => 'gmv1:' + JSON.stringify([scriptId, origin]) + ':';

export function validateValueBackup(value: unknown, scriptIds: Set<string>): GMValueBackup[] {
    if (!Array.isArray(value)) throw new Error('Invalid saved script data.');
    const scopes = new Set<string>();
    const result = value.map(item => {
        if (!item || typeof item !== 'object' || typeof item.scriptId !== 'string' || !scriptIds.has(item.scriptId)
            || typeof item.origin !== 'string' || !item.values || typeof item.values !== 'object' || Array.isArray(item.values)) throw new Error('Invalid saved script data.');
        const url = new URL(item.origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== item.origin) throw new Error('Invalid saved data origin.');
        const scope = JSON.stringify([item.scriptId, item.origin]);
        if (scopes.has(scope)) throw new Error('Duplicate saved data scope.');
        scopes.add(scope);
        for (const [key, value] of Object.entries(item.values)) {
            if (!key || key.length > 4096 || value === undefined) throw new Error('Invalid saved data key.');
        }
        return { scriptId: item.scriptId, origin: item.origin, values: item.values as Record<string, unknown> };
    });
    // Bound imported data before sending it to extension storage.
    if (new TextEncoder().encode(JSON.stringify(result)).length > 10 * 1024 * 1024) throw new Error('Saved script data exceeds 10 MB.');
    return result;
}
export function collectValueBackup(stored: Record<string, unknown>, scriptIds: Set<string>): GMValueBackup[] {
    const scopes = new Map<string, GMValueBackup>();
    for (const [key, value] of Object.entries(stored)) {
        if (!key.startsWith('gmv1:')) continue;
        for (let end = key.indexOf(']:', 5); end !== -1; end = key.indexOf(']:', end + 2)) {
            try {
                const pair: unknown = JSON.parse(key.slice(5, end + 1));
                if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(v => typeof v === 'string') || !scriptIds.has(pair[0])) continue;
                const prefix = gmValuePrefix(pair[0], pair[1]);
                if (!key.startsWith(prefix)) continue;
                const scope = JSON.stringify(pair);
                const entry = scopes.get(scope) || { scriptId: pair[0], origin: pair[1], values: Object.create(null) };
                entry.values[key.slice(prefix.length)] = value; scopes.set(scope, entry);
                break;
            } catch { /* This delimiter can be part of a quoted ID or value key. */ }
        }
    }
    return validateValueBackup([...scopes.values()], scriptIds);
}
export function valueBackupFields(values: GMValueBackup[]): Record<string, unknown> {
    return Object.fromEntries(values.flatMap(scope => [
        ['gmMigration:' + JSON.stringify([scope.scriptId, scope.origin]), true],
        ...Object.entries(scope.values).map(([key, value]) => [gmValuePrefix(scope.scriptId, scope.origin) + key, value]),
    ]));
}
