import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
describe('0.5 security migration', () => {
    it('preserves IDs, settings and values, rotates once, and pauses unapproved grants', async () => {
        vi.resetModules();
        const code = (grant: string) => `// ==UserScript==\n// @name Legacy\n// @match https://example.com/*\n// @grant ${grant}\n// ==/UserScript==`;
        const data: Record<string, unknown> = { theme:'dark', extensionEnabled:true, 'val_legacy_https://example.com_key':'keep', pending_install_1:'obsolete', scripts:[
            {id:'legacy',name:'Legacy',code:code('GM.getValue'),enabled:true,grantedPermissions:['GM_getValue'],token:'old',installDate:123},
            {id:'extra',name:'Extra',code:code('GM_download'),enabled:true,grantedPermissions:[]},
        ] };
        vi.stubGlobal('chrome', {storage:{local:{setAccessLevel:vi.fn().mockResolvedValue(undefined),get:async()=>({...data}),set:async(v:object)=>Object.assign(data,v),remove:async(keys:string[])=>keys.forEach(key=>delete data[key])}}});
        await (await import('../../src/background/state')).stateReady;
        const scripts = data.scripts as {id:string;enabled:boolean;token:string;pendingApproval:boolean;installDate:number}[];
        expect(scripts[0]).toMatchObject({id:'legacy',enabled:true,pendingApproval:false,installDate:123});
        expect(scripts[0].token).not.toBe('old');
        expect(scripts[1]).toMatchObject({id:'extra',enabled:false,pendingApproval:true});
        expect(data.theme).toBe('dark');expect(data['val_legacy_https://example.com_key']).toBe('keep');expect(data).not.toHaveProperty('pending_install_1');
        const token = scripts[0].token;
        vi.resetModules();await (await import('../../src/background/state')).stateReady;
        expect((data.scripts as {token:string}[])[0].token).toBe(token);
    });
});
