// Chapter 31's memory system for the warp core: one memory port shared by the lanes.
//
//   access unit   which lanes one access serves. Global memory is read and written a 16-byte line
//                 at a time: the lowest lane still to serve picks the line, every lane in it goes
//                 along (coalescing). Shared memory has 4 banks (word address mod 4), each with its
//                 own row decoder: per bank the lowest lane picks the row, lanes with the same word
//                 go along (broadcast), lanes wanting another row of a taken bank wait (a conflict).
//                 amoadd.w serves one lane per access.
//   memories      four words side by side: one row for all four (global, a line) or a row per bank
//                 (shared)
//   pipeline      global requests travel L − 1 pipeline registers; shared ones enter Ls − 1 from the
//                 end (on-chip, closer), when that slot is free. With globalEvery = B, a global access
//                 waits until none has started in the last B − 1 cycles (a memory with less bandwidth).

import type { ComponentDef, PortDef } from '../sim/types';
import { isShared } from '../riscv/simt';
import { Builder } from './builder';
import { busMux2, decoder, equal, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { fanout, koggeStone } from './fastadd';
import { AND, NOT, OR, XOR } from './gates';
import { lowestOne, onehotMux } from './lanes';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';

/** The lowest set bit's index (-1: none). */
const low = (m: number) => (m ? 31 - Math.clz32(m & -m) : -1);

/**
 * The lanes one access serves: of `unserved` (lane mask), with every lane's byte address. The lowest
 * unserved lane leads; only lanes in its memory (global or shared) go. Global: the lanes in its
 * 16-byte line. Shared: per bank, the lowest such lane picks the word, and the lanes asking for that
 * word go. amo: the leader alone.
 */
export function serveLanes(unserved: number, addrs: readonly number[], amo = false): number {
  const lead = low(unserved);
  if (lead < 0) return 0;
  if (amo) return 1 << lead;
  const a = (i: number) => addrs[i] >>> 0;
  const shared = isShared(a(lead));
  let served = 0;
  if (!shared) {
    for (let i = 0; i < addrs.length; i++) if ((unserved >> i) & 1 && a(i) >>> 4 === a(lead) >>> 4) served |= 1 << i;
    return served;
  }
  const row: number[] = [-1, -1, -1, -1];
  for (let i = 0; i < addrs.length; i++) {
    if (!((unserved >> i) & 1) || !isShared(a(i))) continue;
    const b = (a(i) >>> 2) & 3;
    if (row[b] < 0) row[b] = a(i) >>> 2;
    if (row[b] === a(i) >>> 2) served |= 1 << i;
  }
  return served;
}

/** The accesses a memory instruction takes: the lanes each one serves, in order. */
export function accessesOf(mask: number, addrs: readonly number[], amo = false): number[] {
  const out: number[] = [];
  for (let left = mask; left; ) {
    const s = serveLanes(left, addrs, amo);
    out.push(s);
    left &= ~s;
  }
  return out;
}

// ---- hardware -------------------------------------------------------------------------------------

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkPort = (): PortDef => ({ name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

function edgePins(b: Builder, ins: string[], outs: string[], pitch = 3): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  ins.forEach((p, i) => (pins[p] = [0, 2 + pitch * i]));
  outs.forEach((p, i) => (pins[p] = [b.right, 2 + pitch * i]));
  return pins;
}

/** OR of the bits of a bus. */
function anyOf(b: Builder, d: string, n: number, label?: string, name?: string): string {
  if (n === 1) return d;
  const s = b.op(splitter(ones(n)), [d]);
  return b.op1(orN(n), Array.from({ length: n }, (_, i) => `${s}.o${i}`), label, name);
}

/** An address's fields: [1:0], bank [3:2], [11:4], space (bit 12), [31:13]. */
const ADDR = [2, 2, 8, 1, 19];

/**
 * The access unit: which of the lanes still to serve (left) one access serves, and whether it goes to
 * shared memory. The spec is serveLanes.
 */
export function accessUnit(n: number): ComponentDef {
  return memo(`access${n}`, () => {
    const L = Array.from({ length: n }, (_, i) => i);
    const ins = ['left', 'amo', ...L.map((i) => `addr${i}`)];
    const b = new Builder(16, 14);
    b.pins(...ins);
    const lead = b.op(lowestOne(n), ['left'], 'leader', 'lead');
    const ls = b.op(splitter(ones(n)), ['left'], undefined, 'ls');
    const f = L.map((i) => b.op(splitter(ADDR), [`addr${i}`], undefined, `f${i}`));
    b.next();
    const la = b.op1(onehotMux(n, 32), [`${lead}.y`, ...L.map((i) => `addr${i}`)], "leader's address", 'la');
    // line = address bits 31 … 4, word = bits 31 … 2
    const line = L.map((i) => b.op1(merger([8, 1, 19]), [`${f[i]}.o2`, `${f[i]}.o3`, `${f[i]}.o4`], undefined, `ln${i}`));
    const word = L.map((i) => b.op1(merger([2, 28]), [`${f[i]}.o1`, line[i]], undefined, `wd${i}`));
    const bank = L.map((i) => b.op(decoder(2), [`${f[i]}.o1`], `bank ${i}`, `bk${i}`));
    b.next();
    const fl = b.op(splitter(ADDR), [la], undefined, 'fl');
    b.next();
    const lline = b.op1(merger([8, 1, 19]), [`${fl}.o2`, `${fl}.o3`, `${fl}.o4`], "leader's line", 'lline');
    // eligible for shared: still to serve, and in the leader's memory
    const elig = L.map((i) => b.op1(AND, [`${ls}.o${i}`, b.op1(NOT, [b.op1(XOR, [`${f[i]}.o3`, `${fl}.o3`], undefined, `sx${i}`)], undefined, `ss${i}`)], undefined, `el${i}`));
    b.next();
    // global: the lanes in the leader's line
    const g = L.map((i) => b.op1(AND, [`${ls}.o${i}`, b.op1(equal(28), [line[i], lline], `lane ${i} in the line?`, `eqL${i}`)], undefined, `g${i}`));
    // shared: per bank, the lowest eligible lane on it picks the row
    const rows = [0, 1, 2, 3].map((k) => {
      const cand = b.op1(merger(ones(n)), L.map((i) => b.op1(AND, [elig[i], `${bank[i]}.y${k}`], undefined, `c${k}_${i}`)), undefined, `cand${k}`);
      const first = b.op(lowestOne(n), [cand], `bank ${k}: first lane`, `first${k}`);
      return b.op1(onehotMux(n, 30), [`${first}.y`, ...word], `bank ${k} row`, `row${k}`);
    });
    b.next();
    const s = L.map((i) => {
      const mine = b.op1(muxTree(2, 30), [...rows, `${f[i]}.o1`], `lane ${i}'s bank row`, `mine${i}`);
      return b.op1(AND, [elig[i], b.op1(equal(30), [word[i], mine], `lane ${i}: that word?`, `eqW${i}`)], undefined, `s${i}`);
    });
    b.next();
    const G = b.op1(merger(ones(n)), g, 'line', 'G');
    const S = b.op1(merger(ones(n)), s, 'banks', 'S');
    const pick = b.op1(busMux2(n), [G, S, `${fl}.o3`], 'global / shared', 'pick');
    b.next();
    b.wire(b.op1(busMux2(n), [pick, `${lead}.y`, 'amo'], 'amo: the leader alone', 'serveM'), 'serve');
    b.wire(`${fl}.o3`, 'shared');
    return define({
      id: `access${n}`, name: 'Access unit (coalescer and bank picker)', category: 'memory',
      summary: `Which lanes one memory access serves. The lowest lane still to serve leads; bit 12 of its address picks the memory. Global memory reads a 16-byte line: every lane whose address bits 31 … 4 match the leader's goes (coalescing). Shared memory has 4 banks (address bits 3 … 2), each with its own row: per bank, the lowest eligible lane picks the row and every lane asking for that word goes (broadcast); a lane wanting another row of a taken bank waits for the next access (a bank conflict). amoadd.w: the leader alone.`,
      ports: [bus('left', n, 'in'), bit('amo', 'in'), ...L.map((i) => bus(`addr${i}`, 32, 'in')), bus('serve', n, 'out'), bit('shared', 'out')],
      symbol: { kind: 'box', label: 'ACCESS UNIT' },
      spec: ([left, amo, ...addrs]) => {
        const lead = low(left);
        return [serveLanes(left, addrs, !!amo), lead >= 0 && isShared(addrs[lead]) ? 1 : 0];
      },
      netlist: () => ({ pins: edgePins(b, ins, ['serve', 'shared'], 4), instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * 2^k words in four columns (word 4 r + c in row r, column c). Line memory: one row address for all
 * four columns (a 16-byte line is read and written at once, a write enable per word). Banked: each
 * column (bank) has its own row address and decoder. Reads are combinational; writes at the edge.
 */
export function quadMemory(k: number, banked: boolean, init?: ArrayLike<number>): ComponentDef {
  if (init && Array.from(init).some((v) => v)) return withInit(quadMemory(k, banked), init);
  const id = `${banked ? 'bankmem' : 'linemem'}${k}`;
  return memo(id, () => {
    const R = 2 ** (k - 2), C = [0, 1, 2, 3], rows = Array.from({ length: R }, (_, r) => r);
    const rowIns = banked ? C.map((c) => `row${c}`) : ['row'];
    const ins = [...rowIns, 'we', ...C.map((c) => `wd${c}`), 'clk'];
    const b = new Builder(18, 16, 2);
    b.pins(...ins);
    const wes = b.op(splitter(ones(4)), ['we'], undefined, 'wes');
    b.next();
    // the write enable of word (r, c)
    let en: (r: number, c: number) => string;
    if (banked) {
      const dec = C.map((c) => b.op(decoder(k - 2, true), [`row${c}`, `${wes}.o${c}`], `bank ${c} row`, `dec${c}`));
      en = (r, c) => `${dec[c]}.y${r}`;
    } else {
      const dec = b.op(decoder(k - 2), ['row'], 'line', 'dec');
      b.next();
      const e = rows.map((r) => C.map((c) => b.op1(AND, [`${dec}.y${r}`, `${wes}.o${c}`], undefined, `e${r}_${c}`)));
      en = (r, c) => e[r][c];
    }
    b.next();
    const q = rows.map((r) => C.map((c) => {
      const w = 4 * r + c;
      const reg = b.add(register(32), `word ${w}`, `w${w}`);
      b.wire(`wd${c}`, `${reg}.d`); b.wire(en(r, c), `${reg}.en`); b.wire('clk', `${reg}.clk`);
      return `${reg}.q`;
    }));
    b.next();
    C.forEach((c) => {
      const m = b.add(muxTree(k - 2, 32), banked ? `bank ${c} reads` : `word ${c} of the line`, `rd${c}m`);
      rows.forEach((r) => b.wire(q[r][c], `${m}.d${r}`));
      b.wire(banked ? `row${c}` : 'row', `${m}.s`);
      b.wire(`${m}.y`, `rd${c}`);
    });
    const N = 2 ** k;
    return define({
      id, name: banked ? `Shared memory, 4 banks (${N} words)` : `Line memory (${N} words, 16-byte lines)`, category: 'memory',
      summary: banked
        ? `${N} words in 4 banks of ${R}: word w sits in bank w mod 4, row w / 4. Each bank has its own row address and decoder, so one access reads or writes any four words in different banks; two words in one bank need two accesses.`
        : `${N} words as ${R} lines of four: one row address reads or writes a whole 16-byte line, a write enable per word. One decoder for the four words; any four words of one line in one access, two lines in two.`,
      ports: [...rowIns.map((p) => bus(p, k - 2, 'in')), bus('we', 4, 'in'), ...C.map((c) => bus(`wd${c}`, 32, 'in')), clkPort(), ...C.map((c) => bus(`rd${c}`, 32, 'out'))],
      symbol: { kind: 'box', label: banked ? 'SHARED (4 BANKS)' : 'LINE MEMORY' },
      netlist: () => ({ pins: edgePins(b, ins, C.map((c) => `rd${c}`), 4), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** A memory that starts with these words: power-on hints into its words' flip-flops (as editor/memory.ts ramWithInit). */
function withInit(base: ComponentDef, init: ArrayLike<number>): ComponentDef {
  const words = Array.from(init, (v) => v >>> 0);
  let h = 2166136261;
  for (const x of words) { h ^= x; h = Math.imul(h, 16777619) >>> 0; }
  return memo(`${base.id}_i${h.toString(16)}`, () => {
    const powerOn: Record<string, 0 | 1> = {};
    words.forEach((v, i) => {
      for (let j = 0; j < 32; j++) {
        if (!((v >>> j) & 1)) continue;
        for (const l of ['master', 'slave']) {
          powerOn[`w${i}.ff${j}.ff.${l}.sr.q`] = 1;
          powerOn[`w${i}.ff${j}.ff.${l}.sr.q_n`] = 0;
        }
      }
    });
    return { ...base, id: `${base.id}_i${h.toString(16)}`, powerOn, summary: `${base.summary} Starts with the kernel's data.` };
  });
}

export interface LsuMemOptions {
  lanes: number;
  warps: number;
  /** Global latency L: a global access issued in cycle t reaches the memory in cycle t + L − 1. */
  latency: number;
  /** Shared latency Ls (2 … L). */
  sharedLatency: number;
  /** A global access at most every B cycles (1 … L). */
  globalEvery: number;
  /** Global words 2^k, shared words 2^ks. */
  k: number;
  ks: number;
  init?: ArrayLike<number>;
}

/** Fields of a request, low to high: ret, st, amo, shared, last, warp, rd, serve, addresses, data. */
const lsuFields = (n: number, W: number) => [1, 1, 1, 1, 1, W, 5, n, ...Array(n).fill(32), ...Array(n).fill(32)];

/**
 * The memory behind the access unit. An access enters with what to do (ret: a load or amoadd.w that
 * writes a register; st; amo), its memory, whether it is its instruction's last, the warp, rd, the
 * lanes it serves and every lane's address and data; one with no lane is no request. Global accesses
 * enter the pipeline's first register and reach the line memory L − 1 cycles later; shared ones enter
 * Ls − 1 registers from the end (slotBusy: a global request is about to take that slot, so wait).
 * At the memory, the served lanes read their words (each lane's bank / word of the line), stores
 * write (the highest lane wins a word several store), amoadd.w writes old + data and returns old.
 */
export function lsuMemory(o: LsuMemOptions): ComponentDef {
  const { lanes: n, warps: W, latency: L, sharedLatency: Ls, globalEvery: B, k, ks } = o;
  if (Ls < 2 || Ls > L) throw new Error('shared latency: 2 … L');
  if (B < 1 || B > L) throw new Error('globalEvery: 1 … L');
  const GM = quadMemory(k, false, o.init), SM = quadMemory(ks, true);
  return memo(`lsumem${n}_${W}_${L}_${Ls}_${B}_${GM.id}_${SM.id}`, () => {
    const F = lsuFields(n, W), P = F.reduce((a, c) => a + c, 0);
    const Ln = Array.from({ length: n }, (_, i) => i), C = [0, 1, 2, 3];
    const ins = ['ret', 'st', 'amo', 'shared', 'last', 'warp', 'rd', 'serve', ...Ln.map((i) => `addr${i}`), ...Ln.map((i) => `wd${i}`), 'clk'];
    const b = new Builder(18, 14);
    b.pins(...ins);
    // a request with no lane is none: its ret / st / amo are cleared; global ones enter at the start, shared ones near the end
    const valid = anyOf(b, 'serve', n, 'some lane', 'valid');
    const ins_ = Ls < L ? L - Ls + 1 : 0;
    b.next();
    const gate = (en: string, nm: string) => ['ret', 'st', 'amo'].map((p) => b.op1(AND, [p, en], undefined, `${nm}${p}`));
    const nsh = b.op1(NOT, ['shared'], undefined, 'nsh');
    const enG = ins_ ? b.op1(AND, [valid, nsh], 'global', 'enG') : valid;
    const enS = ins_ ? b.op1(AND, [valid, 'shared'], 'shared', 'enS') : '';
    b.next();
    const rest = ['shared', 'last', 'warp', 'rd', 'serve', ...Ln.map((i) => `addr${i}`), ...Ln.map((i) => `wd${i}`)];
    const reqG = b.op1(merger(F), [...gate(enG, 'g'), ...rest], 'global request', 'reqG');
    const reqS = ins_ ? b.op1(merger(F), [...gate(enS, 's'), ...rest], 'shared request', 'reqS') : '';
    // the pipeline; a stage's request is valid when it has ret, st or amo
    const stageValid = (q: string, s: number, global: boolean) => {
      const t = `${global ? 'g' : 'x'}${s}`;
      const sp = b.op(splitter([1, 1, 1, 1, P - 4]), [q], undefined, `sv${t}`);
      const v = b.op1(orN(3), [`${sp}.o0`, `${sp}.o1`, `${sp}.o2`], undefined, `v${t}`);
      return global ? b.op1(AND, [v, b.op1(NOT, [`${sp}.o3`], undefined, `vn${t}`)], `stage ${s}: global`, `gv${t}`) : v;
    };
    let q = reqG;
    const qs: string[] = [];
    for (let s = 1; s < L; s++) {
      b.next();
      let d = q;
      if (s === ins_) d = b.op1(busMux2(P), [q, reqS, enS], 'shared enters', 'ins');
      const r = b.add(register(P), `stage ${s}`, `s${s}`);
      b.wire(d, `${r}.d`); b.wire('clk', `${r}.clk`); b.wire(b.op1(TIE1, [], undefined, `one${s}`), `${r}.en`);
      q = `${r}.q`;
      qs.push(q);
    }
    b.next();
    // slotBusy: the request that would reach the memory with a shared one entering now; globalBusy: a global access started in the last B − 1 cycles
    const slot = ins_ ? stageValid(qs[ins_ - 2], ins_ - 1, false) : b.op1(TIE0, [], undefined, 'noSlot');
    const recent = Array.from({ length: B - 1 }, (_, j) => stageValid(qs[j], j + 1, true));
    const gBusy = recent.length === 0 ? b.op1(TIE0, [], undefined, 'noBusy') : recent.length === 1 ? recent[0] : b.op1(orN(recent.length), recent, 'recent global', 'gBusy');
    b.wire(slot, 'slotBusy'); b.wire(gBusy, 'globalBusy');
    // at the memory
    const f = b.op(splitter(F), [q], 'at the memory', 'f');
    const fld = (i: number) => `${f}.o${i}`;
    const SV = 7, AD = 8, WD = 8 + n;
    b.next();
    const sv = b.op(splitter(ones(n)), [fld(SV)], undefined, 'svs');
    const af = Ln.map((i) => b.op(splitter(ADDR), [fld(AD + i)], undefined, `af${i}`));
    const lead = b.op(lowestOne(n), [fld(SV)], 'first served lane', 'lead');
    const wrt = b.op1(OR, [fld(1), fld(2)], 'writes', 'wrt');
    b.next();
    const bk = Ln.map((i) => b.op(decoder(2), [`${af[i]}.o1`], undefined, `bk${i}`));
    // global: the first served lane's line; shared: per bank, its first served lane's row
    const ga = b.op1(onehotMux(n, 32), [`${lead}.y`, ...Ln.map((i) => fld(AD + i))], 'line address', 'ga');
    b.next();
    const on = (i: number, c: number) => b.op1(AND, [`${sv}.o${i}`, `${bk[i]}.y${c}`], undefined, `on${i}_${c}`);
    const onB = C.map((c) => Ln.map((i) => on(i, c)));
    const gas = b.op(splitter([4, k - 2, 30 - k]), [ga], undefined, 'gas');
    b.next();
    const rowOf = C.map((c) => {
      const fst = b.op(lowestOne(n), [b.op1(merger(ones(n)), onB[c], undefined, `onB${c}`)], `bank ${c}: first lane`, `fst${c}`);
      const ra = b.op1(onehotMux(n, 32), [`${fst}.y`, ...Ln.map((i) => fld(AD + i))], undefined, `ra${c}`);
      const rs = b.op(splitter([4, ks - 2, 30 - ks]), [ra], undefined, `rs${c}`);
      return `${rs}.o1`;
    });
    const hasW = C.map((c) => b.op1(AND, [wrt, b.op1(orN(n), onB[c], undefined, `any${c}`)], `word ${c} written`, `hw${c}`));
    b.next();
    const ns = b.op1(NOT, [fld(3)], undefined, 'nsp');
    const weG = b.op1(merger(ones(4)), C.map((c) => b.op1(AND, [hasW[c], ns], undefined, `weg${c}`)), undefined, 'weG');
    const weS = b.op1(merger(ones(4)), C.map((c) => b.op1(AND, [hasW[c], fld(3)], undefined, `wes${c}`)), undefined, 'weS');
    b.next();
    // the memories: write data comes back from the read side (amoadd.w), so the data path is wired below
    const gm = b.add(GM, 'global memory', 'gmem');
    const sm = b.add(SM, 'shared memory', 'smem');
    b.wire(`${gas}.o1`, `${gm}.row`); C.forEach((c) => b.wire(rowOf[c], `${sm}.row${c}`));
    b.wire(weG, `${gm}.we`); b.wire(weS, `${sm}.we`); b.wire('clk', `${gm}.clk`); b.wire('clk', `${sm}.clk`);
    b.next();
    // each lane's word: the memory's four words, then the lane's column
    const col = C.map((c) => b.op1(busMux2(32), [`${gm}.rd${c}`, `${sm}.rd${c}`, fld(3)], undefined, `col${c}`));
    b.next();
    const rdata = Ln.map((i) => b.op1(muxTree(2, 32), [...col, `${af[i]}.o1`], `lane ${i} reads`, `rdl${i}`));
    b.next();
    // amoadd.w: one lane, old + its data
    const old = b.op1(onehotMux(n, 32), [`${lead}.y`, ...rdata], 'old word', 'old');
    const dat = b.op1(onehotMux(n, 32), [`${lead}.y`, ...Ln.map((i) => fld(WD + i))], 'its data', 'dat');
    b.next();
    const ka = b.add(koggeStone(32), 'old + data', 'amoAdd');
    b.wire(old, `${ka}.a`); b.wire(dat, `${ka}.b`); b.wire(b.op1(TIE0, [], undefined, 'c0'), `${ka}.cin`);
    b.next();
    const wdl = Ln.map((i) => b.op1(busMux2(32), [fld(WD + i), `${ka}.s`, fld(2)], undefined, `wdl${i}`));
    b.next();
    // per word: the highest served lane on it wins
    C.forEach((c) => {
      let d = wdl[0];
      for (let i = 1; i < n; i++) d = b.op1(busMux2(32), [d, wdl[i], onB[c][i]], undefined, `wc${c}_${i}`);
      b.wire(d, `${gm}.wd${c}`); b.wire(d, `${sm}.wd${c}`);
    });
    b.next();
    b.wire(fld(0), 'retValid'); b.wire(fld(5), 'retWarp'); b.wire(fld(6), 'retRd'); b.wire(fld(4), 'retLast');
    b.wire(b.op1(bitwise('and', n), [fld(SV), b.op1(fanout(n), [fld(0)], undefined, 'fret')], 'lanes written back', 'rmask'), 'retMask');
    Ln.forEach((i) => b.wire(rdata[i], `retData${i}`));
    const outs = ['retValid', 'retWarp', 'retRd', 'retLast', 'retMask', ...Ln.map((i) => `retData${i}`), 'slotBusy', 'globalBusy'];
    return define({
      id: `lsumem${n}_${W}_${L}_${Ls}_${B}_${GM.id}_${SM.id}`, name: 'Memory system (line memory + shared banks)', category: 'memory',
      summary: `One access per cycle enters: global ones travel ${L - 1} pipeline registers to the line memory, shared ones ${Ls - 1} to the banks (they enter near the end, when that slot is free).${B > 1 ? ` A global access may start only when none has in the last ${B - 1} cycles.` : ''} At the memory the served lanes read their words, stores write them (the highest lane wins a word several store), and amoadd.w writes old + data and returns the old word. Loaded words go back to the lanes they serve.`,
      ports: [bit('ret', 'in'), bit('st', 'in'), bit('amo', 'in'), bit('shared', 'in'), bit('last', 'in'), bus('warp', W, 'in'), bus('rd', 5, 'in'), bus('serve', n, 'in'),
        ...Ln.map((i) => bus(`addr${i}`, 32, 'in')), ...Ln.map((i) => bus(`wd${i}`, 32, 'in')), clkPort(),
        bit('retValid', 'out'), bus('retWarp', W, 'out'), bus('retRd', 5, 'out'), bit('retLast', 'out'), bus('retMask', n, 'out'), ...Ln.map((i) => bus(`retData${i}`, 32, 'out')),
        bit('slotBusy', 'out'), bit('globalBusy', 'out')],
      symbol: { kind: 'box', label: `MEMORY (${L} / ${Ls} CYCLES)` },
      netlist: () => ({ pins: edgePins(b, ins, outs), instances: b.instances, nets: b.nets() }),
    });
  });
}

