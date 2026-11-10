// The campaign's virtual-memory blocks at RV16 scale (act 7, optional levels y_tlb and y_walk): the system CPU's TLB and
// page-table walker (lib/vm.ts) in miniature. A 16-bit virtual address is an 8-bit virtual page number and an 8-bit offset;
// the page number is cut 4 / 4 for two levels of tables of 16 entries, and a table is 16 words at {PPN, 0000}. A page-table
// entry is a 16-bit word: V R W X in bits 0..3, the physical page number in bits 15:8. No superpages, no A / D bits.
// Models in software (Tlb16Model, Walk16Model) are the specification the levels' benches replay. No DOM.

import type { ComponentDef, PortDef } from '../../sim/types';
import { Builder } from '../builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree } from '../combinational';
import { priorityEncoder } from '../coding';
import { define, merger, ones, splitter } from '../define';
import { AND, NOT, OR } from '../gates';
import { laid } from '../layered';
import { DFF, register } from '../sequential';
import { orN } from '../wide';

export const VM16 = { vpnBits: 8, ppnBits: 8, flagBits: 3, entries: 4, pteAddrBits: 12 } as const;

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const andB = (b: Builder, ...x: string[]) => b.op1(x.length === 2 ? AND : andN(x.length), x);
const orB = (b: Builder, ...x: string[]) => b.op1(x.length === 2 ? OR : orN(x.length), x);
const notB = (b: Builder, x: string) => b.op1(NOT, [x]);

/** The TLB's behaviour: four entries, a fill writes the entry the round-robin pointer names and advances it, flush clears the valid bits (the pointer stays). */
export class Tlb16Model {
  vpn = [0, 0, 0, 0];
  ppn = [0, 0, 0, 0];
  flags = [0, 0, 0, 0];
  valid = [false, false, false, false];
  ptr = 0;
  /** The entry holding this page number, or -1. */
  find(key: number): number {
    return this.valid.findIndex((v, i) => v && this.vpn[i] === key);
  }
  /** The clock edge: flush wins over fill. */
  edge(i: { key: number; fill: number; fppn: number; fflags: number; flush: number }): void {
    if (i.fill) {
      this.vpn[this.ptr] = i.key; this.ppn[this.ptr] = i.fppn; this.flags[this.ptr] = i.fflags; this.valid[this.ptr] = true;
      this.ptr = (this.ptr + 1) & 3;
    }
    if (i.flush) this.valid.fill(false);
  }
}

/**
 * A 4-entry fully associative TLB: per entry a register {vpn, ppn, flags} and a valid flip-flop that a flush clears, an
 * equality comparator per entry on the lookup key, a priority encoder and multiplexers that deliver the matching entry's
 * PPN and flags. A fill writes the entry the round-robin pointer names and advances the pointer.
 */
