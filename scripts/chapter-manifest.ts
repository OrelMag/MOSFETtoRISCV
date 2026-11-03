// Writes src/chapters/manifest.ts and loaders.ts from the chapters, and public/chapterindex.json (the search text of every
// step, fetched by the search on first use; generated at build, not checked in).
//   npm run manifest            write all three
//   npm run manifest -- --check fail if manifest.ts / loaders.ts are stale (CI runs the same comparison as a test)
//   npm run manifest -- --index write only public/chapterindex.json (what npm run build does)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chapters } from '../src/chapters';
import { plainText } from '../src/ui/chapternav';
import { loadersSource, manifestSource, type Locations } from '../src/chapters/manifestgen';

const dir = fileURLToPath(new URL('../src/chapters/', import.meta.url));
const where: Locations = {};
const mods = import.meta.glob('../src/chapters/ch-*.ts', { eager: true }) as Record<string, Record<string, unknown>>;
for (const [path, mod] of Object.entries(mods)) {
  const file = path.split('/').pop()!.replace(/.ts$/, '');
  for (const [name, v] of Object.entries(mod)) {
    const c = chapters.find((x) => x === v);
    if (c) where[c.id] = [file, name];
  }
}
const files: [string, string][] = [['manifest.ts', manifestSource(chapters)], ['loaders.ts', loadersSource(chapters, where)]];
if (process.argv.includes('--check')) {
  const stale = files.filter(([n, text]) => readFileSync(dir + n, 'utf8').replace(/\r\n/g, '\n') !== text);
  if (stale.length) { console.error(`stale: ${stale.map(([n]) => n).join(', ')}; run npm run manifest`); process.exit(1); }
  console.log('chapter manifest is current');
} else {
  if (!process.argv.includes('--index')) for (const [n, text] of files) writeFileSync(dir + n, text);
  const pub = fileURLToPath(new URL('../public/', import.meta.url));
  mkdirSync(pub, { recursive: true });
  const index = { v: 1, text: Object.fromEntries(chapters.map((c) => [c.id, c.steps.map((s) => plainText(s.body))])) };
  writeFileSync(pub + 'chapterindex.json', JSON.stringify(index));
  console.log(`wrote ${process.argv.includes('--index') ? '' : 'manifest.ts, loaders.ts and '}public/chapterindex.json (${chapters.length} chapters)`);
}
