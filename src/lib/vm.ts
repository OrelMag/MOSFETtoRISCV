// The virtual-memory units of the system CPU's vm variant (systemCpu(program, { vm: true }), lib/system.ts): two small
// TLBs, the permission check, the hardware page-table walker and the unit that ties them to the fetch and the data
// access. Everything here is gates; riscv/iss.ts with its `vm` option is the specification and the golden model.
//
// The design rules that keep the gates equal to a golden model that has no TLB:
//   - A TLB entry is made only from a structurally good leaf (valid, readable or executable, aligned, accessed). It holds the
//     raw flags and the 22-bit PPN, and every permission check, and the final "physical address beyond 2^32" access
//     fault, runs on the TLB's output, for a hit and for the retry after a fill alike.
//   - A 4 MiB superpage is split: the entry is made for the one 4 KiB page asked for (its PPN is the leaf's PPN1 with the
//     address's VPN0), so every entry is keyed by the full 20-bit VPN and compares as one.
//   - Walk faults are never cached; a walk that faults leaves both TLBs as they were.
//   - sfence.vma, and any write to satp, clear both TLBs (a hardware choice the specification allows; software still
//     issues sfence.vma after editing a page-table entry, which is the one stale-entry case the golden model has no
//     counterpart for).

import { numOf } from '../chapters/order';
import { nameNets } from './autoname';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { priorityEncoder } from './coding';
import { laid } from './layered';
import { AND, MUX2, NOT, OR, XNOR } from './gates';
import { register } from './sequential';
import { bitwise, orN } from './wide';
import { constWord } from './alu';
import { nonZero } from './pipeline';
import { DFF } from './sequential';
import { NAND, TIE0, TIE1 } from './transistors';


const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Gate helpers on a Builder: each returns the output's driver name. */
const andB = (b: Builder, ...x: string[]) => b.op1(x.length === 2 ? AND : andN(x.length), x);
const orB = (b: Builder, ...x: string[]) => b.op1(x.length === 2 ? OR : orN(x.length), x);
const notB = (b: Builder, x: string) => b.op1(NOT, [x]);

/** Flag bits of a TLB entry. The instruction TLB keeps x and u; the data TLB r, w, x, u and d. */
export const TLB_FLAGS = { i: ['x', 'u'], d: ['r', 'w', 'x', 'u', 'd'] } as const;

/**
 * A 4-entry fully associative TLB keyed by the 20-bit virtual page number: per entry a register holding {vpn, ppn, flags},
 * a valid flip-flop that a flush clears, a comparator and, behind them, a priority encoder and multiplexers that deliver the
 * matching entry's PPN and flags. A fill writes the entry the round-robin pointer names and advances it.
 */
export function tlb(kind: 'i' | 'd', k = 2): ComponentDef {
  const n = 2 ** k;
  return memo(k === 2 ? `tlb_${kind}` : `tlb_${kind}_${n}`, () => {
    const nf = TLB_FLAGS[kind].length, W = 20 + 22 + nf;
    const b = new Builder(18, 14);
    b.pins('key', 'fill', 'fppn', 'fflags', 'flush', 'clk');
    // the write side: a round-robin pointer, a decoder, the word to store
    const ptr = b.op(register(k), ['', 'fill', 'clk'], 'round-robin pointer', 'ptr');
    const inc = b.op1(incrementer(k), [`${ptr}.q`], '+ 1');
    b.wire(inc, `${ptr}.d`);
    const dec = b.op(decoder(k, true), [`${ptr}.q`, 'fill'], 'entry to write');
    const word = b.name(b.op1(merger([20, 22, nf]), ['key', 'fppn', 'fflags'], '{vpn, ppn, flags}'), 'word', true);
    const nflush = b.name(notB(b, 'flush'), 'not flush');
    b.next();
    const ent = Array.from({ length: n }, (_, i) => {
      const q = b.op(register(W), [word, `${dec}.y${i}`, 'clk'], `entry ${i}`, `e${i}`);
      const en = orB(b, `${dec}.y${i}`, 'flush');
      const v = b.op1(register(1), [nflush, en, 'clk'], `valid ${i}`, `v${i}`);
      b.name(v, `valid ${i}`);
      return { q: `${q}.q`, v };
    });
    b.next();
    const parts = ent.map((e, i) => b.op(splitter([20, 22, nf]), [e.q], undefined, `p${i}`));
    b.next();
    const hits = ent.map((e, i) => andB(b, b.op1(equal(20), [`${parts[i]}.o0`, 'key'], `= key? ${i}`), e.v));
    b.next();
    const pe = b.op(priorityEncoder(n), [b.op1(merger(ones(n)), hits, 'matches')], 'which matched');
    b.next();
    b.wire(`${pe}.v`, 'hit');
    b.wire(b.op1(muxTree(k, 22), [...parts.map((p) => `${p}.o1`), `${pe}.y`], 'PPN'), 'ppn');
    b.wire(b.op1(muxTree(k, nf), [...parts.map((p) => `${p}.o2`), `${pe}.y`], 'flags'), 'flags');
    return define({
      id: k === 2 ? `tlb_${kind}` : `tlb_${kind}_${n}`, name: `${kind === 'i' ? 'Instruction' : 'Data'} TLB (${n} entries)`, category: 'memory',
      summary: `${n} translations kept at once, searched by virtual page number (a comparator per entry, like chapter ${numOf('memory')}'s CAM): an entry holds the 22-bit physical page number and the page's flags (${TLB_FLAGS[kind].join(', ')}). A fill replaces entries in turn; flush forgets them all. Superpages are filled one 4 KiB page at a time.`,
      ports: [bus('key', 20, 'in'), bit('fill', 'in'), bus('fppn', 22, 'in'), bus('fflags', nf, 'in'), bit('flush', 'in'), clk(), bit('hit', 'out'), bus('ppn', 22, 'out'), bus('flags', nf, 'out')],
      symbol: { kind: 'box', label: kind === 'i' ? 'I-TLB' : 'D-TLB' },
      // tuned on the 4-entry drawing (the scenes'): two parts moved off the valid bits' and entry 3's wires, the two nets that still
      // ran under a part drawn as pointers (tests/redrawclear-vmunits.test.ts)
      netlist: laid(nameNets(b), { keepOrder: true, room: true, ...(k === 2 ? { nudge: { u8: 2, u10: 4, u17: 2 }, wires: { 'u3.y': false, 'v2.q': false } } : {}) }),
      hdl: {
        verilog: `// ${n} entries, round-robin fill; flush clears every valid bit
for (i = 0; i < ${n}; i++) if (valid[i] && vpn[i] == key) begin hit = 1; ppn = ppn_q[i]; flags = flags_q[i]; end
always_ff @(posedge clk) begin
  if (flush) valid <= '0;
  else if (fill) begin vpn[ptr] <= key; ppn_q[ptr] <= fppn; flags_q[ptr] <= fflags; valid[ptr] <= 1; ptr <= ptr + 1; end
end`,
      },
    });
  });
}

