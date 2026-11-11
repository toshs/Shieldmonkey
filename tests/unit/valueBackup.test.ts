import { expect, it } from 'vitest';
import { collectValueBackup, gmValuePrefix, validateValueBackup, valueBackupFields } from '../../src/shared/valueBackup';
import { parseBackup, serializeBackup } from '../../src/utils/backupManager';
const script = { id: 'review]:id', name: 'Review', code: '// code', enabled: false, token: 'private-token', approvedScope: { match: [], include: [], exclude: [] } };
it('backs up only selected script values with exact origin boundaries and tricky key names', () => {
    const first = gmValuePrefix(script.id, 'https://example.com');
    const other = gmValuePrefix(script.id, 'https://example.org');
    const stored = { scripts: [script], gmNotificationRoutesV1: ['private-route'], [first + 'value]:key']: { progress: 7 }, [other + '__proto__']: 'data', [gmValuePrefix('other-script', 'https://example.com') + 'key']: 'not selected' };
    const values = collectValueBackup(stored, new Set([script.id]));
    expect(values).toHaveLength(2);
    const text = serializeBackup([script], '0.5.3', undefined, { folders: ['Empty'], gmValues: values });
    expect(text).not.toContain('private-token'); expect(text).not.toContain('private-route'); expect(text).not.toContain('approvedScope');
    const backup = parseBackup(text);
    expect(backup.formatVersion).toBe(3); expect(backup.folders).toEqual(['Empty']);
    expect(valueBackupFields(backup.gmValues!)).toMatchObject({ [first + 'value]:key']: { progress: 7 }, [other + '__proto__']: 'data' });
});
it.each([
    [{ scriptId: 'unknown', origin: 'https://example.com', values: { key: 1 } }],
    [{ scriptId: script.id, origin: 'https://example.com/path', values: { key: 1 } }],
    [{ scriptId: script.id, origin: 'chrome-extension://private', values: { key: 1 } }],
    [{ scriptId: script.id, origin: 'https://example.com', values: [] }],
    [{ scriptId: script.id, origin: 'https://example.com', values: { '': 1 } }],
])('rejects malformed or foreign saved data %j', entry => {
    expect(() => validateValueBackup([entry], new Set([script.id]))).toThrow();
});
it('rejects duplicate scopes and preserves older code-only backup formats', () => {
    const scope = { scriptId: script.id, origin: 'https://example.com', values: { key: 1 } };
    expect(() => validateValueBackup([scope, scope], new Set([script.id]))).toThrow('Duplicate');
    expect(parseBackup(serializeBackup([script], '0.5.2')).gmValues).toBeUndefined();
    expect(parseBackup(JSON.stringify({ scripts: [script] })).scripts).toHaveLength(1);
});
