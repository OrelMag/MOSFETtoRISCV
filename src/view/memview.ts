// A memory's words as a live grid (one row per word, one cell per bit up to 16 bits, hex beside), the word being read
// and the word the next rising edge writes highlighted. Shared by the scenes' Memory contents panel (widgets/memgrid.ts),
// the sandbox's Memory drawer (editor/memdrawer.ts) and the RAM part's properties (editor/memui.ts). Past 64 words only
// the rows in view are built (editor/vlist.ts).

import { virtualRows, type VirtualRows } from '../editor/vlist';
import type { Sim } from '../sim/sim';
import { B0, B1 } from '../sim/types';
import { h } from '../ui/dom';
import { type MemInfo, memMarks, noStorage, rowLabel, wordBits } from './memfind';

/** Up to this width a row shows its bits as cells. */
export const CELL_BITS = 16;

/** Hex of a word, a nibble with an unknown bit as x (exact at any width). */
export function hexOf(bits: ArrayLike<number>): string {
  let s = '';
  for (let i = Math.ceil(bits.length / 4) - 1; i >= 0; i--) {
    let v = 0, x = false;
    for (let b = 0; b < 4 && 4 * i + b < bits.length; b++) {
      const bit = bits[4 * i + b];
      if (bit === B1) v |= 1 << b;
      else if (bit !== B0) x = true;
    }
    s += x ? 'x' : v.toString(16).toUpperCase();
  }
  return s;
}

/** One row: address, the bits as cells (LSB right), hex; `bits` null for an address with no storage (x0). */
export function memRow(label: string, bits: ArrayLike<number> | null, width: number, o: { cls?: string; tip?: string; cells?: boolean; prefix?: string; mark?: string } = {}): HTMLElement {
  const cells = o.cells ?? width <= CELL_BITS;
  const row = h('div', { class: `row${o.cls ? ` ${o.cls}` : ''}${bits ? '' : ' none'}`, title: o.tip ?? '' }, h('span', { class: 'addr' }, label));
  if (cells) {
    const c = h('span', { class: 'cells' });
    for (let b = width - 1; b >= 0; b--) c.append(h('span', { class: `cell${bits?.[b] === B1 ? ' one' : bits && bits[b] !== B0 ? ' x' : ''}` }));
    row.append(c);
  }
  row.append(h('span', { class: 'hex' }, bits ? `${o.prefix ?? '0x'}${hexOf(bits)}` : '—'));
  if (o.mark !== undefined) row.append(h('span', { class: 'mark' }, o.mark));
  return row;
}

export interface MemGrid {
  el: HTMLElement;
  /** Show this memory of this simulation (null: nothing). */
  show(sim: Sim | null, m: MemInfo | null): void;
  /** Re-read the words and marks. */
  refresh(): void;
  /** Scroll word i into view. */
  reveal(i: number): void;
}

/** Rows up to this many are all built; more go through virtualRows (the grid then scrolls by itself). */
const ALL_ROWS = 64;

/**
 * A grid over one memory. `scroll`: the grid is its own scroll box (a fixed height: the drawer), else it grows and its
 * container scrolls (the scene panel); a memory past ALL_ROWS words always scrolls by itself.
 */
export function memGrid(o: { scroll?: boolean } = {}): MemGrid {
  const el = h('div', { class: 'memgrid' });
  let sim: Sim | null = null, mem: MemInfo | null = null;
  let virt: VirtualRows | null = null;
  let read: number[] = [], write: number[] = [];
  const row = (i: number) => {
    const m = mem!;
    const none = noStorage(m, i);
    const w = write.includes(i), r = read.includes(i);
    const name = m.built?.names.get(i);
    const tip = w ? 'will be written on the next rising clock edge' : r ? 'being read'
      : none ? (m.prefix === 'x' && i === 0 ? 'x0: hard-wired to zero, no storage' : 'no word at this address') : '';
    return memRow(rowLabel(m, i), none ? null : wordBits(sim!, m, i), m.width, {
      cls: w ? 'write' : r ? 'read' : '', tip, mark: m.built ? (name ?? '') : undefined,
    });
  };
  const refresh = () => {
    if (!sim || !mem) return void el.replaceChildren();
    ({ read, write } = memMarks(sim, mem));
    if (virt) virt.refresh();
    else el.replaceChildren(...Array.from({ length: mem.words }, (_, i) => row(i)));
  };
  return {
    el,
    show(s, m) {
      sim = s;
      if (m !== mem) {
        mem = m;
        virt = null;
        el.replaceChildren();
        el.classList.toggle('scroll', !!o.scroll || (m?.words ?? 0) > ALL_ROWS);
        el.classList.toggle('wide', !!m && m.width > CELL_BITS);
        if (m && m.words > ALL_ROWS) virt = virtualRows({ count: m.words, el, body: el, row, rowH: 17 });
      }
      refresh();
    },
    refresh,
    reveal(i) {
      if (virt) virt.reveal(i);
      else (el.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    },
  };
}