/**
 * The permission check on a TLB hit, from riscv/iss.ts walk(): `fail` is a page fault (flags against the mode and the
 * access; a store also needs D), `acc` an access fault (the checks passed but the physical page lies at or above 2^32).
 * Only meaningful for a translating S or U access (privS = 1: S, 0: U).
 */
export function pcheck(kind: 'i' | 'd'): ComponentDef {
  return memo(`pcheck_${kind}`, () => {
    const nf = TLB_FLAGS[kind].length;
    const b = new Builder(14, 12);
    b.pins('privS', 'flags', 'hi', ...(kind === 'd' ? ['sum', 'mxr', 'store'] : []));
    const sf = b.op(splitter(ones(nf)), ['flags'], 'flags');
    const o = (i: number) => `${sf}.o${i}`;
    const sh = b.op(splitter([1, 1]), ['hi'], 'ppn[21:20]');
    b.next();
    let fail: string;
    if (kind === 'i') {
      // x, u: a user page may only be fetched from U, a supervisor page only from S
      fail = orB(b, notB(b, o(0)), b.op1(XNOR, [o(1), 'privS'], 'page of the other mode?'));
    } else {
      const [r, w, x, u, d] = [0, 1, 2, 3, 4].map(o);
      // a U page is closed to S unless SUM; a non-U page is closed to U
      const nsum = notB(b, 'sum'), nprivS = notB(b, 'privS');
      const ufault = b.op1(MUX2, [nprivS, andB(b, 'privS', nsum), u], 'mode check');
      b.next();
      const loadOk = orB(b, r, andB(b, 'mxr', x));
      const storeBad = orB(b, notB(b, w), notB(b, d));
      const accFail = b.op1(MUX2, [notB(b, loadOk), storeBad, 'store'], 'R / W / X / D');
      fail = orB(b, ufault, accFail);
    }
    b.next();
    b.wire(fail, 'fail');
    b.wire(andB(b, notB(b, fail), orB(b, `${sh}.o0`, `${sh}.o1`)), 'acc');
    return define({
      id: `pcheck_${kind}`, name: `${kind === 'i' ? 'Fetch' : 'Load / store'} permission check`, category: 'cpu',
      summary: kind === 'i'
        ? 'Can this mode fetch from this page? Needs X, and the page must belong to the mode (U pages from U, other pages from S). An allowed fetch whose physical page lies at or above 2^32 is an access fault.'
        : 'Can this mode read or write this page? U pages are closed to S unless SUM, other pages to U; a load needs R (or X with MXR), a store needs W and D. An allowed access beyond physical address 2^32 is an access fault.',
      ports: [bit('privS', 'in'), bus('flags', nf, 'in'), bus('hi', 2, 'in'), ...(kind === 'd' ? [bit('sum', 'in'), bit('mxr', 'in'), bit('store', 'in')] : []), bit('fail', 'out'), bit('acc', 'out')],
      symbol: { kind: 'box', label: 'PERMIT' },
      netlist: laid(b, { keepOrder: true, room: true }),
    });
  });
}


/**
 * The page-table walker: a state machine that reads Sv32 page-table entries through the data memory, one per cycle.
 * States (s1 s0): idle 00, level-1 read 01, level-0 read 10, fault 11. `start` (a TLB missed) moves idle to level 1; in
 * a read state `pte` (the memory's word at pteAddr) says what happens: a pointer to the next table (level 1 only), a good
 * leaf (`fill` pulses: the TLB takes it and the state returns to idle, the access then hits), or a fault, which waits in
 * state 11 for one cycle (`fault`, `faultAcc`: access or page fault) while the CPU takes the trap. `stall` is high in
 * the cycle that starts a walk and in both read states: a walk costs 3 cycles to a 4 KiB leaf, 2 to a superpage.
 */
