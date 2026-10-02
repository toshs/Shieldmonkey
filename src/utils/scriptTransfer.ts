export function extractUserscript(text: string): string {
    const input = text.trim();
    const fences = [...input.matchAll(/^```[^\r\n]*\r?\n([\s\S]*?)^```[ \t]*$/gm)]
        .map(match => match[1].trim());
    return fences.find(hasUserscriptHeader) || fences[0] || input;
}

export function hasUserscriptHeader(code: string): boolean {
    const trimmed = code.trimStart();
    return /^\/\/\s*==UserScript==[ \t]*\r?\n/.test(trimmed)
        && /^\s*\/\/\s*==\/UserScript==\s*$/m.test(trimmed);
}
