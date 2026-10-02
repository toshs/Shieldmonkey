import popupCss from './App.css?inline';
import { popupTexts } from './messages';
import { getPopupData, type PopupScript } from './data';
import type { Theme } from '../sandbox/options/types';

const stylesheet = document.createElement('style');
stylesheet.textContent = popupCss;
document.head.append(stylesheet);

const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
document.body.style.width = mobile ? `${Math.min(360, (screen.availWidth || screen.width || 360) - 24)}px` : '420px';
document.body.style.height = mobile ? `${Math.min(400, screen.availHeight || screen.height || 400)}px` : '600px';

const root = document.getElementById('root')!;
const paths = {
    settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8"/><path d="M12 2l1 2.7 2.8.5 2.2-1.8 2 2-1.8 2.2.5 2.8 2.7 1v2.8l-2.7 1-.5 2.8 1.8 2.2-2 2-2.2-1.8-2.8.5-1 2.7h-2.8l-1-2.7-2.8-.5-2.2 1.8-2-2 1.8-2.2-.5-2.8-2.7-1v-2.8l2.7-1 .5-2.8L3.3 5.4l2-2 2.2 1.8 2.8-.5L11.3 2z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    moon: '<path d="M20.985 12.486A9 9 0 0 1 11.514 3.015a9 9 0 1 0 9.47 9.47z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8m-8 4h8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9M4 16.5V20h3.5L19 8.5l-3.5-3.5L4 16.5zM14 6.5l3.5 3.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8m0-5v5h5M4 13a8 8 0 0 0 14.5 4.5L20 16m0 5v-5h-5"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7"/>'
} as const;
type Icon = keyof typeof paths;

let theme: Theme = 'dark';
let locale = 'system';
let extensionEnabled = true;
let currentUrl = '';
let scripts: PopupScript[] = [];
let query = '';
let loaded = false;
let loadFailed = false;

function t(key: string, substitutions: string[] = []): string {
    const language = locale === 'system' ? (navigator.language.startsWith('ja') ? 'ja' : 'en') : locale;
    const table = popupTexts[language === 'ja' ? 'ja' : 'en'];
    let value = table[key] || popupTexts.en[key] || key;
    substitutions.forEach((text, index) => { value = value.replaceAll(`$${index + 1}`, text); });
    return value;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
}

function icon(name: Icon, size = 20): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = paths[name];
    return svg;
}

function iconButton(name: Icon, label: string, action: () => void): HTMLButtonElement {
    const button = el('button', 'icon-btn');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(icon(name));
    button.addEventListener('click', action);
    return button;
}

function switchControl(checked: boolean, label: string, onChange: (value: boolean) => void): HTMLLabelElement {
    const wrapper = el('label', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, el('span', 'slider'));
    return wrapper;
}

function applyTheme(): void {
    const actual = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
    document.documentElement.setAttribute('data-theme', actual);
}

function openDashboard(path = ''): void {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html${path}`), active: true });
    window.close();
}

async function sendAction(type: string, payload: Record<string, unknown>): Promise<void> {
    const response = await chrome.runtime.sendMessage({ type, ...payload }) as { success?: boolean; error?: string } | undefined;
    if (!response?.success) throw new Error(response?.error || `${type} failed`);
}

function renderRows(container: HTMLElement): void {
    container.replaceChildren();
    const filtered = scripts.filter(script => script.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    if (filtered.length === 0) {
        container.append(el('p', 'popup-no-results', t('noSearchResults')));
        return;
    }
    for (const script of filtered) {
        const row = el('div', 'script-item-row');
        if (!extensionEnabled) {
            row.style.opacity = '0.6';
            row.style.pointerEvents = 'none';
        }
        const leading = el('div', 'script-leading');
        const name = el('span', 'script-name', script.name);
        name.title = script.name;
        leading.append(switchControl(!!script.enabled, script.name, checked => { void toggleScript(script.id, checked); }), name);
        const actions = el('div', 'script-actions');
        actions.append(iconButton('edit', t('editTooltip'), () => openDashboard(`#/options/scripts/${script.id}`)));
        if (script.hasUpdateUrl) {
            actions.append(iconButton('refresh', t('checkForUpdatesTooltip'), () => {
                void sendAction('START_UPDATE_FLOW', { scriptId: script.id }).catch(console.error);
            }));
        }
        const remove = iconButton('trash', t('deleteTooltip'), () => { void deleteScript(script.id, script.name); });
        remove.style.color = '#ef4444';
        actions.append(remove);
        row.append(leading, actions);
        container.append(row);
    }
}

