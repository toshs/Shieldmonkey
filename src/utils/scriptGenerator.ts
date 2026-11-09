import { assertSafeScriptBody } from '../shared/syntax';
import gmApiImplCode from '../injected/gm_api_impl.js?raw';
export interface GM_ScriptConfig {
    id: string; name: string; version: string; permissions: string[]; namespace?: string; description?: string; token: string;
}
export function getGMAPIScript(config: GM_ScriptConfig, code: string): string {
    assertSafeScriptBody(code);
    const replacements: Record<string, string> = {
        '"__SCRIPT_NAME__"': JSON.stringify(config.name),
        '"__SCRIPT_ID__"': JSON.stringify(config.id),
        '"__SCRIPT_TOKEN__"': JSON.stringify(config.token),
        "'__GRANTED_PERMISSIONS__'": JSON.stringify(JSON.stringify(config.permissions)),
        "'__SCRIPT_OBJ__'": JSON.stringify(JSON.stringify({ name: config.name, version: config.version, namespace: config.namespace || '', description: config.description || '' })),
        '"__USER_SCRIPT_BODY__";': code,
    };
    return gmApiImplCode.replace(/"__SCRIPT_NAME__"|"__SCRIPT_ID__"|"__SCRIPT_TOKEN__"|'__GRANTED_PERMISSIONS__'|'__SCRIPT_OBJ__'|"__USER_SCRIPT_BODY__";/g, value => replacements[value]);
}
