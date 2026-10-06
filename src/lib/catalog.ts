// The component library as the workbench (and the sandbox palette) lists it: categories in
// reading order, each with its single components and its parameter families.

import type { Category } from '../sim/types';
import { registry } from './index';
import { families, familyOf, initialParams } from './resolve';

export const CATS: [Category, string][] = [
  ['transistor', 'Transistors'], ['cell', 'CMOS cells'], ['gate', 'Gates'], ['arithmetic', 'Arithmetic'],
  ['routing', 'Selection & routing'], ['sequential', 'Sequential'], ['memory', 'Memory'], ['cpu', 'Processor parts'],
  ['plumbing', 'Wiring & constants'], ['custom', 'My chips'],
];

// Single (non-family) components whose id contains a digit. Other ids with digits are generated
// widths (families, or internal parts such as the 33-bit rows of MUL32) and stay out of the list.
const FIXED = new Set(['nmos', 'pmos', 'nand3', 'cla4', 'mul32', 'sram6t', 'sramcol2', 'dram1t1c', 'arb2', 'btb16', 'fpu32', 'freectr32', 'plus4', 'plus4ks']);
export const listed = (id: string) => FIXED.has(id) || (!/\d/.test(id.replace(/^(full_adder|half_adder)/, '')) && !id.startsWith('bench_') && !id.startsWith('pipe_'));

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
