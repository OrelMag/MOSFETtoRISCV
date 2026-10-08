// Copies the built site (../dist) into app/, the folder the desktop program serves, and swaps the
// Google Fonts link for local copies so the program works offline. Run `npm run build` at the root first.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const app = join(here, 'app');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('No ../dist/index.html: run `npm run build` at the repository root first.');
  process.exit(1);
}

rmSync(app, { recursive: true, force: true });
// Source maps are for debugging the site; they would only make the program bigger.
cpSync(dist, app, { recursive: true, filter: (src) => !src.endsWith('.map') });

// The same families and weights as the Google Fonts link in index.html.
const FONTS = [
  ['inter', [400, 500, 600, 700, 800]],
  ['jetbrains-mono', [400, 500, 600, 700]],
];
const fontsDir = join(app, 'fonts');
mkdirSync(fontsDir, { recursive: true });
let css = '';
for (const [pkg, weights] of FONTS) {
  const root = join(here, 'node_modules', '@fontsource', pkg);
  for (const w of weights) {
    // Keep only the woff2 sources (every engine we ship supports it) and copy the files they name.
    const src = readFileSync(join(root, `${w}.css`), 'utf8').replace(/,\s*url\([^)]*\.woff\) format\('woff'\)/g, '');
    for (const [, file] of src.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)) copyFileSync(join(root, 'files', file), join(fontsDir, file));
    css += src.replaceAll('./files/', './') + '\n';
  }
}
writeFileSync(join(fontsDir, 'fonts.css'), css);

const indexPath = join(app, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const google = /\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"[^>]*>\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com"[^>]*>\s*<link href="https:\/\/fonts\.googleapis\.com\/css2[^"]*" rel="stylesheet"\s*\/?>/;
if (!google.test(html)) {
  console.error('index.html: the Google Fonts link was not found; update stage.mjs to match it.');
  process.exit(1);
}
writeFileSync(indexPath, html.replace(google, '\n    <link rel="stylesheet" href="./fonts/fonts.css" />'));
console.log(`Staged ${dist} → ${app} (fonts local)`);
