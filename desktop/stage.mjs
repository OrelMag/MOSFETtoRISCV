// Copies the built site (../dist) into app/, the folder the desktop program serves. The site carries its own fonts
// (src/styles/fonts), so the program works offline as it is. Run `npm run build` at the root first.
import { cpSync, existsSync, rmSync } from 'node:fs';
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

console.log(`Staged ${dist} → ${app}`);
