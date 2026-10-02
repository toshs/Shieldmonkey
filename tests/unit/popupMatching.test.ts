import { expect, test } from 'vitest';
import { readPopupMetadata, matchesPopupMetadata } from '../../src/popup/data';
import { isScriptMatchingUrl } from '../../src/utils/scriptMatcher';

const examples = [
    ['// ==UserScript==\n// @match https://example.com/*\n// ==/UserScript==', 'https://example.com/page'],
    ['// ==UserScript==\n// @include https://*.example.com/*\n// ==/UserScript==', 'https://sub.example.com/page'],
    ['// ==UserScript==\n// @match <all_urls>\n// @exclude https://example.com/private/*\n// ==/UserScript==', 'https://example.com/private/page'],
    ['// ==UserScript==\n// @name Default\n// ==/UserScript==', 'https://example.com/'],
    ['no metadata', 'https://example.com/']
] as const;

test('fast popup matching follows the userscript matcher', () => {
    for (const [code, url] of examples) {
        expect(matchesPopupMetadata(readPopupMetadata(code), url)).toBe(isScriptMatchingUrl(code, url));
    }
});
