import type { Script } from '../shared/types';
import { parseMetadata } from '../utils/metadataParser';

export function confirmScriptUpdate(script: Script, previous: Script): Promise<void> {
    return new Promise((resolve, reject) => {
        const ja = document.documentElement.lang === 'ja';
        const dialog = document.createElement('dialog');
        dialog.className = 'permission-dialog';
        const heading = document.createElement('h2');
        heading.textContent = ja ? 'スクリプトの更新を確認' : 'Review script update';
        const name = document.createElement('strong'); name.textContent = script.name;
        const note = document.createElement('p');
        note.textContent = ja ? '同じ名前・名前空間のスクリプトがあります。内容を確認して更新してください。保存データとフォルダーは保持されます。' : 'A script with this name and namespace exists. Review the code before updating. Saved data and folders will be kept.';
        dialog.append(heading, name, note);
        for (const [label, value] of [[ja ? '現在のコード' : 'Current code', previous], [ja ? '新しいコード' : 'New code', script]] as const) {
            const details = document.createElement('details'); details.open = true;
            const summary = document.createElement('summary'); summary.textContent = `${label} (${parseMetadata(value.code).version || '-'})`;
            const code = document.createElement('pre'); code.textContent = value.code;
            code.style.cssText = 'max-height:28dvh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px';
            details.append(summary, code); dialog.append(details);
        }
        const actions = document.createElement('div'); actions.className = 'permission-dialog-actions';
        const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = ja ? 'キャンセル' : 'Cancel';
        const update = document.createElement('button'); update.className = 'btn-primary'; update.textContent = ja ? '更新する' : 'Update';
        let settled = false;
        const finish = (allowed: boolean) => {
            if (settled) return; settled = true; dialog.close(); dialog.remove();
            if (allowed) resolve(); else reject(new DOMException('Operation cancelled.', 'AbortError'));
        };
        cancel.onclick = () => finish(false); update.onclick = () => finish(true);
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
        actions.append(cancel, update); dialog.append(actions); document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
}
