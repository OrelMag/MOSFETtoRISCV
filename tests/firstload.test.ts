// The first page must not drag the rest of the site in: everything reachable from src/main.ts by static imports (dynamic import()
// is a chunk of its own) stays within the shell, the outline and the home page. A new static import that pulls in the chapters,
// the component library or a simulator fails here, with the chain that led to it.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
// import / export ... from '...' and bare side-effect imports; `import type` and dynamic import() are not static dependencies at run time
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'"\n;]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null;
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

// One read per file: the registry test below walks the graph from every chapter and page, and re-reading it each time took minutes on a loaded machine.
const imports = new Map<string, string[]>();
function importsOf(f: string): string[] {
  let out = imports.get(f);
  if (!out) {
    out = [];
    for (const m of readFileSync(f, 'utf8').matchAll(STATIC)) {
      const r = resolveSpec(f, m[1]);
      if (r) out.push(r);
    }
    imports.set(f, out);
  }
  return out;
}

/** Every file statically reachable from `entry`, with the file that first imported it. */
function reachable(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const queue: [string, string | null][] = [[entry, null]];
  while (queue.length) {
    const [f, parent] = queue.shift()!;
    if (seen.has(f)) continue;
    seen.set(f, parent);
    if (!f.endsWith('.ts')) continue;
    for (const r of importsOf(f)) queue.push([r, f]);
  }
  return seen;
}

const rel = (f: string) => relative(SRC, f).split(sep).join('/');
const chain = (seen: Map<string, string | null>, f: string) => {
  const out: string[] = [];
  for (let x: string | null = f; x; x = seen.get(x) ?? null) out.push(rel(x));
  return out.join(' <- ');
};

/** What the first page may hold. Everything else is loaded by a route, on a click or on a keystroke. */
const ALLOWED = [
  /^main\.ts$/, /^styles\//, /^ui\//, /^learn\/store\.ts$/, /^widgets\/journey\.ts$/, /^campaign\/twinids\.ts$/,
  /^chapters\/(meta|outline|manifest|load|loaders|checks|firstuse|sections|stepmoves)\.ts$/,
];
// ui/ is allowed as a directory, but not its pages or helpers that bring the heavy parts: those are reached by import() only
const BANNED_UI = [/^ui\/pages\/(chapter|workbench|level|sandbox|campaign|path|start|notes|capstone|verilog|hwstats|benchmarks|ooolab)\.ts$/, /^ui\/(reviewqs|review)\.ts$/];

describe('the first-load path', () => {
  const seen = reachable(join(SRC, 'main.ts'));
  const files = [...seen.keys()];

  it('reaches only the shell, the outline and the home page', () => {
    const bad = files.map(rel).filter((f) => !ALLOWED.some((a) => a.test(f)) || BANNED_UI.some((b) => b.test(f)));
    expect(bad.map((f) => `${f}  (${chain(seen, join(SRC, f))})`)).toEqual([]);
  });

  it('stays small (source bytes of the scripts it reaches)', () => {
    const bytes = files.filter((f) => f.endsWith('.ts')).reduce((n, f) => n + statSync(f).size, 0);
    // about 270 KB now, a third of it the generated outline; the chapters, library and simulators were 4.3 MB of output
    expect(bytes).toBeLessThan(330_000);
  });

  it('loads the route pages and the chapters by import(), not by import', () => {
    const app = readFileSync(join(SRC, 'ui/app.ts'), 'utf8');
    for (const page of ['chapter', 'workbench', 'path', 'campaign', 'sandbox']) expect(app).toMatch(new RegExp(`import\\('\\./pages/${page}'\\)`));
    expect(readFileSync(join(SRC, 'chapters/loaders.ts'), 'utf8')).not.toMatch(/^import .* from '\.\/ch-/m);
  });
});

// The component registry fills as lib modules are imported (lib/define.ts: define()); only lib/index.ts imports them all. A page or chapter that
// reads it (resolve, catalog, usage, hwstats: every part by id, every part that places another) must reach lib/index.ts, or it would
// quietly see a part of the library, which the first-load split makes possible: nothing imports it for the page any more.
describe('the registry on lazy pages', () => {
  const READERS = ['lib/resolve.ts', 'lib/catalog.ts', 'lib/usage.ts', 'lib/hwstats.ts'].map((f) => join(SRC, f));
  const INDEX = join(SRC, 'lib/index.ts');
  const entries = [
    ...readdirSync(join(SRC, 'ui/pages')).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, 'ui/pages', f)),
    ...readdirSync(join(SRC, 'chapters')).filter((f) => /^ch-.*.ts$/.test(f)).map((f) => join(SRC, 'chapters', f)),
  ];

  it('is complete wherever it is read', () => {
    const bad = entries.filter((e) => {
      const seen = reachable(e);
      return READERS.some((r) => seen.has(r)) && !seen.has(INDEX);
    }).map(rel);
    // (view/inspector.ts reads it only after import('../lib'), so the chapter page is not one of these)
    expect(bad).toEqual([]);
  });
});
