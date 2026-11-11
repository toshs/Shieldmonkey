import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const output = 'dist-vivaldi';
const htmlPath = join(output, 'src/popup/index.html');
const manifest = JSON.parse(readFileSync(join(output, '.vite/manifest.json'), 'utf8'));
const popup = manifest['src/popup/index.html'];

// Keep the fast classic entry while sharing matching/security helpers in source.
// Dynamic features do not belong in the popup. Static imports are bundled below.
if (!popup?.file || popup.dynamicImports?.length) {
    throw new Error('Vivaldi popup must be a self-contained JavaScript entry');
}

const original = `<script type="module" crossorigin src="/${popup.file}"></script>`;
const replacement = '<script defer src="/popup.js"></script>';
const html = readFileSync(htmlPath, 'utf8');
if (html.split(original).length !== 2) {
    throw new Error('Could not find the Vivaldi popup script tag');
}

// Android Vivaldi reads unpacked extension files through the document provider.
// Each extra directory adds a noticeable delay, so keep both popup files at the root.
await build({
    configFile: false,
    build: {
        emptyOutDir: false, outDir: resolve(output), sourcemap: false,
        lib: { entry: resolve(output, popup.file), name: 'ShieldMonkeyPopup', formats: ['iife'], fileName: () => 'popup.js' },
    },
});
const preparedHtml = html.replace(original, replacement).replace(/<link rel="modulepreload"[^>]*>/g, '');
writeFileSync(htmlPath, preparedHtml);
writeFileSync(join(output, 'popup.html'), preparedHtml);

const extensionManifestPath = join(output, 'manifest.json');
const extensionManifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8'));
if (extensionManifest.declarative_net_request) {
    throw new Error('Vivaldi must use dynamic rules to avoid generating _metadata');
}
if (extensionManifest.action?.default_popup !== 'src/popup/index.html') {
    throw new Error('Unexpected Vivaldi popup path in manifest');
}
extensionManifest.action.default_popup = 'popup.html';
writeFileSync(extensionManifestPath, JSON.stringify(extensionManifest, null, 2));

// Vivaldi's unpacked loader rejects _locales when default_locale is absent.
rmSync(join(output, '_locales'), { recursive: true, force: true });
rmSync(join(output, '.vite'), { recursive: true, force: true });