function renderContent(main: HTMLElement): void {
    main.replaceChildren();
    if (!loaded) {
        main.append(el('div', 'empty-state', '…'));
    } else if (loadFailed) {
        main.append(el('div', 'empty-state', t('popupLoadError')));
    } else if (scripts.length > 0) {
        if (scripts.length > 5) {
            const search = el('input', 'popup-search');
            search.type = 'search';
            search.value = query;
            search.placeholder = t('searchScripts');
            search.setAttribute('aria-label', t('searchScripts'));
            main.append(search);
            search.addEventListener('input', () => {
                query = search.value;
                renderRows(rows);
            });
        }
        const list = el('div', 'script-list');
        list.append(el('h2', 'list-title', t('scriptsOnThisPage')));
        const rows = el('div');
        renderRows(rows);
        list.append(rows);
        main.append(list);
    } else {
        const empty = el('div', 'empty-state');
        empty.append(icon('file', 48), el('p', '', t('noScriptsMatching')));
        if (currentUrl) empty.append(el('p', 'text-xs text-gray-500 mt-2 truncate max-w-200', currentUrl));
        main.append(empty);
    }
    const footer = el('div', 'popup-footer');
    const create = el('button', 'new-script-btn');
    create.type = 'button';
    create.append(icon('plus', 16), document.createTextNode(t('createNewScript')));
    create.addEventListener('click', () => openDashboard(currentUrl
        ? `?match=${encodeURIComponent(currentUrl)}#/options/new`
        : '#/options/new'));
    footer.append(create);
    main.append(footer);
}

function render(): void {
    applyTheme();
    const container = el('div', 'popup-container');
    const header = el('header', 'popup-header');
    const logo = el('div', 'logo-area');
    const image = el('img', 'logo-img');
    image.src = '/icons/icon48.png';
    image.alt = '';
    const global = el('div', 'global-switch-container');
    global.append(switchControl(extensionEnabled, t('appName'), checked => { void toggleGlobal(checked); }));
    logo.append(image, el('h1', '', t('appName')), global);
    const tools = el('div', 'popup-tools');
    const themeIcon: Icon = theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor';
    tools.append(
        iconButton(themeIcon, t('themeTooltip', [theme]), () => { void cycleTheme(); }),
        iconButton('settings', t('dashboardTooltip'), () => openDashboard())
    );
    header.append(logo, tools);
    const main = el('main', 'popup-main');
    renderContent(main);
    container.append(header, main);
    root.replaceChildren(container);
}

async function cycleTheme(): Promise<void> {
    const modes: Theme[] = ['light', 'dark', 'system'];
    theme = modes[(modes.indexOf(theme) + 1) % modes.length];
    render();
    await chrome.storage.local.set({ theme });
}

async function toggleGlobal(checked: boolean): Promise<void> {
    const previous = extensionEnabled;
    extensionEnabled = checked;
    render();
    try {
        await sendAction('TOGGLE_GLOBAL', { enabled: checked });
    } catch (error) {
        console.error('Failed to toggle ShieldMonkey', error);
        extensionEnabled = previous;
        render();
    }
}

async function toggleScript(id: string, checked: boolean): Promise<void> {
    const script = scripts.find(item => item.id === id);
    if (!script) return;
    const previous = script.enabled;
    script.enabled = checked;
    render();
    try {
        await sendAction('TOGGLE_SCRIPT', { scriptId: id, enabled: checked });
        const stored = await chrome.storage.local.get('scripts');
        const actual = (stored.scripts as PopupScript[] | undefined)?.find(item => item.id === id);
        if (!!actual?.enabled !== checked) throw new Error('Script state was not saved');
    } catch (error) {
        console.error('Failed to toggle script', error);
        script.enabled = previous;
        render();
    }
}

async function deleteScript(id: string, name: string): Promise<void> {
    if (!confirm(t('confirmDeleteScript', [name]))) return;
    const previous = scripts;
    scripts = scripts.filter(script => script.id !== id);
    render();
    try {
        await sendAction('DELETE_SCRIPT', { scriptId: id });
        const stored = await chrome.storage.local.get('scripts');
        if ((stored.scripts as PopupScript[] | undefined)?.some(item => item.id === id)) throw new Error('Script was not deleted');
    } catch (error) {
        console.error('Failed to delete script', error);
        scripts = previous;
        render();
    }
}

render();
void getPopupData().then(data => {
    theme = data.theme || 'dark';
    locale = data.locale || 'system';
    extensionEnabled = data.extensionEnabled !== false;
    currentUrl = data.currentUrl || '';
    scripts = data.scripts;
    loaded = true;
    render();
}).catch(error => {
    console.error('Failed to load popup data', error);
    loaded = true;
    loadFailed = true;
    render();
});
