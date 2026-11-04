// Writes the sandbox Examples gallery's thumbnails (editor/examplethumb.ts), one SVG per example, into public/examples/ (generated,
// gitignored): `npm run build` runs it before Vite, which copies them next to the site. Needs no browser: the drawing is DOM-free.
import fs from 'node:fs';
import '../src/lib';
import { EXAMPLES } from '../src/editor/examples';
import { exampleThumb } from '../src/editor/examplethumb';

const dir = process.argv[2] ?? 'public/examples';
const t = performance.now();
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
let bytes = 0;
for (const ex of EXAMPLES) {
  const svg = exampleThumb(ex);
  fs.writeFileSync(`${dir}/${ex.id}.svg`, svg);
  bytes += svg.length;
}
console.log(`example thumbnails: ${EXAMPLES.length} in ${((performance.now() - t) / 1000).toFixed(1)} s, ${(bytes / 1024).toFixed(0)} KB → ${dir}`);
