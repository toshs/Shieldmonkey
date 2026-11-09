import { needsApproval, requestedGrants, scopeFor, SUPPORTED_GRANTS } from '../shared/policy';
import type { Script } from '../shared/types';

let queue: Promise<unknown> = Promise.resolve();
export function confirmApproval(script: Script, previous?: Script): Promise<boolean> {
    if (!needsApproval(script, previous)) return Promise.resolve(false);
    const next = queue.then(() => showApproval(script));
    queue = next.catch(() => {});
    return next.then(accepted => {
        if (!accepted) throw new DOMException('Operation cancelled.', 'AbortError');
        return true;
    });
}
function showApproval(script: Script): Promise<boolean> {
    return new Promise(resolve => {
        const ja = document.documentElement.lang === 'ja';
        const dialog = document.createElement('dialog');
        dialog.className = 'permission-dialog';
        const title = document.createElement('h2'); title.textContent = ja ? 'スクリプトの権限を確認' : 'Review script permissions';
        const name = document.createElement('strong'); name.textContent = script.name;
        const scope = scopeFor(script.code);
        const section = (heading: string, lines: string[]) => {
            const label = document.createElement('h3'); label.textContent = heading;
            const list = document.createElement('ul');
            for (const line of lines) { const item = document.createElement('li'); item.textContent = line; list.append(item); }
            dialog.append(label, list);
        };
        dialog.append(title, name);
        section(ja ? '動作するサイト' : 'Sites', [...scope.match, ...scope.include].length ? [...scope.match, ...scope.include] : ['<all_urls>']);
        if (scope.exclude.length) section(ja ? '除外するサイト' : 'Excluded sites', scope.exclude);
        const grants = requestedGrants(script.code);
        section(ja ? '要求する GM API' : 'Requested GM APIs', grants.length ? grants.map(grant => SUPPORTED_GRANTS.has(grant) ? grant : `${grant} (${ja ? '非対応・許可されません' : 'unsupported; unavailable'})`) : [ja ? 'なし' : 'None']);
        const note = document.createElement('p'); note.textContent = ja ? '信頼するスクリプトだけを許可してください。Web ページ自体へのアクセスも可能になります。' : 'Only approve scripts you trust. A script can access the pages listed above.';
        dialog.append(note);
        const buttons = document.createElement('div'); buttons.className = 'permission-dialog-actions';
        const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = ja ? 'キャンセル' : 'Cancel';
        const allow = document.createElement('button'); allow.className = 'btn-primary'; allow.textContent = ja ? '許可する' : 'Allow';
        let settled = false;
        const finish = (accepted: boolean) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(accepted); };
        cancel.onclick = () => finish(false); allow.onclick = () => finish(true);
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
        buttons.append(cancel, allow); dialog.append(buttons); document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
}
