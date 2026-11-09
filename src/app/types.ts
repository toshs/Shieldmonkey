import type { Script, Theme } from '../shared/types';
import type { WorkspaceConflict, WorkspaceHistoryItem, WorkspaceResolution, WorkspaceSnapshot } from '../utils/workspaceManager';

export interface AppActionMap {
    'GET_SETTINGS': {
        payload?: never;
        response: {
            scripts?: Script[];
            scriptFolders?: string[];
            theme?: Theme;
            locale?: string;
            extensionEnabled?: boolean;
            lastBackupTime?: string;
            lastBackupError?: string;
            autoBackup?: boolean;
            autoBackupMode?: 'folder' | 'download';
            workspaceSyncError?: string;
        }
    };
    'GET_LOCALE': { payload?: never; response: string | undefined };
    'UPDATE_THEME': { payload: Theme; response: void };
    'UPDATE_LOCALE': { payload: string; response: void };
    'TOGGLE_GLOBAL': { payload: boolean; response: void };
    'TOGGLE_SCRIPT': { payload: { scriptId: string, enabled: boolean }; response: void };
    'DELETE_SCRIPT': { payload: { scriptId: string }; response: void };
    'SAVE_SCRIPT': { payload: Script; response: void };
    'IMPORT_SCRIPTS': { payload: Script[]; response: void };
    'OPEN_DASHBOARD': { payload?: { path?: string }; response: void };
    'OPEN_URL': { payload: string; response: void };
    'GET_I18N_MESSAGE': { payload: { key: string, substitutions?: string | string[] }; response: string };
    'RELOAD_SCRIPTS': { payload?: never; response: void };
    'IMPORT_FILE': { payload?: never; response: Script[] };
    'IMPORT_DIRECTORY': { payload?: never; response: Script[] };
    'UPDATE_BACKUP_SETTINGS': { payload: { autoBackup?: boolean, autoBackupMode?: 'folder' | 'download', lastBackupTime?: string, lastBackupError?: string | null }; response: void };
    'GET_APP_INFO': { payload?: never; response: { version: string } };
    'UPDATE_SCRIPTS': { payload: Script[]; response: void };
    'RESTORE_SCRIPTS': { payload: Script[]; response: void };
    'UPDATE_LIBRARY': { payload: { scripts: Script[]; folders: string[] }; response: void };
    'SELECT_BACKUP_DIR': { payload?: never; response: string | null };
    'GET_BACKUP_DIR_STATUS': { payload?: never; response: { supported: boolean; name: string | null; permission: PermissionState | null; needsRestore: boolean; syncError: string | null } };
    'REQUEST_BACKUP_DIR_ACCESS': { payload?: never; response: boolean };
    'RUN_BACKUP': { payload: { scripts: Script[], version: string }; response: number };
    'RUN_RESTORE': { payload: { scripts: Script[] }; response: { count: number, mergedScripts: Script[] } };
    'SCAN_WORKSPACE': { payload?: never; response: { conflicts: WorkspaceConflict[]; changed: boolean; count: number } };
    'RESOLVE_WORKSPACE_CONFLICT': { payload: { conflict: WorkspaceConflict; resolution: WorkspaceResolution }; response: { conflicts: WorkspaceConflict[]; changed: boolean; count: number } };
    'LIST_WORKSPACE_HISTORY': { payload?: never; response: WorkspaceHistoryItem[] };
    'READ_WORKSPACE_HISTORY': { payload: { name: string }; response: WorkspaceSnapshot };
    'RESTORE_WORKSPACE_HISTORY': { payload: { name: string; scriptId?: string }; response: number };
    'CHECK_USER_SCRIPTS_PERMISSION': { payload?: never; response: boolean };
    'REQUEST_USER_SCRIPTS_PERMISSION': { payload?: never; response: boolean };
    'OPEN_EXTENSION_SETTINGS': { payload?: never; response: void };
    'CLOSE_TAB': { payload?: never; response: void };
    'DOWNLOAD_JSON': { payload: { data: string, filename: string }; response: boolean };
    'RELOAD_EXTENSION': { payload?: never; response: void };
}

export type ActionType = keyof AppActionMap;

export type TypedAppAction = {
    [K in ActionType]: { type: K; payload: AppActionMap[K]['payload'] }
}[ActionType];
