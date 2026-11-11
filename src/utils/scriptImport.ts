import type { Script } from '../shared/types';
import { parseMetadata } from './metadataParser';
const identity = (script: Script) => {
    const metadata = parseMetadata(script.code);
    return JSON.stringify([metadata.namespace || '', metadata.name]);
};
// Identity is an update candidate, never an authorization to overwrite it.
export function planScriptImports(incoming: Script[], current: Script[]): Script[] {
    const seen = new Set<string>();
    return incoming.map(script => {
        const key = identity(script);
        if (seen.has(key)) throw new Error('The selected files contain duplicate @name / @namespace values.');
        seen.add(key);
        const previous = current.find(item => identity(item) === key);
        return previous ? {
            ...script, id: previous.id, enabled: previous.enabled,
            folderPath: previous.folderPath, filePath: previous.filePath,
            installDate: previous.installDate,
        } : script;
    });
}
