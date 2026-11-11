import { expect, it } from 'vitest';
import { planScriptImports } from '../../src/utils/scriptImport';
import { processScriptContent } from '../../src/utils/importManager';
import { protectScript, scopeFor } from '../../src/shared/policy';
const source = '// ==UserScript==\n// @name Imported\n// @namespace demo\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\n';
it('retains the installed identity, folder and enable state when reviewing a file update', async () => {
    const old = { ...await processScriptContent(source), enabled: true, folderPath: 'Tools', filePath: 'Tools/Imported.user.js', token: 'private', approvedScope: scopeFor(source) };
    const next = await processScriptContent(source + 'console.log(2);');
    const [candidate] = planScriptImports([next], [old]);
    expect(candidate).toMatchObject({ id: old.id, enabled: true, folderPath: 'Tools', filePath: 'Tools/Imported.user.js', installDate: old.installDate });
    expect(candidate.code).toContain('console.log(2)');
    expect(protectScript(candidate, old)).toMatchObject({ id: old.id, pendingApproval: false });
});
it('does not let metadata matching grant new permissions or import duplicate files', async () => {
    const old = { ...await processScriptContent(source), approvedScope: scopeFor(source) };
    const next = await processScriptContent(source.replace('@grant none', '@grant GM_download'));
    const [candidate] = planScriptImports([next], [old]);
    expect(protectScript(candidate, old)).toMatchObject({ pendingApproval: true, enabled: false, grantedPermissions: [] });
    expect(() => planScriptImports([next, next], [old])).toThrow('duplicate');
});
