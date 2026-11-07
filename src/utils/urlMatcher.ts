
const escapeRegex = (value: string): string => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const globRegex = (value: string): RegExp => new RegExp(`^${escapeRegex(value).replace(/\*/g, '.*')}$`);

/** Match a WebExtension match pattern against a URL, ignoring the URL's port. */
export const matchPattern = (pattern: string, url: string): boolean => {
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return false;
    }

    const scheme = target.protocol.slice(0, -1);
    if (pattern === '<all_urls>') return ['http', 'https', 'file', 'ftp'].includes(scheme);

    const parts = /^(\*|http|https|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!parts) return false;
    const [, expectedScheme, expectedHost, expectedPath] = parts;
    if (expectedScheme === '*' ? !['http', 'https'].includes(scheme) : expectedScheme !== scheme) return false;

    const host = target.hostname.toLowerCase();
    const requestedHost = expectedHost.toLowerCase();
    if (scheme === 'file') {
        if (requestedHost !== '' && requestedHost !== '*') return false;
    } else if (requestedHost !== '*') {
        if (requestedHost.startsWith('*.')) {
            const suffix = requestedHost.slice(2);
            if (host !== suffix && !host.endsWith(`.${suffix}`)) return false;
        } else if (host !== requestedHost) {
            return false;
        }
    }

    return globRegex(expectedPath).test(target.pathname + target.search);
};

/** @include and @exclude can also use userscript globs. */
export const matchScriptGlob = (pattern: string, url: string): boolean => {
    if (pattern === '<all_urls>' || /^(\*|http|https|file|ftp):\/\/[^/]*\/.*$/.test(pattern)) {
        return matchPattern(pattern, url);
    }
    return globRegex(pattern).test(url.split('#', 1)[0]);
};
