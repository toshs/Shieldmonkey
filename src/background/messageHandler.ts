import { handleSaveScript, handleToggleScript, handleToggleGlobal, handleDeleteScript, reloadAllScripts, handleApplyLibrary, handleImportScripts, handleExportBackup } from './scripts';
import { stateReady } from './state';

export function trustedUiSender(sender: chrome.runtime.MessageSender): boolean {
    if (sender.id !== chrome.runtime.id || !sender.url || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
    try {
        const url = new URL(sender.url);
        const base = new URL(chrome.runtime.getURL(''));
        return url.protocol === base.protocol && url.host === base.host &&
            ['src/options/index.html', 'src/popup/index.html', 'popup.html'].includes(url.pathname.replace(/^\//, ''));
    } catch { return false; }
}
export function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (!trustedUiSender(sender)) { sendResponse({ success: false, error: 'Untrusted command sender.' }); return; }
        const request = message as Record<string, unknown>;
        void (async () => {
            await stateReady;
            switch (request.type) {
                case 'IMPORT_SCRIPTS':
                    if (typeof request.expectedRevision !== 'string') throw new Error('Missing library revision.');
                    await handleImportScripts(request.scripts, request.approvedIds, request.expectedRevision); break;
                case 'SAVE_SCRIPT': await handleSaveScript(request.script, request.approved === true, typeof request.expectedCode === 'string' ? request.expectedCode : undefined); break;
                case 'TOGGLE_SCRIPT':
                    if (typeof request.scriptId !== 'string' || typeof request.enabled !== 'boolean') throw new Error('Invalid toggle.');
                    await handleToggleScript(request.scriptId, request.enabled, request.approved === true, typeof request.expectedRevision === 'string' ? request.expectedRevision : undefined); break;
                case 'TOGGLE_GLOBAL':
                    if (typeof request.enabled !== 'boolean') throw new Error('Invalid toggle.');
                    await handleToggleGlobal(request.enabled); break;
                case 'DELETE_SCRIPT':
                    if (typeof request.scriptId !== 'string') throw new Error('Invalid script ID.');
                    await handleDeleteScript(request.scriptId); break;
                case 'APPLY_LIBRARY':
                    if (typeof request.expectedRevision !== 'string') throw new Error('Missing library revision.');
                    await handleApplyLibrary(request.scripts, request.folders, request.restoring === true, request.expectedRevision, request.gmValues !== undefined ? { values: request.gmValues, revision: String(request.valueRevision ?? '') } : undefined); break;
                case 'CREATE_BACKUP': return handleExportBackup(request.includeValues === true);
                case 'RELOAD_SCRIPTS': await reloadAllScripts(); break;
                default: throw new Error('Unsupported command.');
            }
        })().then(result => sendResponse({ success: true, result })).catch((error: unknown) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
        return true;
    });
}
