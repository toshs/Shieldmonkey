import { parseMetadata, type Metadata } from './metadataParser';
import { matchPattern, matchScriptGlob } from './urlMatcher';

/**
 * Checks if a script should run on a specific URL based on its metadata (match, include, exclude).
 * Rules:
 * 1. If URL matches any @exclude rule, it returns false.
 * 2. If URL matches any @match or @include rule, it returns true.
 * 3. If no @match or @include are specified, it defaults to <all_urls> (returns true unless excluded).
 */
export function isScriptMatchingUrl(scriptCode: string, url: string): boolean {
    return isMetadataMatchingUrl(parseMetadata(scriptCode), url);
}

export function isMetadataMatchingUrl(metadata: Metadata, url: string): boolean {
    if (metadata.exclude.some(pattern => matchScriptGlob(pattern, url))) return false;
    if (metadata.match.length === 0 && metadata.include.length === 0) return matchPattern('<all_urls>', url);
    return metadata.match.some(pattern => matchPattern(pattern, url)) ||
        metadata.include.some(pattern => matchScriptGlob(pattern, url));
}
