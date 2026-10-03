export interface Script {
    id: string;
    name: string;
    code: string;
    enabled?: boolean;
    lastSavedCode?: string;
    grantedPermissions?: string[];
    sourceUrl?: string;
    referrerUrl?: string;
    namespace?: string;
    installDate?: number;
}

export async function performBackupLegacy(scripts: Script[], version: string): Promise<number> {
    const data = JSON.stringify({
        timestamp: new Date().toISOString(),
        version: version,
        scripts: scripts
    }, null, 2);

    const filename = `shieldmonkey_backup_${new Date().toISOString().slice(0, 10)}.json`;

    try {
        // Use the bridge to handle the actual download since we are in a sandbox
        const { bridge } = await import('../sandbox/bridge/client');
        await bridge.call('DOWNLOAD_JSON', { data, filename });
    } catch (e) {
        // Fallback for non-sandboxed or testing environments if bridge is not available
        console.warn("Bridge download failed, falling back to anchor click", e);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    return scripts.length;
}

export async function performRestoreLegacy(file: File, currentScripts: Script[]): Promise<{ count: number, mergedScripts: Script[] }> {
    const text = await file.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid backup file format.");
    }

    if (!data.scripts || !Array.isArray(data.scripts)) {
        throw new Error("Invalid backup format: No scripts array found.");
    }

    const restoreScripts = data.scripts as Script[];

    const scriptMap = new Map<string, Script>();
    currentScripts.forEach(s => scriptMap.set(s.id, s));

    for (const script of restoreScripts) {
        scriptMap.set(script.id, script);
    }

    const newScripts = Array.from(scriptMap.values());
    return { count: restoreScripts.length, mergedScripts: newScripts };
}
