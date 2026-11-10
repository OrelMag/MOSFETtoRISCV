// Act 7's optional virtual-memory levels, at RV16 scale (lib/rv16/vm16.ts): a TLB and a page-table walker, each against its
// model in a long sequence. No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { TLB16, Tlb16Model, VM16, WALK16, Walk16Model } from '../lib/rv16/vm16';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';

const pinsOf = (def: ComponentDef): PinSpec[] => def.ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.clock ? { clock: true } : {}) }));

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [{ ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

/**
 * The TLB's test, from Tlb16Model: lookups that miss and are filled the way a walker would, working sets of 3, 4, 5 and 8
 * pages (the fifth page evicts the first, round robin), a flush in the middle, and a fill together with a flush.
 * Everything starts at 0; no page is ever filled twice at once (a fill follows a miss).
 */
export function tlbSeq(): SeqStep[] {
  const r = rng(404);
  const rnd = (n: number) => Math.floor(r() * n);
  const m = new Tlb16Model();
  const st: SeqStep[] = [];
  const idle = { fill: 0, flush: 0, fppn: 0, fflags: 0 };
  const look = (key: number) => {
    const e = m.find(key);
    st.push({ set: { ...idle, key }, expect: e < 0 ? { hit: 0 } : { hit: 1, ppn: m.ppn[e], flags: m.flags[e] } });
  };
  const edge = (i: { key: number; fill: number; fppn: number; fflags: number; flush: number }) => {
    m.edge(i);
    st.push({ set: { ...i }, tick: true, expect: {} });
  };
  /** Look the page up; on a miss fill it with a fresh translation, then look again. */
  const access = (key: number) => {
    look(key);
    if (m.find(key) < 0) {
      const fppn = rnd(256), fflags = 1 + rnd(7);
      edge({ key, fill: 1, fppn, fflags, flush: 0 });
      look(key);
    }
  };
  const flush = (key = 0) => edge({ ...idle, key, flush: 1 });
  look(0); look(0x55); // empty: every lookup misses
  for (const p of [0x12, 0x34, 0x56, 0x78]) access(p); // fill all four
  for (const p of [0x78, 0x12, 0x56, 0x34]) access(p); // all hit
  access(0x9a); // the fifth page evicts the first (0x12)
  look(0x12); look(0x34); look(0x9a);
  access(0x12); // evicts the second (0x34)
  look(0x56); look(0x78);
  flush(0x12);
  for (const p of [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]) look(p); // all forgotten
  access(0xff); access(0x00); // the pointer goes on from where it was; page 0 is a page like any other
  flush(); access(0x00);
  // a fill and a flush on the same edge: the flush wins
  edge({ key: 0x21, fill: 1, fppn: 0x77, fflags: 5, flush: 1, });
  look(0x21);
  for (const ws of [3, 4, 5, 8, 6]) {
    const pages = Array.from({ length: ws }, () => rnd(256));
    const uniq = [...new Set(pages)];
    for (let i = 0; i < 40; i++) access(uniq[rnd(uniq.length)]);
    if (ws === 5) flush(uniq[0]);
  }
  return st;
}

/** The memory image a walk test reads, and the walks asked of it. */
interface Walk { root: number; vpn: number }
function walkWorld() {
  const mem = new Map<number, number>();
  const pte = (ppn: number, f: number) => ((ppn & 0xff) << 8) | (f & 15);
  const V = 1, R = 2, W = 4, X = 8;
  const put = (table: number, i: number, v: number) => mem.set(((table & 0xff) << 4) | (i & 15), v);
  const walks: Walk[] = [];
  const map = (root: number, vpn: number, mid: number, ppn: number, flags: number) => {
    put(root, vpn >> 4, pte(mid, V));
    put(mid, vpn & 15, pte(ppn, flags));
    walks.push({ root, vpn });
  };
  map(0x10, 0x00, 0x20, 0x41, V | R);
  map(0x10, 0x07, 0x20, 0xa5, V | R | W);
  map(0x10, 0x3c, 0x21, 0x5a, V | X);
  map(0x10, 0xf3, 0x22, 0xc3, V | R | W | X);
  map(0x30, 0x07, 0x31, 0x99, V | R); // another root, the same page number
  // faults: an invalid first-level entry, an invalid leaf, a leaf at the first level, a pointer at the last level, write without read
  walks.push({ root: 0x10, vpn: 0x80 });
  put(0x10, 0x5, pte(0x23, V)); walks.push({ root: 0x10, vpn: 0x52 });
  put(0x10, 0x6, pte(0x77, V | R)); walks.push({ root: 0x10, vpn: 0x61 });
  put(0x10, 0x9, pte(0x24, V)); put(0x24, 0x4, pte(0x25, V)); walks.push({ root: 0x10, vpn: 0x94 });
  put(0x10, 0xa, pte(0x26, V)); put(0x26, 0x1, pte(0x66, V | W)); walks.push({ root: 0x10, vpn: 0xa1 });
  put(0x10, 0xb, pte(0x27, V)); put(0x27, 0x2, pte(0x55, R | W | X)); walks.push({ root: 0x10, vpn: 0xb2 }); // V = 0
  put(0x10, 0xc, pte(0x28, 0)); walks.push({ root: 0x10, vpn: 0xc0 }); // V = 0 at the first level
  return { mem, walks };
}

/** The walker's test: cycle by cycle against Walk16Model, the memory answering the address it presents. */
export function walkSeq(): SeqStep[] {
  const r = rng(77);
  const rnd = (n: number) => Math.floor(r() * n);
  const { mem, walks } = walkWorld();
  const m = new Walk16Model();
  const st: SeqStep[] = [];
  let root = 0, vpn = 0;
  const cycle = (start: number) => {
    const walking = m.state === 1 || m.state === 2;
    const addr = m.addr(root, vpn);
    // the memory answers what is at the address; in the other states the word is garbage the walker must ignore
    const pte = walking ? mem.get(addr) ?? 0 : [0xffff, 0x1234, 0xa50f][rnd(3)];
    const o = m.out(start, pte);
    const expect: Record<string, number> = { stall: o.stall, fill: o.fill, fault: o.fault };
    if (walking) expect.pteAddr = addr;
    if (o.fill) { expect.fppn = o.fppn; expect.fflags = o.fflags; }
    st.push({ set: { start, root, vpn, pte }, expect }, { set: {}, tick: true, expect: {} });
    m.edge(start, pte);
    return o;
  };
  const walk = (w: Walk, gap: number) => {
    root = w.root; vpn = w.vpn;
    for (let i = 0; i < gap; i++) cycle(0);
    // start is held while the TLB misses: until the fill, or through the fault cycle
    for (let n = 0; n < 8; n++) {
      const o = cycle(1);
      if (o.fill) break;
      if (o.fault) { cycle(1); break; }
    }
  };
  for (const w of walks) walk(w, 1);
  for (const w of [...walks].reverse()) walk(w, 0); // back to back
  for (let i = 0; i < 24; i++) walk(walks[rnd(walks.length)], rnd(3));
  return st;
}

const WALK_CASES = () => walkSeq().filter((s) => s.tick).length;

export const BUILDVM: Record<string, () => BuildChallenge> = {
  y_tlb: () => ({
    id: 'y_tlb', title: 'A TLB', level: 'cpu', allowed: 'nand',
    brief: `A cache of address translations. <b>Lookup</b> is combinational: <b>key</b> is an ${VM16.vpnBits}-bit virtual page number; if one of the ${VM16.entries} entries holds it, <b>hit</b> = 1 and <b>ppn</b> (${VM16.ppnBits} bits) and <b>flags</b> (${VM16.flagBits} bits: r, w, x) are that entry's; on a miss only <code>hit</code> = 0 is checked. `
      + 'At the clock edge: if <b>fill</b>, the entry the <b>round-robin pointer</b> names takes {key, fppn, fflags} and the pointer advances (0, 1, 2, 3, 0 …); if <b>flush</b>, every entry becomes invalid (a flush wins over a fill on the same edge). '
      + 'Everything powers on at 0: no valid entries, pointer at entry 0. The bench never fills a page that is already in the TLB.',
    ports: pinsOf(TLB16),
    check: { kind: 'sequence', steps: tlbSeq() },
    answer: refOf('y_tlb', () => TLB16, 'TLB'),
  }),
  y_walk: () => ({
    id: 'y_walk', title: 'The page-table walker', level: 'cpu', allowed: 'nand',
    brief: `A 16-bit virtual address is an 8-bit page number and an 8-bit offset; the page number is cut 4 / 4 into <b>vpn1</b> (high) and <b>vpn0</b>. A table is 16 words at address {PPN, 0000}; a page-table entry is a word: V R W X in bits 0 to 3, the physical page number in bits 15:8. The first table's PPN is <b>root</b>. `
      + 'The walker is a state machine: <b>idle</b> until <b>start</b> = 1; then <b>level 1</b>: present <b>pteAddr</b> = {root, vpn1} (12 bits) and read <b>pte</b> (the memory answers in the same cycle); a valid entry with R = X = 0 is a pointer: its PPN is the next table, and <b>level 0</b> reads {table, vpn0}; there a valid entry with R or X is a <b>leaf</b>: pulse <b>fill</b> for one cycle with <b>fppn</b> = its PPN and <b>fflags</b> = {x, w, r}, and return to idle. '
      + 'Anything else is a fault: V = 0; W without R; a leaf at level 1; a pointer at level 0. A fault shows <b>fault</b> = 1 for the one cycle after it was found, then idle. <b>stall</b> = 1 in the cycle that starts a walk (idle and start) and in both read states. start may stay high through the walk, and while idle the memory word is garbage. '
      + `${WALK_CASES()} clock cycles are checked: pteAddr while reading, and stall, fill and fault always.`,
    ports: pinsOf(WALK16),
    check: { kind: 'sequence', steps: walkSeq() },
    answer: refOf('y_walk', () => WALK16, 'Page-table walker'),
  }),
};
