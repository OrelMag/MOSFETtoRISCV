// Chapter 42's parts: a receiver that decides (a Schmitt trigger at switch level) and the circuits that cross from one
// clock to another (synchronizers, a toggle pulse synchronizer, Gray code, an asynchronous FIFO). Everything past the
// Schmitt trigger is NAND gates and the library's flip-flops. The gate-level simulator treats each clock edge as an
// event in a total order: it shows the structure and the latency of these circuits, not the race a real asynchronous
// arrival can run (phys/metastable.ts models that).

import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { PMOS_WEAK } from './cells';
import { decoder, equal, incrementer } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, XOR } from './gates';
import { readPort } from './regfile';
import { DFF, register } from './sequential';
import { GND, NMOS, PMOS, VDD } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });
const clk = (name: string, side: PortDef['side'] = 'bottom') => bit(name, 'in', side, true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

// ---- the Schmitt trigger ----------------------------------------------------------------------------------------------

/** A narrow NMOS: the keeper's pull-down, easily overpowered by the input inverter. */
export const NMOS_WEAK = define({
  ...NMOS, id: 'nmos_weak', name: 'NMOS (narrow, weak)', strength: 2,
  summary: 'A narrow NMOS: just enough current to hold a node low, easily overpowered by a normal transistor.',
});

/**
 * A buffer with a keeper: input inverter A (p1, n1) drives node m, output inverter B (p2, n2) drives y, and a weak
 * inverter (pk, nk) from y back onto m. The keeper restates whatever y is, so m is held in the old state until A,
 * wider than the keeper, wins the fight; and it then helps the new state along. This is how the sandbox's SRAM cell
 * holds a bit, with the loop made to be fought rather than flipped.
 */
export const SCHMITT: ComponentDef = define({
  id: 'schmitt', name: 'Schmitt trigger', category: 'cell',
  summary: 'A buffer whose output switches at one input voltage going up and a lower one going down: six transistors, a weak feedback inverter holds the node the input has to fight.',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: 'Schmitt', w: 8, h: 5 },
  spec: ([a]) => [a],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 8], y: [34, 8] },
    instances: [
      { name: 'vdd1', def: VDD, at: [7, 0] }, { name: 'p1', def: PMOS, at: [5, 3] },
      { name: 'n1', def: NMOS, at: [5, 9] }, { name: 'gnd1', def: GND, at: [7, 14] },
      { name: 'vdd2', def: VDD, at: [23, 0] }, { name: 'p2', def: PMOS, at: [21, 3] },
      { name: 'n2', def: NMOS, at: [21, 9] }, { name: 'gnd2', def: GND, at: [23, 14] },
      { name: 'vdd3', def: VDD, at: [15, 17] }, { name: 'pk', def: PMOS_WEAK, at: [13, 20], label: 'keeper' },
      { name: 'nk', def: NMOS_WEAK, at: [13, 26] }, { name: 'gnd3', def: GND, at: [15, 31] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'p1.g', 'n1.g'], trunk: 3 },
      { ends: ['vdd1.p', 'p1.s'] }, { ends: ['gnd1.p', 'n1.s'] },
      { ends: ['vdd2.p', 'p2.s'] }, { ends: ['gnd2.p', 'n2.s'] },
      { ends: ['vdd3.p', 'pk.s'] }, { ends: ['gnd3.p', 'nk.s'] },
      { name: 'm', ends: ['p1.d', 'n1.d', 'p2.g', 'n2.g', 'pk.d', 'nk.d'], trunk: 18 },
      { name: 'y', ends: ['p2.d', 'n2.d', 'y', 'pk.g', 'nk.g'], trunk: 28, via: { 'pk.g': [[30, 8], [30, 19], [11, 19], [11, 22]], 'nk.g': [[30, 8], [30, 19], [11, 19], [11, 28]] } },
    ],
  }),
  notes: `The thresholds depend on the keeper's width against the input inverter's (phys/schmitt.ts): going up,
    the input has to pull m below B's own threshold against a keeper that is holding it high; going down, against
    one holding it low. At switch level the part is a plain buffer (a 0 or a 1 on a, the same on y): who wins the
    fight is a matter of strength, which the solver has (the keeper is strength 2, the input devices 3).`,
  hdl: {
    verilog: `module schmitt (input a, output y);
  supply1 vdd; supply0 gnd;
  wire m;
  pmos p1 (m, vdd, a);   nmos n1 (m, gnd, a);     // input inverter
  pmos p2 (y, vdd, m);   nmos n2 (y, gnd, m);     // output inverter
  rpmos pk (m, vdd, y);  rnmos nk (m, gnd, y);    // weak keeper, y back onto m
endmodule`,
  },
});