export function walker(): ComponentDef {
  return memo('walker', () => {
    const b = new Builder(18, 14);
    b.pins('start', 'satpPpn', 'vpn', 'pte', 'clk');
    const s0 = b.op(DFF, ['', 'clk'], 'state bit 0', 's0');
    const s1 = b.op(DFF, ['', 'clk'], 'state bit 1', 's1');
    const tbl = b.op(register(22), ['', '', 'clk'], 'next table (PPN)', 'tbl');
    const acc = b.op(register(1), ['', '', 'clk'], 'access fault?', 'acc');
    const S0 = b.name(`${s0}.q`, 'S0', true), S1 = b.name(`${s1}.q`, 'S1', true);
    const n0 = notB(b, S0), n1 = notB(b, S1);
    const idle = b.name(andB(b, n1, n0), 'idle', true);
    const inL1 = b.name(andB(b, n1, S0), 'inL1', true);
    const inL0 = b.name(andB(b, S1, n0), 'inL0', true);
    const inF = andB(b, S1, S0);
    const walk = b.name(orB(b, inL1, inL0), 'walk', true);
    b.next();
    const vs = b.op(splitter([10, 10]), ['vpn'], 'vpn0 / vpn1');
    // the table being read: satp's root at level 1, the pointer taken at level 1 below it
    const table = b.name(b.op1(busMux2(22), [`${tbl}.q`, 'satpPpn', inL1], 'table'), 'table', true);
    const idx = b.op1(busMux2(10), [`${vs}.o0`, `${vs}.o1`, inL1], 'index');
    const ts = b.op(splitter([20, 1, 1]), [table], 'PPN[19:0], 20, 21');
    b.name(`${ts}.o0`, 'table PPN');
    const t19 = b.op(splitter([19, 1]), [`${ts}.o0`]);
    // a table at or above 2^32 (PPN bits 21, 20) or in I/O space (bit 31 = PPN bit 19) is an access fault
    const addrBad = b.name(orB(b, `${ts}.o1`, `${ts}.o2`, `${t19}.o1`), 'addrBad', true);
    b.wire(b.op1(merger([2, 10, 20]), [b.op1(constWord(2, 0), []), idx, `${ts}.o0`], 'PTE address'), 'pteAddr');
    // the PTE: V R W X U (bit 5 = G) A D, 2 RSW bits, the 22-bit PPN
    const ps = b.op(splitter([1, 1, 1, 1, 1, 1, 1, 1, 2, 22]), ['pte'], 'V R W X U . A D . PPN');
    const [v, r, w, x, u, , a, d] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${ps}.o${i}`);
    const ppn = `${ps}.o9`;
    const pp = b.op(splitter([10, 12]), [ppn], 'PPN0 / PPN[21:10]');
    b.next();
    const bad1 = orB(b, notB(b, v), andB(b, notB(b, r), w));
    const isPtr = andB(b, notB(b, r), notB(b, x));
    const ptrBad = orB(b, inL0, d, a, u);
    const spBad = andB(b, inL1, b.op1(nonZero(10), [`${pp}.o0`], 'PPN0 ≠ 0?'));
    const leafBad = orB(b, spBad, notB(b, a));
    const ok = andB(b, walk, notB(b, addrBad), notB(b, bad1));
    const ptrOk = b.name(andB(b, ok, isPtr, notB(b, ptrBad)), 'ptrOk', true);
    const leafOk = b.name(andB(b, ok, notB(b, isPtr), notB(b, leafBad)), 'leafOk', true);
    const faultNow = b.name(andB(b, walk, notB(b, ptrOk), notB(b, leafOk)), 'faultNow', true);
    const go = andB(b, idle, 'start');
    b.wire(orB(b, go, faultNow), `${s0}.d`);
    b.wire(orB(b, andB(b, inL1, ptrOk), faultNow), `${s1}.d`);
    b.wire(ppn, `${tbl}.d`); b.wire(ptrOk, `${tbl}.en`);
    b.wire(addrBad, `${acc}.d`); b.wire(walk, `${acc}.en`);
    b.next();
    // the fill: a superpage becomes the one 4 KiB page asked for (PPN[21:10] of the leaf, PPN0 from the address)
    const sup = b.op1(merger([10, 12]), [`${vs}.o0`, `${pp}.o1`], 'superpage PPN');
    b.wire(b.op1(busMux2(22), [ppn, sup, inL1], 'PPN to fill'), 'fppn');
    b.wire(b.op1(merger(ones(5)), [r, w, x, u, d], 'flags'), 'fflags');
    b.wire(leafOk, 'fill');
    b.wire(inF, 'fault');
    b.wire(`${acc}.q`, 'faultAcc');
    b.wire(orB(b, walk, go), 'stall');
    b.wire(walk, 'walkOut');
    b.wire(idle, 'idleOut');
    return define({
      id: 'walker', name: 'Page-table walker', category: 'cpu',
      summary: 'Reads Sv32 page-table entries through the data memory, one level a cycle (idle, level 1, level 0, fault). A pointer entry sends it down to level 0; a good leaf is handed to the TLB (a 4 MiB superpage as the one page asked for) and the access retries; anything else is a page fault, or an access fault when a table lies at or above 2^32 or in I/O space. The CPU stalls while it walks.',
      ports: [bit('start', 'in'), bus('satpPpn', 22, 'in'), bus('vpn', 20, 'in'), bus('pte', 32, 'in'), clk(),
        bus('pteAddr', 32, 'out'), bit('walkOut', 'out'), bit('idleOut', 'out'), bit('stall', 'out'), bit('fault', 'out'), bit('faultAcc', 'out'), bit('fill', 'out'), bus('fppn', 22, 'out'), bus('fflags', 5, 'out')],
      symbol: { kind: 'box', label: 'WALKER' },
      // two parts moved off the fault wire, and the level-0 bit that ran under a gate drawn as a pointer (tests/redrawclear-vmunits.test.ts)
      netlist: laid(nameNets(b), { keepOrder: true, room: true, gap: 8, nudge: { u40: -2, u47: -2 }, wires: { 'u10.o0': false } }),
    });
  });
}

/**
 * The memory-management unit: both TLBs, their permission checks and the walker, between the CPU's two addresses (the PC,
 * and a load or store's address) and the memories. M mode, and S / U with satp.MODE = 0, pass addresses through.
 * `fpa` addresses the instruction ROM, `dpa` is the data access's physical address (the I/O decode reads it), `maddr`
 * the data memory's address (the walker's PTE address while it walks). The four fault outputs are the causes 12, 1 (fetch)
 * and 13 / 15, 5 / 7 (load / store, split by the caller); `stall` freezes the CPU while a walk is under way. A data access
 * is looked up only for a legal, aligned load or store whose fetch went through (`memOp`, `bad`), the golden model's order.
 */
export function mmu(): ComponentDef {
  return memo('mmu', () => {
    const b = new Builder(18, 14);
    b.pins('pc', 'va', 'priv', 'sum', 'mxr', 'satpMode', 'satpPpn', 'memOp', 'store', 'bad', 'irqTake', 'pteData', 'flush', 'clk');
    const pv = b.op(splitter([1, 1]), ['priv'], 'priv');
    const privS = `${pv}.o0`;
    const xl = b.name(andB(b, 'satpMode', notB(b, `${pv}.o1`)), 'translating', true);
    const pcs = b.op(splitter([12, 20]), ['pc'], 'pc: offset / vpn');
    const vas = b.op(splitter([12, 20]), ['va'], 'address: offset / vpn');
    b.next();
    const wk = b.op(walker(), ['', '', '', 'pteData', 'clk'], 'walker', 'wk');
    b.name(`${wk}.pteAddr`, 'PTE address'); b.name(`${wk}.stall`, 'stall');
    const itlb = b.op(tlb('i'), [`${pcs}.o1`, '', '', '', 'flush', 'clk'], 'instruction TLB', 'itlb');
    const dtlb = b.op(tlb('d'), [`${vas}.o1`, '', '', '', 'flush', 'clk'], 'data TLB', 'dtlb');
    b.next();
    const ihit = `${itlb}.hit`, dhit = `${dtlb}.hit`;
    const is = b.op(splitter([20, 2]), [`${itlb}.ppn`], 'PPN[19:0] / PPN[21:20]');
    const ds = b.op(splitter([20, 2]), [`${dtlb}.ppn`], 'PPN[19:0] / PPN[21:20]');
    const pci = b.op(pcheck('i'), [privS, `${itlb}.flags`, `${is}.o1`], 'fetch check', 'pci');
    const pcd = b.op(pcheck('d'), [privS, `${dtlb}.flags`, `${ds}.o1`, 'sum', 'mxr', 'store'], 'load / store check', 'pcd');
    b.next();
    const iMiss = b.name(andB(b, xl, notB(b, ihit)), 'iMiss', true);
    const iPerm = andB(b, xl, ihit, `${pci}.fail`), iAcc = andB(b, xl, ihit, `${pci}.acc`);
    const iOk = notB(b, orB(b, iMiss, iPerm, iAcc));
    const dReq = b.name(andB(b, 'memOp', notB(b, 'bad'), iOk), 'dReq', true);
    const dMiss = andB(b, xl, dReq, notB(b, dhit));
    const dPerm = andB(b, xl, dReq, dhit, `${pcd}.fail`), dAcc = andB(b, xl, dReq, dhit, `${pcd}.acc`);
    const start = andB(b, orB(b, iMiss, dMiss), notB(b, 'irqTake'));
    const sideD = b.name(notB(b, iMiss), 'sideD', true);
    b.wire(start, `${wk}.start`);
    b.wire('satpPpn', `${wk}.satpPpn`);
    b.wire(b.op1(busMux2(20), [`${pcs}.o1`, `${vas}.o1`, sideD], 'vpn being walked'), `${wk}.vpn`);
    // the fill goes to the TLB of the side that missed
    const wfill = `${wk}.fill`, wflags = b.op(splitter(ones(5)), [`${wk}.fflags`], 'r w x u d');
    b.wire(andB(b, wfill, iMiss), `${itlb}.fill`);
    b.wire(andB(b, wfill, sideD), `${dtlb}.fill`);
    b.wire(`${wk}.fppn`, `${itlb}.fppn`); b.wire(`${wk}.fppn`, `${dtlb}.fppn`);
    b.wire(`${wk}.fflags`, `${dtlb}.fflags`);
    b.wire(b.op1(merger([1, 1]), [`${wflags}.o2`, `${wflags}.o3`], 'x, u'), `${itlb}.fflags`);
    b.next();
    // physical addresses
    const fpa = b.op1(busMux2(32), ['pc', b.op1(merger([12, 20]), [`${pcs}.o0`, `${is}.o0`]), xl], 'fetch PA');
    const dpa = b.name(b.op1(busMux2(32), ['va', b.op1(merger([12, 20]), [`${vas}.o0`, `${ds}.o0`]), xl], 'data PA'), 'dpa', true);
    b.wire(fpa, 'fpa');
    b.wire(dpa, 'dpa');
    b.wire(b.op1(busMux2(32), [dpa, `${wk}.pteAddr`, `${wk}.walkOut`], 'memory address'), 'maddr');
    // faults: a permission or range failure on a hit, or the walker's, on the side that missed
    const F = `${wk}.fault`, Facc = `${wk}.faultAcc`, nFacc = notB(b, Facc);
    b.wire(orB(b, iPerm, andB(b, F, nFacc, iMiss)), 'fetchPage');
    b.wire(orB(b, iAcc, andB(b, F, Facc, iMiss)), 'fetchAcc');
    b.wire(orB(b, dPerm, andB(b, F, nFacc, sideD)), 'dataPage');
    b.wire(orB(b, dAcc, andB(b, F, Facc, sideD)), 'dataAcc');
    b.wire(`${wk}.stall`, 'stall');
    b.wire(`${wk}.idleOut`, 'idle');
    return define({
      id: 'mmu', name: 'Memory-management unit', category: 'cpu',
      summary: 'Sv32 translation for the fetch and for loads and stores: an instruction TLB and a data TLB (4 entries each), the permission checks, and the page-table walker that fills them on a miss while the CPU stalls. M mode never translates; S and U translate while satp.MODE = 1.',
      ports: [bus('pc', 32, 'in'), bus('va', 32, 'in'), bus('priv', 2, 'in'), bit('sum', 'in'), bit('mxr', 'in'), bit('satpMode', 'in'), bus('satpPpn', 22, 'in'),
        bit('memOp', 'in'), bit('store', 'in'), bit('bad', 'in'), bit('irqTake', 'in'), bus('pteData', 32, 'in'), bit('flush', 'in'), clk(),
        bus('fpa', 32, 'out'), bus('dpa', 32, 'out'), bus('maddr', 32, 'out'), bit('stall', 'out'), bit('idle', 'out'),
        bit('fetchPage', 'out'), bit('fetchAcc', 'out'), bit('dataPage', 'out'), bit('dataAcc', 'out')],
      symbol: { kind: 'box', label: 'MMU' },
      // the walker's table address and stall ran under the PC decoder and two gates: pointers (tests/redrawclear-vmunits.test.ts)
      netlist: laid(nameNets(b), { keepOrder: true, room: true, gap: 10, wires: { 'wk.pteAddr': false, 'wk.stall': false } }),
    });
  });
}

// ---- the CSRs and the trap unit of the vm variant ---------------------------------------------------------------------------

/** The CSRs the vm variant answers, with the read-multiplexer index of each (every CSR that reads zero shares index 18). */
const VM_CSR: [string, number, number][] = [
  ['mstatus', 0x300, 0], ['sstatus', 0x100, 1], ['misa', 0x301, 2], ['mie', 0x304, 3], ['mtvec', 0x305, 4], ['mscratch', 0x340, 5], ['mepc', 0x341, 6],
  ['mcause', 0x342, 7], ['mtval', 0x343, 8], ['mip', 0x344, 9], ['mcycle', 0xb00, 10], ['cycle', 0xc00, 10], ['satp', 0x180, 12], ['stvec', 0x105, 13],
  ['sscratch', 0x140, 14], ['sepc', 0x141, 15], ['scause', 0x142, 16], ['stval', 0x143, 17],
  ['mhartid', 0xf14, 18], ['mvendorid', 0xf11, 18], ['marchid', 0xf12, 18], ['mimpid', 0xf13, 18], ['mstatush', 0x310, 18],
  ['sie', 0x104, 18], ['sip', 0x144, 18], ['medeleg', 0x302, 18], ['mideleg', 0x303, 18], ['mcounteren', 0x306, 18], ['scounteren', 0x106, 18],
];

/**
 * The CSR unit of the vm variant: lib/system.ts's machine-mode registers plus the privilege level, the S-mode registers
 * (sstatus is a view of mstatus; stvec, sscratch, sepc, scause, stval; satp) and the mstatus fields riscv/iss.ts keeps (SIE, SPIE,
 * SPP, MPP as a 2-bit WARL field, SUM, MXR, FS). The privilege level is stored inverted (all-zero power-on = M). A trap enters M
 * with MPP := the old level; `mret` returns to MPP (MPP := U), `sret` to SPP (SPP := U). The address is decoded in three
 * nibbles; CSRs that read zero share one multiplexer input.
 */
export function csrUnitVm(): ComponentDef {
  return memo('csrunit_vm', () => {
    const b = new Builder(18, 14);
    b.pins('addr', 'funct3', 'rs1v', 'zimm5', 'csrWrite', 'trap', 'trapCause', 'trapPC', 'trapVal', 'mret', 'sret', 'mtime', 'mtip', 'meip', 'clk');
    const gnd = b.op1(TIE0, []), vdd = b.op1(TIE1, []);
    const zero = (n: number) => b.op1(constWord(n, 0), []);
    // ---- the address, predecoded in nibbles
    const as = b.op(splitter([4, 4, 4]), ['addr'], 'address nibbles');
    const dLo = b.op(decoder(4), [`${as}.o0`], 'low nibble'), dMid = b.op(decoder(4), [`${as}.o1`], 'middle nibble'), dHi = b.op(decoder(4), [`${as}.o2`], 'high nibble');
    b.next();
    const sel: Record<string, string> = {};
    for (const [n, a] of VM_CSR) sel[n] = b.name(andB(b, `${dHi}.y${(a >> 8) & 15}`, `${dMid}.y${(a >> 4) & 15}`, `${dLo}.y${a & 15}`), `is ${n}`, true);
    const known = orB(b, ...VM_CSR.map(([n]) => sel[n]));
    // the multiplexer index: bit k of the index of the CSR selected
    const idxBits = [0, 1, 2, 3, 4].map((k) => {
      const l = [...new Set(VM_CSR.filter(([, , i]) => (i >> k) & 1).map(([n]) => sel[n]))];
      return l.length === 1 ? l[0] : orB(b, ...l);
    });
    const idx = b.op1(merger(ones(5)), idxBits, 'index');
    const w = (n: string) => andB(b, 'csrWrite', sel[n]);
    const wStatusM = b.name(w('mstatus'), 'wMstatus', true), wStatusS = w('sstatus');
    const wAny = b.name(orB(b, wStatusM, wStatusS), 'wStatus', true);
    // ---- new value: csrrw / csrrs / csrrc with a register or a 5-bit immediate
    const funct3 = b.op(splitter([2, 1]), ['funct3'], 'funct3');
    b.name(`${funct3}.o0`, 'op');
    const src = b.name(b.op1(busMux2(32), ['rs1v', b.op1(merger([5, 27]), ['zimm5', zero(27)]), `${funct3}.o1`], 'rs1 / immediate'), 'src', true);
    b.next();
    // the registers' outputs come back into the read multiplexer: those are named first, then wired
    const R = (n: number, label: string, name: string) => b.op(register(n), ['', '', 'clk'], label, name);
    const rSie = R(1, 'SIE', 'sie'), rMie = R(1, 'MIE', 'mie'), rSpie = R(1, 'SPIE', 'spie'), rMpie = R(1, 'MPIE', 'mpie'), rSpp = R(1, 'SPP', 'spp');
    const rMpp = R(2, 'MPP', 'mpp'), rFs = R(2, 'FS', 'fs'), rSum = R(1, 'SUM', 'sum'), rMxr = R(1, 'MXR', 'mxr'), rPrivN = R(2, 'privilege (inverted)', 'privN');
    const rMieR = R(2, 'mie: MTIE, MEIE', 'mieR'), rMtvec = R(30, 'mtvec', 'mtvec'), rMscratch = R(32, 'mscratch', 'mscratch'), rMepc = R(30, 'mepc', 'mepc');
    const rMcause = R(32, 'mcause', 'mcause'), rMtval = R(32, 'mtval', 'mtval');
    const rSatp = R(32, 'satp', 'satp'), rStvec0 = R(1, 'stvec[0]', 'stvec0'), rStvec = R(30, 'stvec[31:2]', 'stvec'), rSscratch = R(32, 'sscratch', 'sscratch');
    const rSepc = R(30, 'sepc', 'sepc'), rScause = R(32, 'scause', 'scause'), rStval = R(32, 'stval', 'stval');
    const priv = b.name(b.op1(NOTN(2), [`${rPrivN}.q`], 'privilege'), 'priv', true);
    const fs = b.op(splitter([1, 1]), [`${rFs}.q`], 'FS');
    const mieS = b.op(splitter([1, 1]), [`${rMieR}.q`], 'MTIE, MEIE');
    const sd = andB(b, `${fs}.o0`, `${fs}.o1`);
    // read values
    const z = { 1: gnd, 2: zero(2), 3: zero(3), 7: zero(7), 11: zero(11), 20: zero(20) } as Record<number, string>;
    const mstatus = b.op1(merger([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 1, 11, 1]), [gnd, `${rSie}.q`, gnd, `${rMie}.q`, gnd, `${rSpie}.q`, gnd, `${rMpie}.q`, `${rSpp}.q`, z[2], `${rMpp}.q`, `${rFs}.q`, z[3], `${rSum}.q`, `${rMxr}.q`, z[11], sd], 'mstatus');
    const sstatus = b.op1(merger([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 1, 11, 1]), [gnd, `${rSie}.q`, gnd, gnd, gnd, `${rSpie}.q`, gnd, gnd, `${rSpp}.q`, z[2], z[2], `${rFs}.q`, z[3], `${rSum}.q`, `${rMxr}.q`, z[11], sd], 'sstatus');
    const misa = b.op1(constWord(32, 0x40140100), [], 'misa');
    const mieV = b.op1(merger([7, 1, 3, 1, 20]), [z[7], `${mieS}.o0`, z[3], `${mieS}.o1`, z[20]], 'mie');
    const mipV = b.op1(merger([7, 1, 3, 1, 20]), [z[7], 'mtip', z[3], 'meip', z[20]], 'mip');
    b.name(mstatus, 'mstatus value'); b.name(mipV, 'mip value');
    const mtvecV = b.op1(merger([2, 30]), [z[2], `${rMtvec}.q`], 'mtvec'), mepcV = b.op1(merger([2, 30]), [z[2], `${rMepc}.q`], 'mepc');
    const sepcV = b.op1(merger([2, 30]), [z[2], `${rSepc}.q`], 'sepc');
    const stvecV = b.op1(merger([1, 1, 30]), [`${rStvec0}.q`, gnd, `${rStvec}.q`], 'stvec');
    const zero32 = zero(32);
    const vals = [mstatus, sstatus, misa, mieV, mtvecV, `${rMscratch}.q`, mepcV, `${rMcause}.q`, `${rMtval}.q`, mipV, 'mtime', 'mtime', `${rSatp}.q`, stvecV,
      `${rSscratch}.q`, sepcV, `${rScause}.q`, `${rStval}.q`, zero32];
    b.next();
    const rsel = b.op(muxTree(5, 32), [...vals, ...Array(13).fill(zero32), idx], 'read multiplexer', 'rsel');
    const old = b.name(`${rsel}.y`, 'old', true);
    b.wire(old, 'rdata');
    // csrrw: src; csrrs: old | src; csrrc: old & ~src
    const orOld = b.op1(bitwise('or', 32), [old, src]), andOld = b.op1(bitwise('and', 32), [old, b.op1(bitwise('xor', 32), [src, b.op1(constWord(32, 0xffffffff), [])])]);
    const nw = b.name(b.op1(muxTree(2, 32), [src, src, orOld, andOld, `${funct3}.o0`]), 'new', true);
    b.next();
    const nv = b.op(splitter([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 1, 12]), [nw], 'new mstatus fields');
    const nm = b.op(splitter([7, 1, 3, 1, 20]), [nw], 'new mie bits');
    const nhi = b.op(splitter([2, 30]), [nw], 'new[31:2]');
    const nlo = b.op(splitter([1, 31]), [nw], 'new[0]');
    const tr = 'trap', mr = 'mret', sr = 'sret';
    const nsr = notB(b, sr);
    const mux1 = (a: string, bb: string, s: string) => b.op1(MUX2, [a, bb, s]);
    // sstatus-visible fields: sret / a write
    b.wire(mux1(`${nv}.o1`, `${rSpie}.q`, sr), `${rSie}.d`); b.wire(orB(b, sr, wAny), `${rSie}.en`);
    b.wire(mux1(`${nv}.o5`, vdd, sr), `${rSpie}.d`); b.wire(orB(b, sr, wAny), `${rSpie}.en`);
    b.wire(andB(b, `${nv}.o8`, nsr), `${rSpp}.d`); b.wire(orB(b, sr, wAny), `${rSpp}.en`);
    b.wire(`${nv}.o11`, `${rFs}.d`); b.wire(wAny, `${rFs}.en`);
    b.wire(`${nv}.o13`, `${rSum}.d`); b.wire(wAny, `${rSum}.en`);
    b.wire(`${nv}.o14`, `${rMxr}.d`); b.wire(wAny, `${rMxr}.en`);
    // machine fields: a trap, mret, or a write to mstatus
    const tmw = b.name(orB(b, tr, mr, wStatusM), 'mstatusChange', true);
    b.wire(andB(b, notB(b, tr), mux1(`${nv}.o3`, `${rMpie}.q`, mr)), `${rMie}.d`); b.wire(tmw, `${rMie}.en`);
    b.wire(mux1(mux1(`${nv}.o7`, vdd, mr), `${rMie}.q`, tr), `${rMpie}.d`); b.wire(tmw, `${rMpie}.en`);
    // MPP: a trap saves the level, mret clears it (U), a write keeps S / M / U (2 reads back as U)
    const nmp = b.op(splitter([1, 1]), [`${nv}.o10`], 'written MPP');
    const warl = b.op1(merger([1, 1]), [`${nmp}.o0`, andB(b, `${nmp}.o1`, `${nmp}.o0`)], 'MPP is WARL');
    b.wire(mux1x2(b, mux1x2(b, warl, zero(2), mr), priv, tr), `${rMpp}.d`); b.wire(tmw, `${rMpp}.en`);
    // the level: trap → M (stored 00), mret → MPP, sret → S or U by SPP
    const sprivN = b.op1(merger([1, 1]), [notB(b, `${rSpp}.q`), vdd], 'level after sret, inverted');
    const mprivN = b.op1(NOTN(2), [`${rMpp}.q`], 'level after mret, inverted');
    b.wire(mux1x2(b, mux1x2(b, mprivN, sprivN, sr), zero(2), tr), `${rPrivN}.d`); b.wire(orB(b, tr, mr, sr), `${rPrivN}.en`);
    // mie, mtvec, mscratch; mepc, mcause, mtval take a trap's values over a write
    b.wire(b.op1(merger([1, 1]), [`${nm}.o1`, `${nm}.o3`]), `${rMieR}.d`); b.wire(w('mie'), `${rMieR}.en`);
    b.wire(`${nhi}.o1`, `${rMtvec}.d`); b.wire(w('mtvec'), `${rMtvec}.en`);
    b.wire(nw, `${rMscratch}.d`); b.wire(w('mscratch'), `${rMscratch}.en`);
    const tpc = b.op(splitter([2, 30]), ['trapPC'], 'trap PC[31:2]');
    b.wire(mux1x30(b, `${nhi}.o1`, `${tpc}.o1`, tr), `${rMepc}.d`); b.wire(orB(b, tr, w('mepc')), `${rMepc}.en`);
    b.wire(b.op1(busMux2(32), [nw, 'trapCause', tr]), `${rMcause}.d`); b.wire(orB(b, tr, w('mcause')), `${rMcause}.en`);
    b.wire(b.op1(busMux2(32), [nw, 'trapVal', tr]), `${rMtval}.d`); b.wire(orB(b, tr, w('mtval')), `${rMtval}.en`);
    // the supervisor registers
    const wSatp = w('satp');
    b.wire(nw, `${rSatp}.d`); b.wire(wSatp, `${rSatp}.en`);
    b.wire(`${nlo}.o0`, `${rStvec0}.d`); b.wire(w('stvec'), `${rStvec0}.en`);
    b.wire(`${nhi}.o1`, `${rStvec}.d`); b.wire(w('stvec'), `${rStvec}.en`);
    b.wire(nw, `${rSscratch}.d`); b.wire(w('sscratch'), `${rSscratch}.en`);
    b.wire(`${nhi}.o1`, `${rSepc}.d`); b.wire(w('sepc'), `${rSepc}.en`);
    b.wire(nw, `${rScause}.d`); b.wire(w('scause'), `${rScause}.en`);
    b.wire(nw, `${rStval}.d`); b.wire(w('stval'), `${rStval}.en`);
    b.next();
    // ---- the interrupt: taken while the level is below M or MIE is set
    const pv = b.op(splitter([1, 1]), [priv], 'level');
    const notM = b.op1(NAND, [`${pv}.o0`, `${pv}.o1`], 'below M?');
    const ei = b.name(andB(b, `${mieS}.o1`, 'meip'), 'external irq'), ti = andB(b, `${mieS}.o0`, 'mtip');
    b.wire(andB(b, orB(b, notM, `${rMie}.q`), orB(b, ei, ti)), 'irqTake');
    b.wire(b.op1(busMux2(32), [b.op1(constWord(32, 0x80000007), []), b.op1(constWord(32, 0x8000000b), []), ei], 'interrupt cause'), 'irqCause');
    b.wire(known, 'known');
    b.wire(mtvecV, 'mtvecOut'); b.wire(mepcV, 'mepcOut'); b.wire(sepcV, 'sepcOut');
    b.wire(priv, 'priv'); b.wire(`${rSum}.q`, 'sum'); b.wire(`${rMxr}.q`, 'mxr');
    const sa = b.op(splitter([22, 9, 1]), [`${rSatp}.q`], 'satp: PPN, ASID, MODE');
    b.wire(`${sa}.o2`, 'satpMode'); b.wire(`${sa}.o0`, 'satpPpn');
    b.wire(wSatp, 'satpWr');
    return define({
      id: 'csrunit_vm', name: 'CSR unit (M, S and U)', category: 'cpu',
      summary: 'The control and status registers of a machine with three privilege levels: the machine-mode ones, the privilege level itself, sstatus as a view of mstatus, the supervisor registers and satp. A trap enters M, mret and sret return to the level saved in MPP and SPP; MPP only takes U, S or M. Decides whether an interrupt is taken (below M always, in M when MIE is set).',
      ports: [bus('addr', 12, 'in'), bus('funct3', 3, 'in'), bus('rs1v', 32, 'in'), bus('zimm5', 5, 'in'), bit('csrWrite', 'in'),
        bit('trap', 'in'), bus('trapCause', 32, 'in'), bus('trapPC', 32, 'in'), bus('trapVal', 32, 'in'), bit('mret', 'in'), bit('sret', 'in'),
        bus('mtime', 32, 'in'), bit('mtip', 'in'), bit('meip', 'in'), clk(),
        bus('rdata', 32, 'out'), bit('known', 'out'), bus('mtvecOut', 32, 'out'), bus('mepcOut', 32, 'out'), bus('sepcOut', 32, 'out'), bit('irqTake', 'out'), bus('irqCause', 32, 'out'),
        bus('priv', 2, 'out'), bit('sum', 'out'), bit('mxr', 'out'), bit('satpMode', 'out'), bus('satpPpn', 22, 'out'), bit('satpWr', 'out')],
      symbol: { kind: 'box', label: 'CSRs' },
      // four nets ran under the read multiplexer's neighbours and two gates: pointers (tests/redrawclear-vmunits.test.ts)
      netlist: laid(nameNets(b), { keepOrder: true, room: true, gap: 6, vgap: 2, wires: { 'u58.out': false, 'u62.out': false, 'u45.o0': false, 'u126.y': false } }),
    });
  });
}

/** A bank of n inverters, one per bit of a bus. */
function NOTN(n: number): ComponentDef {
  return memo(`notn${n}`, () => {
    const b = new Builder(10, 6);
    b.pins('a');
    const s = b.op(splitter(ones(n)), ['a']);
    b.next();
    b.wire(b.op1(merger(ones(n)), Array.from({ length: n }, (_, i) => notB(b, `${s}.o${i}`))), 'y');
    return define({
      id: `notn${n}`, name: `${n}-bit inverter`, category: 'gate', summary: `Inverts each of ${n} bits.`,
      ports: [bus('a', n, 'in'), bus('y', n, 'out')], symbol: { kind: 'box', label: 'NOT' },
      spec: ([a]) => [~a & (2 ** n - 1)],
      netlist: laid(b, { keepOrder: true }),
    });
  });
}
/** A word multiplexer on a Builder: b when s, else a. */
const mux1x2 = (b: Builder, a: string, c: string, s: string) => b.op1(busMux2(2), [a, c, s]);
const mux1x30 = (b: Builder, a: string, c: string, s: string) => b.op1(busMux2(30), [a, c, s]);

/**
 * The trap unit of the vm variant: the causes of lib/system.ts's trap unit plus the page faults (12, 13, 15) and access
 * faults (1, 5, 7) of the MMU, and ecall by level (8 + level). Priority, highest first: interrupt, fetch faults (the
 * instruction word is not trusted), illegal, ebreak, ecall, misaligned jump target, misaligned load, misaligned store,
 * then the data faults (which only occur for a legal, aligned access). The cause is built from the winner's constant;
 * mtval is the PC for a fetch fault, the jump target for a misaligned fetch, the address for the rest (0 for an interrupt,
 * illegal instruction, ebreak, ecall).
 */
export function trapUnitVm(): ComponentDef {
  return memo('trapunit_vm', () => {
    const b = new Builder(18, 10);
    const reqs = ['irq', 'fetchPage', 'fetchAcc', 'illegal', 'ebreak', 'ecall', 'fetchMis', 'loadMis', 'storeMis', 'loadPage', 'storePage', 'loadAcc', 'storeAcc'] as const;
    const CAUSE: Record<string, number> = { fetchPage: 12, fetchAcc: 1, illegal: 2, ebreak: 3, fetchMis: 0, loadMis: 4, storeMis: 6, loadPage: 13, storePage: 15, loadAcc: 5, storeAcc: 7 };
    b.pins(...reqs, 'irqCause', 'priv', 'addr', 'target', 'pc');
    const win: Record<string, string> = {};
    let none = '';
    for (const r of reqs) {
      win[r] = none ? andB(b, r, none) : r;
      none = none ? andB(b, none, notB(b, r)) : notB(b, r);
    }
    const anyReq = notB(b, none);
    b.next();
    const ic = b.op(splitter([4, 27, 1]), ['irqCause'], 'interrupt cause');
    const ps = b.op(splitter([1, 1]), ['priv'], 'level');
    const ib = b.op(splitter(ones(4)), [`${ic}.o0`]);
    // cause[3:0]: OR of the winners' constants (ecall: 8 + level; an interrupt: its own)
    const bitsOf = (k: number) => {
      const l: string[] = [];
      for (const [n, c] of Object.entries(CAUSE)) if ((c >> k) & 1) l.push(win[n]);
      if (k === 3) l.push(win.ecall);
      if (k === 1) l.push(andB(b, win.ecall, `${ps}.o1`));
      if (k === 0) l.push(andB(b, win.ecall, `${ps}.o0`));
      l.push(andB(b, win.irq, `${ib}.o${k}`));
      return l.length === 1 ? l[0] : orB(b, ...l);
    };
    const low = b.op1(merger(ones(4)), [0, 1, 2, 3].map(bitsOf), 'cause[3:0]');
    b.next();
    b.wire(b.op1(merger([4, 27, 1]), [low, b.op1(constWord(27, 0), []), 'irq'], 'cause'), 'cause');
    b.wire(anyReq, 'trap');
    // mtval
    const selPc = orB(b, win.fetchPage, win.fetchAcc);
    const selAddr = orB(b, win.loadMis, win.storeMis, win.loadPage, win.storePage, win.loadAcc, win.storeAcc);
    const m0 = b.op1(busMux2(32), [b.op1(constWord(32, 0), []), 'pc', selPc], 'PC');
    const m1 = b.op1(busMux2(32), [m0, 'addr', selAddr], 'address');
    b.wire(b.op1(busMux2(32), [m1, 'target', win.fetchMis], 'jump target'), 'tval');
    return define({
      id: 'trapunit_vm', name: 'Trap unit (with page faults)', category: 'cpu',
      summary: 'Any interrupt or exception becomes a trap. The cause is the highest-priority request: interrupt, fetch page / access fault, illegal instruction, ebreak, ecall (8, 9 or 11 by privilege level), misaligned jump target, load, store, then page and access faults of loads and stores. mtval carries the faulting address.',
      ports: [bit('irq', 'in'), bus('irqCause', 32, 'in'), bit('fetchPage', 'in'), bit('fetchAcc', 'in'), bit('illegal', 'in'), bit('ebreak', 'in'), bit('ecall', 'in'), bus('priv', 2, 'in'),
        bit('fetchMis', 'in'), bit('loadMis', 'in'), bit('storeMis', 'in'), bit('loadPage', 'in'), bit('storePage', 'in'), bit('loadAcc', 'in'), bit('storeAcc', 'in'),
        bus('addr', 32, 'in'), bus('target', 32, 'in'), bus('pc', 32, 'in'),
        bit('trap', 'out'), bus('cause', 32, 'out'), bus('tval', 32, 'out')],
      symbol: { kind: 'box', label: 'TRAP' },
      netlist: laid(nameNets(b), { keepOrder: true, room: true, gap: 6, vgap: 2 }),
    });
  });
}
