// Every host of the zoom lens wires Why? through it (release review M7): a wire clicked inside a box the lens opened is traced
// there, across the box's rim (sim/explain.ts acrossRim, tests/lens-why.test.ts). Look inside in the sandbox built a Lens
// without `events` and a WhyPanel without `lens`, so a click on a wire in an opened box did nothing. The views need a DOM, which
// the tests do not have, so this checks the wiring in the source: each file that makes both passes the two hooks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});

/** The object literal passed to `new <name>({ … })`, by brace matching. */
function argOf(src: string, name: string): string | null {
  const at = src.indexOf(`new ${name}({`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return null;
}

describe('lens hosts', () => {
  const hosts = files(ROOT).map((p) => ({ path: relative(ROOT, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') }))
    .filter((f) => f.src.includes('new Lens({') && f.src.includes('new WhyPanel({'));

  it('are the stage and look inside', () => {
    expect(hosts.map((h) => h.path).sort()).toEqual(['editor/inside.ts', 'view/stage.ts']);
  });

  for (const { path, src } of hosts) {
    it(`${path}: the lens hands Why? its wires, and Why? sees the lens`, () => {
      expect(argOf(src, 'Lens')).toMatch(/\bevents:\s*\(/);
      expect(argOf(src, 'Lens')).toMatch(/lensChanged\(\)/);
      expect(argOf(src, 'WhyPanel')).toMatch(/\blens:\s*\(\)\s*=>/);
    });
  }
});
