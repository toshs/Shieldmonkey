
import { describe, it, expect } from 'vitest';
import { isScriptMatchingUrl } from '../../src/utils/scriptMatcher';

describe('isScriptMatchingUrl', () => {
    it('should match URL with @match', () => {
        const code = `
// ==UserScript==
// @name Test
// @match *://example.com/*
// ==/UserScript==
        `;
        expect(isScriptMatchingUrl(code, 'https://example.com/foo')).toBe(true);
        expect(isScriptMatchingUrl(code, 'https://google.com/')).toBe(false);
    });

    it('should match URL with @include', () => {
        const code = `
// ==UserScript==
// @name Test
// @include *://example.com/*
// ==/UserScript==
        `;
        expect(isScriptMatchingUrl(code, 'https://example.com/foo')).toBe(true);
    });

    it('should exclude URL with @exclude', () => {
        const code = `
// ==UserScript==
// @name Test
// @match *://example.com/*
// @exclude *://example.com/admin/*
// ==/UserScript==
        `;
        expect(isScriptMatchingUrl(code, 'https://example.com/foo')).toBe(true);
        // This is the bug fix verification:
        expect(isScriptMatchingUrl(code, 'https://example.com/admin/settings')).toBe(false);
    });

    it('should match all URLs if no match/include is provided', () => {
        const code = `
// ==UserScript==
// @name Test
// ==/UserScript==
        `;
        expect(isScriptMatchingUrl(code, 'https://example.com/')).toBe(true);
        expect(isScriptMatchingUrl(code, 'https://google.com/')).toBe(true);
    });

    it('should exclude URLs even if no match/include is provided', () => {
        const code = `
// ==UserScript==
// @name Test
// @exclude *://example.com/*
// ==/UserScript==
        `;
        expect(isScriptMatchingUrl(code, 'https://google.com/')).toBe(true);
        expect(isScriptMatchingUrl(code, 'https://example.com/foo')).toBe(false);
    });

    it('matches a URL with a port, query, and wildcard subdomain', () => {
        const code = `// ==UserScript==
// @match *://*.example.com/path*
// ==/UserScript==`;
        expect(isScriptMatchingUrl(code, 'https://example.com:8443/path?q=1')).toBe(true);
        expect(isScriptMatchingUrl(code, 'http://sub.example.com:3000/path')).toBe(true);
        expect(isScriptMatchingUrl(code, 'https://badexample.com/path')).toBe(false);
        expect(isScriptMatchingUrl(code, 'ftp://example.com/path')).toBe(false);
    });

    it('matches localhost with a port and applies exclusions', () => {
        const code = `// ==UserScript==
// @match http://localhost/*
// @exclude http://localhost/private/*
// ==/UserScript==`;
        expect(isScriptMatchingUrl(code, 'http://localhost:5173/public/')).toBe(true);
        expect(isScriptMatchingUrl(code, 'http://localhost:5173/private/a')).toBe(false);
    });

    it('matches a path and query without treating a fragment as part of the URL', () => {
        const code = `// ==UserScript==
// @match https://example.com/app?mode=*
// ==/UserScript==`;
        expect(isScriptMatchingUrl(code, 'https://example.com/app?mode=edit#section')).toBe(true);
        expect(isScriptMatchingUrl(code, 'https://example.com/app?other=edit')).toBe(false);
    });
});
