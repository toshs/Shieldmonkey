export const MessageType = {
    SAVE_SCRIPT: 'SAVE_SCRIPT', TOGGLE_SCRIPT: 'TOGGLE_SCRIPT', TOGGLE_GLOBAL: 'TOGGLE_GLOBAL',
    DELETE_SCRIPT: 'DELETE_SCRIPT', RELOAD_SCRIPTS: 'RELOAD_SCRIPTS', APPLY_LIBRARY: 'APPLY_LIBRARY',
} as const;
export type MessageType = typeof MessageType[keyof typeof MessageType];