// ---- synchronizers ----------------------------------------------------------------------------------------------------

/**
 * `stages` flip-flops in a row on one clock, `width` bits wide: the receiving domain's synchronizer. A signal from
 * another clock is sampled by the first flip-flop, which may be undecided for a while; the next one samples it a
 * period later.
 */
export function syncN(stages: number, width = 1): ComponentDef {
  const id = width === 1 ? `sync${stages}` : `sync${stages}x${width}`;
  return memo(id, () => {
    const b = new Builder(10, 10);
    b.pins('d', 'clk');
    let outs: string[];
    if (width === 1) {
      let prev = 'd';
      for (let s = 0; s < stages; s++) {
        prev = b.op1(DFF, [prev, 'clk'], s === 0 ? 'may be undecided' : `stage ${s + 1}`, `f${s}`);
        b.next();
      }
      outs = [prev];
    } else {
      const sp = b.op(splitter(ones(width)), ['d'], undefined, 'sp');
      b.next();
      let cur = Array.from({ length: width }, (_, i) => `${sp}.o${i}`);
      for (let s = 0; s < stages; s++) {
        cur = cur.map((d, i) => b.op1(DFF, [d, 'clk'], `bit ${i}`, `f${s}_${i}`));
        b.next();
      }
      outs = cur;
    }
    if (width === 1) b.wire(outs[0], 'q');
    else b.wire(b.op1(merger(ones(width)), outs, undefined, 'mg'), 'q');
    const R = b.right;
    return define({
      id, name: width === 1 ? `${stages}-flop synchronizer` : `${stages}-flop synchronizer (${width}-bit)`, category: 'sequential',
      summary: `${stages} flip-flops in series on the receiving clock${width > 1 ? `, ${width} bits side by side (each bit on its own: only a value that changes one bit at a time, a Gray code, is safe)` : ''}. The first may go metastable on an asynchronous input; each later one gives it a clock period more to resolve. The price is ${stages} cycles of latency.`,
      ports: [width === 1 ? bit('d', 'in') : bus('d', width, 'in'), clk('clk', 'bottom'), width === 1 ? bit('q', 'out') : bus('q', width, 'out')],
      symbol: { kind: 'box', label: `SYNC${stages}` },
      netlist: () => ({ pins: { d: [0, 3], clk: [0, 12], q: [R, 3] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `// a 2-flop synchronizer on the receiving clock
always_ff @(posedge clk) begin
  m <= d;     // may go metastable
  q <= m;     // had one full period to resolve
end`,
      },
    });
  });
}

export const SYNC2: ComponentDef = syncN(2);

// ---- Gray code --------------------------------------------------------------------------------------------------------

/** Binary to Gray: g = b XOR (b >> 1). Consecutive values differ in one bit. */
export const BIN2GRAY = (n: number): ComponentDef => memo(`bin2gray${n}`, () => {
  const b = new Builder(8, 10);
  b.pins('b');
  const sp = b.op(splitter(ones(n)), ['b'], undefined, 'sp');
  b.next();
  const g: string[] = [];
  for (let i = 0; i < n; i++) g.push(i === n - 1 ? `${sp}.o${i}` : b.op1(XOR, [`${sp}.o${i}`, `${sp}.o${i + 1}`], `b${i} ⊕ b${i + 1}`));
  b.next();
  b.wire(b.op1(merger(ones(n)), g, undefined, 'mg'), 'g');
  const R = b.right;
  return define({
    id: `bin2gray${n}`, name: `Binary to Gray (${n}-bit)`, category: 'routing',
    summary: `g = b ⊕ (b >> 1): ${n - 1} XOR gates, one level. Counting up changes exactly one bit of g each step, so a sampler that catches the word mid-change reads the old value or the new one, never a third.`,
    ports: [bus('b', n, 'in'), bus('g', n, 'out')],
    symbol: { kind: 'box', label: 'B→G' },
    spec: ([x]) => [x ^ (x >> 1)],
    netlist: () => ({ pins: { b: [0, 2 + n], g: [R, 2 + n] }, instances: b.instances, nets: b.nets() }),
    hdl: { verilog: 'assign g = b ^ (b >> 1);' },
  });
});

/** Gray to binary: b[n−1] = g[n−1], b[i] = g[i] ⊕ b[i+1], a chain n − 1 XORs deep. */
export const GRAY2BIN = (n: number): ComponentDef => memo(`gray2bin${n}`, () => {
  const b = new Builder(8, 8);
  b.pins('g');
  const sp = b.op(splitter(ones(n)), ['g'], undefined, 'sp');
  b.next();
  const out: string[] = new Array(n);
  out[n - 1] = `${sp}.o${n - 1}`;
  for (let i = n - 2; i >= 0; i--) {
    out[i] = b.op1(XOR, [`${sp}.o${i}`, out[i + 1]], `g${i} ⊕ b${i + 1}`);
    b.next();
  }
  b.wire(b.op1(merger(ones(n)), out, undefined, 'mg'), 'b');
  const R = b.right;
  return define({
    id: `gray2bin${n}`, name: `Gray to binary (${n}-bit)`, category: 'routing',
    summary: `b[i] = g[n−1] ⊕ … ⊕ g[i]: a chain ${n - 1} XORs deep (a prefix network would make it log n, at more gates). Used on the receiving side after the Gray word has been synchronized.`,
    ports: [bus('g', n, 'in'), bus('b', n, 'out')],
    symbol: { kind: 'box', label: 'G→B' },
    spec: ([g]) => {
      let x = g;
      for (let s = 1; s < n; s <<= 1) x ^= x >> s;
      return [x];
    },
    netlist: () => ({ pins: { g: [0, 2 + n], b: [R, 2 + n] }, instances: b.instances, nets: b.nets() }),
    hdl: { verilog: 'always_comb begin b[N-1] = g[N-1]; for (int i = N-2; i >= 0; i--) b[i] = g[i] ^ b[i+1]; end' },
  });
});

// ---- one event across --------------------------------------------------------------------------------------------------

/**
 * A toggle (pulse) synchronizer: a pulse in the sending domain flips a level; that level, which holds, crosses
 * through a two-flop synchronizer; a flip-flop and an XOR in the receiving domain turn each change back into one
 * pulse. Pulses need to be at least three receiving cycles apart (the level must be seen to change).
 */
export const PULSE_SYNC: ComponentDef = define({
  id: 'pulse_sync', name: 'Toggle pulse synchronizer', category: 'sequential',
  summary: 'Passes one event between unrelated clocks: the sender toggles a level, the receiver synchronizes the level and detects its change, giving one pulse of one receiving cycle. Pulses must be spaced by the synchronizer latency.',
  ports: [bit('pulse', 'in'), clk('aclk', 'bottom'), clk('bclk', 'bottom'), bit('out', 'out')],
  symbol: { kind: 'box', label: 'PULSE SYNC' },
  netlist: () => {
    const b = new Builder(10, 10);
    b.pins('pulse', 'aclk', 'bclk');
    const x = b.op1(XOR, ['pulse', 'tg.q'], 'toggle if pulse', 'tx');
    b.next();
    const t = b.op(DFF, [x, 'aclk'], 'level (sender clock)', 'tg');
    b.name(`${t}.q`, 't', true);
    b.next();
    const s = b.op1(syncN(2), [`${t}.q`, 'bclk'], 'level into the receiver', 'sy');
    b.next();
    const p = b.op(DFF, [s, 'bclk'], 'previous level', 'pv');
    b.next();
    b.wire(b.op1(XOR, [s, `${p}.q`], 'changed', 'edge'), 'out');
    const R = b.right;
    return { pins: { pulse: [0, 3], aclk: [0, 14], bclk: [0, 20], out: [R, 3] }, instances: b.instances, nets: b.nets() };
  },
  hdl: {
    verilog: `always_ff @(posedge aclk) if (pulse) t <= ~t;
always_ff @(posedge bclk) begin s1 <= t; s2 <= s1; s3 <= s2; end
assign out = s2 ^ s3;`,
  },
});

/** One bit leaving a flip-flop on clock A for a synchronizer on clock B: the smallest circuit with a crossing. */
export const SYNC_BENCH: ComponentDef = define({
  id: 'sync_bench', name: 'Clock crossing bench', category: 'sequential',
  summary: 'A flip-flop on clock A (the sender) whose output goes through a two-flop synchronizer on clock B. send is sampled at A edges, q is what domain B sees.',
  ports: [bit('send', 'in'), clk('aclk', 'bottom'), clk('bclk', 'bottom'), bit('a', 'out'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'A → B' },
  netlist: () => {
    const b = new Builder(10, 10);
    b.pins('send', 'aclk', 'bclk');
    const tx = b.op(DFF, ['send', 'aclk'], 'sender, clock A', 'tx');
    b.next();
    b.name(`${tx}.q`, 'a', true);
    const sy = b.op(syncN(2), [`${tx}.q`, 'bclk'], 'synchronizer, clock B', 'sy');
    b.next();
    b.wire(`${tx}.q`, 'a');
    b.wire(`${sy}.q`, 'q');
    const R = b.right;
    return { pins: { send: [0, 3], aclk: [0, 10], bclk: [0, 14], a: [R, 3], q: [R, 8] }, instances: b.instances, nets: b.nets() };
  },
});

// ---- the asynchronous FIFO ---------------------------------------------------------------------------------------------

/**
 * A FIFO of 2^k words whose write port runs on wclk and read port on rclk. The words sit in registers written on wclk;
 * each side keeps a binary pointer (to address) and a Gray copy of it (k + 1 bits, a lap bit on top). The Gray
 * pointers cross through 2-flop synchronizers; empty compares the read pointer with the synchronized write pointer,
 * full compares the write pointer with the synchronized read pointer, top two bits inverted. A synchronized pointer
 * is old, so a flag is late: full can stay up after room appeared, empty after a word arrived, never the reverse.
 */
export function asyncFifo(k: number, w: number): ComponentDef {
  const N = 2 ** k;
  return memo(`afifo${N}x${w}`, () => {
    const b = new Builder(12, 12);
    b.pins('we', 're', 'wdata', 'wclk', 'rclk');
    // write side: pointer, Gray pointer, enable
    const wen = b.name(b.op1(AND, ['we', b.op1(NOT, ['fl.eq'])], 'write if not full'), 'wen', true);
    const ren = b.name(b.op1(AND, ['re', b.op1(NOT, ['em.eq'])], 'read if not empty'), 'ren', true);
    b.next();
    b.op(incrementer(k + 1), ['wb.q'], 'next write pointer', 'winc');
    b.op(incrementer(k + 1), ['rb.q'], 'next read pointer', 'rinc');
    b.name('winc.y', 'wnext', true);
    b.name('rinc.y', 'rnext', true);
    b.next();
    b.op(BIN2GRAY(k + 1), ['winc.y'], 'to Gray', 'wgn');
    b.op(BIN2GRAY(k + 1), ['rinc.y'], 'to Gray', 'rgn');
    b.next();
    b.op(register(k + 1), ['winc.y', wen, 'wclk'], 'write pointer (binary)', 'wb');
    b.op(register(k + 1), ['wgn.g', wen, 'wclk'], 'write pointer (Gray)', 'wg');
    b.op(register(k + 1), ['rinc.y', ren, 'rclk'], 'read pointer (binary)', 'rb');
    b.op(register(k + 1), ['rgn.g', ren, 'rclk'], 'read pointer (Gray)', 'rg');
    b.name('wb.q', 'wptr', true);
    b.name('rb.q', 'rptr', true);
    b.name('wg.q', 'wgray', true);
    b.name('rg.q', 'rgray', true);
    b.next();
    // the crossings
    b.op(syncN(2, k + 1), ['rg.q', 'wclk'], 'read pointer into the write domain', 'rs');
    b.op(syncN(2, k + 1), ['wg.q', 'rclk'], 'write pointer into the read domain', 'ws');
    b.name('rs.q', 'rgray_w', true);
    b.name('ws.q', 'wgray_r', true);
    b.next();
    // flags
    const sr = b.op(splitter(ones(k + 1)), ['rs.q'], undefined, 'sr');
    const top = [k - 1, k].map((i) => b.op1(NOT, [`${sr}.o${i}`], `¬ bit ${i}`));
    const bits = Array.from({ length: k + 1 }, (_, i) => (i === k - 1 ? top[0] : i === k ? top[1] : `${sr}.o${i}`));
    const tgt = b.op1(merger(ones(k + 1)), bits, undefined, 'tgt');
    b.next();
    b.op(equal(k + 1), ['wg.q', tgt], 'full: write = read with the top two bits inverted', 'fl');
    b.op(equal(k + 1), ['rg.q', 'ws.q'], 'empty: read = write', 'em');
    b.name('fl.eq', 'full', true);
    b.name('em.eq', 'empty', true);
    b.next();
    // storage
    const sw = b.op(splitter([k, 1]), ['wb.q'], undefined, 'sw');
    const sd = b.op(splitter([k, 1]), ['rb.q'], undefined, 'sd');
    b.name(`${sw}.o0`, 'waddr', true);
    b.name(`${sd}.o0`, 'raddr', true);
    b.next();
    const dec = b.op(decoder(k, true), [`${sw}.o0`, wen], 'which word', 'sel');
    b.next();
    const words = Array.from({ length: N }, (_, i) => b.op1(register(w), ['wdata', `${dec}.y${i}`, 'wclk'], `word ${i}`, `w${i}`));
    b.next();
    const all = b.op1(merger(Array(N).fill(w)), words, undefined, 'all');
    b.next();
    b.wire(b.op1(readPort(k, w), [all, `${sd}.o0`], 'oldest word', 'rd'), 'rdata');
    b.wire('fl.eq', 'full');
    b.wire('em.eq', 'empty');
    const R = b.right;
    return define({
      id: `afifo${N}x${w}`, name: `${N}-word asynchronous FIFO (${w}-bit)`, category: 'memory',
      summary: `A FIFO of ${N} words written on wclk and read on rclk, clocks unrelated. Gray pointers cross through 2-flop synchronizers; full and empty are late, never wrong. rdata always shows the oldest word. we while full and re while empty are ignored.`,
      ports: [
        bit('we', 'in'), bus('wdata', w, 'in'), clk('wclk', 'bottom'), bit('full', 'out'),
        bit('re', 'in', 'right'), clk('rclk', 'bottom'), bus('rdata', w, 'out'), bit('empty', 'out'),
      ],
      symbol: { kind: 'box', label: 'ASYNC FIFO' },
      netlist: () => ({ pins: { we: [0, 2], wdata: [0, 6], re: [0, 10], wclk: [0, 14], rclk: [0, 18], rdata: [R, 4], empty: [R, 8], full: [R, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `// write domain (wclk)
wire wen = we & ~full;
always_ff @(posedge wclk) if (wen) begin mem[wb[K-1:0]] <= wdata; wb <= wb + 1; wg <= (wb + 1) ^ ((wb + 1) >> 1); end
always_ff @(posedge wclk) {rg_w, rg_w1} <= {rg_w1, rg};
assign full = (wg == {~rg_w[K:K-1], rg_w[K-2:0]});
// read domain (rclk)
wire ren = re & ~empty;
always_ff @(posedge rclk) if (ren) begin rb <= rb + 1; rg <= (rb + 1) ^ ((rb + 1) >> 1); end
always_ff @(posedge rclk) {wg_r, wg_r1} <= {wg_r1, wg};
assign empty = (rg == wg_r);
assign rdata = mem[rb[K-1:0]];`,
      },
    });
  });
}
