// The component library as the workbench (and the sandbox palette) lists it: categories in
// reading order, each with its single components and its parameter families.

import type { Category } from '../sim/types';
import { registry } from './index';
import { families, familyOf, initialParams } from './resolve';

export const CATS: [Category, string][] = [
  ['transistor', 'Transistors'], ['cell', 'CMOS cells'], ['gate', 'Gates'], ['arithmetic', 'Arithmetic'],
  ['routing', 'Selection & routing'], ['sequential', 'Sequential'], ['memory', 'Memory'], ['cpu', 'Processor parts'],
  ['ttl', '74xx chips'], ['plumbing', 'Wiring & constants'], ['custom', 'My chips'],
];

// Single (non-family) components whose id contains a digit. Other ids with digits are generated
// widths (families, or internal parts such as the 33-bit rows of MUL32) and stay out of the list.
const FIXED = new Set(['m6502_core', 'nmos', 'pmos', 'nand3', 'cla4', 'mul32', 'sram6t', 'sramcol2', 'dram1t1c', 'arb2', 'btb16', 'fpu32', 'freectr32', 'plus4', 'plus4ks']);
export const listed = (id: string) => FIXED.has(id) || /^(ls\d+|ne555)$/.test(id) || (!/\d/.test(id.replace(/^(full_adder|half_adder)/, '')) && !id.startsWith('bench_') && !id.startsWith('pipe_'));

export interface LibraryItem {
  id: string;
  name: string;
  /** A parameter family: `id` is its member with the initial parameters. */
  family?: boolean;
}

/** Every listed component and family, by category (empty categories left out). */
export function libraryItems(): { cat: string; title: string; items: LibraryItem[] }[] {
  const statics = [...registry.values()].filter((d) => d.prim !== 'alias' && listed(d.id) && !familyOf(d.id));
  const out: { cat: string; title: string; items: LibraryItem[] }[] = [];
  for (const [cat, title] of CATS) {
    const items: LibraryItem[] = [];
    for (const d of statics) if (d.category === cat) items.push({ id: d.id, name: d.name });
    for (const f of families) if (f.category === cat) items.push({ id: f.key(initialParams(f)), name: f.name, family: true });
    if (items.length) out.push({ cat, title, items });
  }
  return out;
}

/** Edit distance (insert / delete / substitute), for "did you mean" on a mistyped id. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Listed components closest to `query` (an unknown workbench id): names or ids containing it first,
 *  then ids a few edits away. */
export function suggestItems(query: string, max = 6): LibraryItem[] {
  const q = query.toLowerCase().replace(/[\s-]+/g, '_');
  if (!q) return [];
  const words = q.split('_').filter(Boolean);
  const scored: [number, LibraryItem][] = [];
  for (const { items } of libraryItems()) {
    for (const it of items) {
      const id = it.id.toLowerCase(), name = it.name.toLowerCase();
      const initials = name.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join('');
      let score: number;
      if (id === q) score = 0;
      else if (id.startsWith(q) || name.startsWith(q.replace(/_/g, ' ')) || initials === q) score = 1;
      else if (id.includes(q) || words.every((w) => name.includes(w))) score = 2;
      else {
        // A family's id carries its parameters (alu8, rf8x32): compare without the digits too.
        const bare = (s: string) => s.replace(/\d+(x\d+)*/g, '');
        const d = Math.min(editDistance(q, id), editDistance(bare(q), bare(id)) + 1,
          ...name.split(/[^a-z0-9]+/).filter((w) => w.length > 2).map((w) => editDistance(bare(q), w) + 1));
        if (d > Math.max(1, Math.floor(q.length / 3))) continue;
        score = 3 + d;
      }
      scored.push([score, it]);
    }
  }
  return scored.sort((x, y) => x[0] - y[0] || x[1].name.length - y[1].name.length).slice(0, max).map(([, it]) => it);
}