export const TLB16: ComponentDef = (() => {
  const { vpnBits: V, ppnBits: P, flagBits: F, entries: n } = VM16, k = 2, W = V + P + F;
  const b = new Builder(18, 14);
  b.pins('key', 'fill', 'fppn', 'fflags', 'flush', 'clk');
  const ptr = b.op(register(k), ['', 'fill', 'clk'], 'round-robin pointer', 'ptr');
  b.wire(b.op1(incrementer(k), [`${ptr}.q`], '+ 1'), `${ptr}.d`);
  const dec = b.op(decoder(k, true), [`${ptr}.q`, 'fill'], 'entry to write');
  const word = b.name(b.op1(merger([V, P, F]), ['key', 'fppn', 'fflags'], '{vpn, ppn, flags}'), 'word', true);
  const nflush = notB(b, 'flush');
  b.next();
  const ent = Array.from({ length: n }, (_, i) => {
    const q = b.op(register(W), [word, `${dec}.y${i}`, 'clk'], `entry ${i}`, `e${i}`);
    const v = b.op1(register(1), [nflush, orB(b, `${dec}.y${i}`, 'flush'), 'clk'], `valid ${i}`, `v${i}`);
    return { q: `${q}.q`, v };
  });
  b.next();
  const parts = ent.map((e, i) => b.op(splitter([V, P, F]), [e.q], undefined, `p${i}`));
  b.next();
  const hits = ent.map((e, i) => andB(b, b.op1(equal(V), [`${parts[i]}.o0`, 'key'], `= key? ${i}`), e.v));
  b.next();
  const pe = b.op(priorityEncoder(n), [b.op1(merger(ones(n)), hits, 'matches')], 'which matched');
  b.next();
  b.wire(`${pe}.v`, 'hit');
  b.wire(b.op1(muxTree(k, P), [...parts.map((p) => `${p}.o1`), `${pe}.y`], 'PPN'), 'ppn');
  b.wire(b.op1(muxTree(k, F), [...parts.map((p) => `${p}.o2`), `${pe}.y`], 'flags'), 'flags');
  return define({
    id: 'rv16_tlb', name: 'TLB (4 entries, RV16 scale)', category: 'memory',
    summary: 'Four translations kept at once, searched by the 8-bit virtual page number (a comparator per entry): an entry holds the 8-bit physical page number and the flags r, w, x. A fill replaces entries in turn; flush forgets them all. Everything powers on at 0 (no valid entries, pointer at entry 0).',
    ports: [bus('key', V, 'in'), bit('fill', 'in'), bus('fppn', P, 'in'), bus('fflags', F, 'in'), bit('flush', 'in'), bit('clk', 'in', true), bit('hit', 'out'), bus('ppn', P, 'out'), bus('flags', F, 'out')],
    symbol: { kind: 'box', label: 'TLB' },
    netlist: laid(b, { keepOrder: true, room: true }),
  });
})();

/** The walker's behaviour, one clock at a time: states idle 0, level 1 read 1, level 0 read 2, fault 3. */
export class Walk16Model {
  state = 0;
  table = 0;
  /** PTE address the walker presents now (meaningful while it reads: states 1 and 2). */
  addr(root: number, vpn: number): number {
    return (((this.state === 1 ? root : this.table) & 0xff) << 4) | (this.state === 1 ? (vpn >> 4) & 15 : vpn & 15);
  }
  /** Outputs this cycle, given the start request and the PTE the memory returns. */
  out(start: number, pte: number): { stall: number; fill: number; fppn: number; fflags: number; fault: number } {
    const k = this.kind(pte);
    return {
      stall: this.state === 1 || this.state === 2 || (this.state === 0 && start) ? 1 : 0,
      fill: k === 'leaf' ? 1 : 0, fppn: (pte >> 8) & 0xff, fflags: (pte >> 1) & 7, fault: this.state === 3 ? 1 : 0,
    };
  }
  /** What the entry means in this state: a pointer to the next table, a leaf (fill), or a fault. */
  kind(pte: number): 'none' | 'ptr' | 'leaf' | 'fault' {
    if (this.state !== 1 && this.state !== 2) return 'none';
    const v = pte & 1, r = (pte >> 1) & 1, w = (pte >> 2) & 1, x = (pte >> 3) & 1;
    if (!v || (!r && w)) return 'fault';
    const ptr = !r && !x;
    if (this.state === 1) return ptr ? 'ptr' : 'fault';
    return ptr ? 'fault' : 'leaf';
  }
  edge(start: number, pte: number): void {
    const k = this.kind(pte);
    if (this.state === 0) this.state = start ? 1 : 0;
    else if (this.state === 3) this.state = 0;
    else if (k === 'ptr') { this.table = (pte >> 8) & 0xff; this.state = 2; }
    else this.state = k === 'leaf' ? 0 : 3;
  }
}

/**
 * The page-table walker: a state machine that reads page-table entries through a memory port, one level a cycle (idle, level 1,
 * level 0, fault). `start` moves idle to level 1; in a read state `pte` (the memory's word at pteAddr) says what happens: a
 * pointer to the next table (level 1 only), a leaf (level 0 only: `fill` pulses, the TLB takes {fppn, fflags} and the state
 * returns to idle), or a fault (invalid, writable but not readable, a leaf at level 1 or a pointer at level 0), which shows for
 * one cycle in state 11 (`fault`). `stall` is high in the cycle that starts a walk and in both read states.
 */
