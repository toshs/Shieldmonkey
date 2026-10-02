import { describe, expect, it } from 'vitest';
import { extractUserscript, hasUserscriptHeader } from '../../src/utils/scriptTransfer';

const script = '// ==UserScript==\n// @name Sample\n// ==/UserScript==\nconsole.log(`hello`);';

describe('AI response import', () => {
    it('prefers the fenced userscript over explanatory code blocks', () => {
        const answer = `Try this:\n\n\`\`\`js\nconsole.log('example');\n\`\`\`\n\n\`\`\`javascript\n${script}\n\`\`\``;
        expect(extractUserscript(answer)).toBe(script);
    });

    it('accepts a complete script pasted without a code fence', () => {
        expect(extractUserscript(script)).toBe(script);
        expect(hasUserscriptHeader(script)).toBe(true);
    });

    it('rejects snippets without userscript metadata', () => {
        expect(hasUserscriptHeader(extractUserscript('```js\nalert(1);\n```'))).toBe(false);
    });

    it('rejects unfenced AI prose before a metadata header', () => {
        expect(hasUserscriptHeader(`Here is my answer:\n${script}`)).toBe(false);
    });
});
