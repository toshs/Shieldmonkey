import type { Script, Theme } from '../sandbox/options/types';

export interface PopupScript {
    id: string;
    name: string;
    enabled?: boolean;
    hasUpdateUrl: boolean;
}

export interface PopupData {
    theme?: Theme;
    extensionEnabled?: boolean;
    locale?: string;
    currentUrl?: string;
    scripts: PopupScript[];
}

export interface PopupMetadata {
    match: string[];
    include: string[];
    exclude: string[];
    updateURL?: string;
    downloadURL?: string;
    installURL?: string;
    source?: string;
}

// The popup only needs matching rules and update links. Keep this parser small so
// opening the popup does not load the editor's metadata and bridge bundles.
export function readPopupMetadata(code: string): PopupMetadata {
    const metadata: PopupMetadata = { match: [], include: [], exclude: [] };
    const block = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/m)?.[1];
    if (!block) return metadata;
    for (const line of block.split('\n')) {
        const match = line.match(/\/\/\s*@(\w+)(?:\s+(.*))?/);
        if (!match) continue;
        const key = match[1].trim();
        const value = match[2]?.trim() || '';
        if (!value) continue;
        if (key === 'match' || key === 'include' || key === 'exclude') metadata[key].push(value);
        else if (key === 'updateURL' || key === 'downloadURL' || key === 'installURL' || key === 'source') metadata[key] = value;
    }
    return metadata;
}

function matchPattern(pattern: string, url: string): boolean {
    if (pattern === '<all_urls>') return true;
    const regex = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${regex}$`).test(url);
}

export function matchesPopupMetadata(metadata: PopupMetadata, url: string): boolean {
    if (metadata.exclude.some(pattern => matchPattern(pattern, url))) return false;
    const patterns = [...metadata.match, ...metadata.include];
    return (patterns.length ? patterns : ['<all_urls>']).some(pattern => matchPattern(pattern, url));
}

export async function getPopupData(): Promise<PopupData> {
    const [data, tabs] = await Promise.all([
        chrome.storage.local.get(['scripts', 'theme', 'extensionEnabled', 'locale']),
        chrome.tabs.query({ active: true, currentWindow: true })
    ]);
    const url = tabs[0]?.url;
    let currentUrl: string | undefined;
    try {
        if (url && /^https?:$/.test(new URL(url).protocol)) currentUrl = url;
    } catch { /* Ignore invalid tab URLs. */ }
    const scripts: PopupScript[] = [];

    if (currentUrl && Array.isArray(data.scripts)) {
        for (const script of data.scripts as Script[]) {
            const metadata = readPopupMetadata(script.code);
            if (!matchesPopupMetadata(metadata, currentUrl)) continue;
            const links = script as Script & { updateUrl?: string; downloadUrl?: string };
            scripts.push({
                id: script.id,
                name: script.name,
                enabled: script.enabled,
                hasUpdateUrl: !!(links.updateUrl || links.downloadUrl || script.sourceUrl || metadata.updateURL || metadata.downloadURL || metadata.installURL || metadata.source)
            });
        }
    }

    return {
        theme: data.theme === 'light' || data.theme === 'dark' || data.theme === 'system' ? data.theme : undefined,
        extensionEnabled: typeof data.extensionEnabled === 'boolean' ? data.extensionEnabled : undefined,
        locale: typeof data.locale === 'string' ? data.locale : undefined,
        currentUrl,
        scripts
    };
}
