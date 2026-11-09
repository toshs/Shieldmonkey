import { describe, expect, it } from 'vitest';
import { assertSafeScriptBody } from '../../src/shared/syntax';
import { getGMAPIScript } from '../../src/utils/scriptGenerator';
describe('userscript bootstrap source boundary', () => {
    it('accepts real function bodies, including return and nested delimiters', () => {
        for (const code of [
            '// ==UserScript==\n// @name Test\n// ==/UserScript==\n(function(){ return {x:"}"}; })();',
            'if (true) return; const value = `} ${(() => "{")()}`;',
            'const pattern = /[{}]/; /* } */ console.log(pattern);',
        ]) expect(() => assertSafeScriptBody(code)).not.toThrow();
    });
    it('rejects source which escapes the bootstrap before the GM handshake', () => {
        const attack = '}).call(scope);\n})(window);\nwindow.escaped = true;\n(async function(scope){\n(function(){';
        expect(() => getGMAPIScript({id:'attacker',name:'Attack',version:'1',permissions:[],token:'test'},attack)).toThrow(/syntax/);
        expect(() => assertSafeScriptBody('}\nwindow.escaped=true;\nfunction another(){')).toThrow(/syntax/);
    });
    it('rejects incomplete or mismatched source instead of registering broken code', () => {
        for (const code of ['function broken(', '/* unterminated', 'const value = "unterminated']) expect(() => assertSafeScriptBody(code)).toThrow(/syntax/);
    });
});