export const WALK16: ComponentDef = (() => {
  const { vpnBits: V, ppnBits: P, flagBits: F } = VM16;
  const b = new Builder(18, 14);
  b.pins('start', 'root', 'vpn', 'pte', 'clk');
  const s0 = b.op(DFF, ['', 'clk'], 'state bit 0', 's0');
  const s1 = b.op(DFF, ['', 'clk'], 'state bit 1', 's1');
  const tbl = b.op(register(P), ['', '', 'clk'], 'next table (PPN)', 'tbl');
  const S0 = b.name(`${s0}.q`, 'S0', true), S1 = b.name(`${s1}.q`, 'S1', true);
  const n0 = notB(b, S0), n1 = notB(b, S1);
  const idle = b.name(andB(b, n1, n0), 'idle', true);
  const inL1 = b.name(andB(b, n1, S0), 'inL1', true);
  const inL0 = b.name(andB(b, S1, n0), 'inL0', true);
  const inF = andB(b, S1, S0);
  const walk = b.name(orB(b, inL1, inL0), 'walk', true);
  b.next();
  const vs = b.op(splitter([V / 2, V / 2]), ['vpn'], 'vpn0 / vpn1');
  const table = b.name(b.op1(busMux2(P), [`${tbl}.q`, 'root', inL1], 'table'), 'table', true);
  const idx = b.op1(busMux2(V / 2), [`${vs}.o0`, `${vs}.o1`, inL1], 'index');
  b.wire(b.op1(merger([V / 2, P]), [idx, table], 'PTE address'), 'pteAddr');
  const ps = b.op(splitter([1, 1, 1, 1, 4, P]), ['pte'], 'V R W X . PPN');
  const [v, r, w, x] = [0, 1, 2, 3].map((i) => `${ps}.o${i}`);
  const ppn = `${ps}.o5`;
  b.next();
  const bad1 = orB(b, notB(b, v), andB(b, notB(b, r), w));
  const isPtr = andB(b, notB(b, r), notB(b, x));
  const ok = andB(b, walk, notB(b, bad1));
  const ptrOk = b.name(andB(b, ok, inL1, isPtr), 'ptrOk', true);
  const leafOk = b.name(andB(b, ok, inL0, notB(b, isPtr)), 'leafOk', true);
  const faultNow = b.name(andB(b, walk, notB(b, ptrOk), notB(b, leafOk)), 'faultNow', true);
  const go = andB(b, idle, 'start');
  b.wire(orB(b, go, faultNow), `${s0}.d`);
  b.wire(orB(b, ptrOk, faultNow), `${s1}.d`);
  b.wire(ppn, `${tbl}.d`); b.wire(ptrOk, `${tbl}.en`);
  b.next();
  b.wire(ppn, 'fppn');
  b.wire(b.op1(merger(ones(F)), [r, w, x], 'flags'), 'fflags');
  b.wire(leafOk, 'fill');
  b.wire(inF, 'fault');
  b.wire(orB(b, walk, go), 'stall');
  return define({
    id: 'rv16_walker', name: 'Page-table walker (RV16 scale)', category: 'cpu',
    summary: 'Reads two-level page tables through a memory port, one level a cycle (idle, level 1, level 0, fault). A pointer entry sends it down to level 0; a leaf is handed to the TLB (fill); anything else is a page fault. The CPU stalls while it walks.',
    ports: [bit('start', 'in'), bus('root', P, 'in'), bus('vpn', V, 'in'), bus('pte', 16, 'in'), bit('clk', 'in', true),
      bus('pteAddr', VM16.pteAddrBits, 'out'), bit('stall', 'out'), bit('fault', 'out'), bit('fill', 'out'), bus('fppn', P, 'out'), bus('fflags', F, 'out')],
    symbol: { kind: 'box', label: 'WALKER' },
    netlist: laid(b, { keepOrder: true, room: true, gap: 8 }),
  });
})();

