export const GM_PORT = 'shieldmonkey-gm-v1';
export interface GMInit { type: 'INIT'; scriptId: string; token: string }
export interface GMRequest { type: 'REQUEST'; id: number; operation: string; data: Record<string, unknown> }
export type GMClientMessage = GMInit | GMRequest;
export type GMServerMessage =
    | { type: 'READY'; values: Record<string, unknown>; keys: string[]; notifications?: number[] }
    | { type: 'RESPONSE'; id: number; result?: unknown; error?: string }
    | { type: 'VALUE_CHANGED'; key: string; value?: unknown; remote: boolean }
    | { type: 'KEYS_CHANGED'; keys: string[] }
    | { type: 'URL_CHANGED'; url: string }
    | { type: 'NOTIFICATION_EVENT'; callbackId: number; phase: 'click' | 'done'; nonce?: string; clicked?: boolean }
    | { type: 'REVOKED'; error: string };
