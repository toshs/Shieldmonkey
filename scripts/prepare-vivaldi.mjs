import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const output = 'dist-vivaldi';
const htmlPath = join(output, 'src/popup/index.html');
const manifest = JSON.parse(readFileSync(join(output, '.vite/manifest.json'), 'utf8'));
const popup = manifest['src/popup/index.html'];

// A classic script starts faster in Android Vivaldi. Fail the build if Vite
// starts splitting this entry into modules, which classic scripts cannot load.
if (!popup?.file || popup.imports?.length || popup.dynamicImports?.length) {
    throw new Error('Vivaldi popup must be a self-contained JavaScript entry');
}

const original = `<script type="module" crossorigin src="/${popup.file}"></script>`;
const replacement = `<script defer src="/${popup.file}"></script>`;
const html = readFileSync(htmlPath, 'utf8');
if (html.split(original).length !== 2) {
    throw new Error('Could not find the Vivaldi popup script tag');
}
writeFileSync(htmlPath, html.replace(original, replacement));
