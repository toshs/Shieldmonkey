import { parse } from 'acorn';

// Parse the exact enclosing function with a strict ECMAScript parser. Source
// text must not close it (or the bootstrap) and run before authentication.
export function assertSafeScriptBody(code: string): void {
    const header = 'function __shieldmonkey_user_script__() {\n';
    const source = header + code + '\n}';
    try {
        const program = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
        const declaration = program.body[0];
        if (program.body.length !== 1 || declaration?.type !== 'FunctionDeclaration' ||
            declaration.start !== 0 || declaration.end !== source.length ||
            declaration.body.start !== header.length - 2 || declaration.body.end !== source.length) throw new Error();
    } catch {
        throw new Error('Invalid userscript syntax. The script must be a complete function body.');
    }
}
