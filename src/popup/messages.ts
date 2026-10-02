// Only the labels used by the popup are bundled here. Keep them in sync with
// public/_locales via popupMessages.test.ts so the popup opens with one small script.
export const popupTexts: Record<'en' | 'ja', Record<string, string>> = {
    en: {
        appName: 'Shieldmonkey',
        scriptsOnThisPage: 'Scripts on this page',
        noScriptsMatching: 'No scripts matching this page.',
        createNewScript: 'Create New Script',
        confirmDeleteScript: 'Are you sure you want to delete script "$1"?',
        themeTooltip: 'Theme: $1',
        dashboardTooltip: 'Dashboard',
        editTooltip: 'Edit',
        checkForUpdatesTooltip: 'Check for updates',
        deleteTooltip: 'Delete',
        searchScripts: 'Search scripts',
        noSearchResults: 'No scripts match these filters.',
        popupLoadError: 'Could not load scripts. Reopen the popup to try again.'
    },
    ja: {
        appName: 'Shieldmonkey',
        scriptsOnThisPage: 'このページのスクリプト',
        noScriptsMatching: 'このページにマッチするスクリプトはありません。',
        createNewScript: '新規スクリプト作成',
        confirmDeleteScript: 'スクリプト「$1」を削除してもよろしいですか？',
        themeTooltip: 'テーマ: $1',
        dashboardTooltip: 'ダッシュボード',
        editTooltip: '編集',
        checkForUpdatesTooltip: '更新を確認',
        deleteTooltip: '削除',
        searchScripts: 'スクリプトを検索',
        noSearchResults: '条件に一致するスクリプトがありません。',
        popupLoadError: 'スクリプトを読み込めませんでした。ポップアップを開き直してください。'
    }
};
