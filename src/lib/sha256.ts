// SHA-256 in gates: Ch, Maj, the four sigma functions (rotations are wiring and cost nothing, the XORs are the whole price), one
// round, the message schedule as a 16-word shift register, the constants as a decoder and OR planes (a ROM drawn in gates), and an
// iterative compression core: one round a clock, 64 rounds. crypto/sha256.ts is the golden model; tests/crypto-sha256.test.ts holds
// every part to it and runs the core on the NIST example, comparing a..h at every clock with the document's round table.
// Words are 32 bits, so the small parts carry a `spec`; the 256- and 512-bit ones are checked bit by bit against the model instead.

import { K, bigSigma0, bigSigma1, ch, maj, smallSigma0, smallSigma1 } from '../crypto/sha256';
import type { ComponentDef, PortDef } from '../sim/types';
import { shiftRightWire } from './alu';
import { Builder } from './builder';
import { andN, busMux2, decoder, incrementer, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOT, OR } from './gates';
import { clearableRegister } from './pipeline';
import { DFF, register } from './sequential';
import { NAND3 } from './seqparts';
import { NAND, TIE0 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const W32 = new Array<number>(32).fill(1);
const words = (n: number) => new Array<number>(n).fill(32);

/** Rotate right by k: pure wiring. */
export function rotr(k: number): ComponentDef {
  return memo(`sha_rotr${k}`, () => define({
    id: `sha_rotr${k}`, name: `Wiring: rotate right ${k}`, category: 'plumbing',
    summary: `Bit i of the result is bit ${k} + i (mod 32) of the input: the wires are laid with a twist and nothing is computed. This is why SHA-256's sigma functions cost XORs only.`,
    ports: [bus('in', 32, 'in'), bus('out', 32, 'out')], symbol: { kind: 'box', label: `ROTR ${k}`, w: 6, h: 2 }, prim: 'alias',
    alias: Array.from({ length: 32 }, (_, i): [string, number, string, number] => ['in', (i + k) % 32, 'out', i]),
    spec: ([x]) => [((x >>> k) | (x << (32 - k))) >>> 0],
  }));
}

/** Three words XORed: rotations (wiring) or a shift (wiring and a tied-low fill), then two 32-bit XORs. */
function sigma(id: string, name: string, summary: string, terms: [kind: 'rotr' | 'shr', k: number][], f: (x: number) => number, label: string): ComponentDef {
  return memo(id, () => {
    const X = bitwise('xor', 32), b = new Builder(8, 12, 6);
    b.pins('x');
    const z = terms.some((t) => t[0] === 'shr') ? b.add(TIE0, '0') : '';
    const outs = terms.map(([kind, k]) => (kind === 'rotr' ? b.op1(rotr(k), ['x'], `ROTR ${k}`) : b.op1(shiftRightWire(32, k), ['x', `${z}.y`], `SHR ${k}`)));
    b.next();
    const s1 = b.op1(X, [outs[0], outs[1]]);
    b.next();
    b.wire(b.op1(X, [s1, outs[2]]), 'y');
    return define({
      id, name, category: 'arithmetic', summary,
      ports: [bus('x', 32, 'in'), bus('y', 32, 'out')], symbol: { kind: 'box', label },
      spec: ([x]) => [f(x)],
      netlist: () => ({ pins: { x: [0, 12], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}
export const bigSig0 = (): ComponentDef => sigma('sha_bsig0', 'Σ0', 'Σ0(x) = ROTR 2 ⊕ ROTR 13 ⊕ ROTR 22. Three wirings and two 32-bit XORs: 64 XOR gates, no other logic.', [['rotr', 2], ['rotr', 13], ['rotr', 22]], bigSigma0, 'Σ0');
export const bigSig1 = (): ComponentDef => sigma('sha_bsig1', 'Σ1', 'Σ1(x) = ROTR 6 ⊕ ROTR 11 ⊕ ROTR 25. Three wirings and two 32-bit XORs.', [['rotr', 6], ['rotr', 11], ['rotr', 25]], bigSigma1, 'Σ1');
export const smallSig0 = (): ComponentDef => sigma('sha_ssig0', 'σ0', 'σ0(x) = ROTR 7 ⊕ ROTR 18 ⊕ SHR 3, the schedule\'s mixer. The shift is wiring with a tied-low fill.', [['rotr', 7], ['rotr', 18], ['shr', 3]], smallSigma0, 'σ0');
export const smallSig1 = (): ComponentDef => sigma('sha_ssig1', 'σ1', 'σ1(x) = ROTR 17 ⊕ ROTR 19 ⊕ SHR 10.', [['rotr', 17], ['rotr', 19], ['shr', 10]], smallSigma1, 'σ1');

/** Ch(e, f, g) = e ? f : g, bit by bit: a 2:1 multiplexer per bit selected by e. */
export function shaCh(): ComponentDef {
  return memo('sha_ch', () => {
    const b = new Builder(8, 12, 8);
    b.maxH = 220;
    b.pins('e', 'f', 'g');
    const se = b.op(splitter(W32), ['e']), sf = b.op(splitter(W32), ['f']), sg = b.op(splitter(W32), ['g']);
    b.next();
    for (const [sp, nm] of [[se, 'e'], [sf, 'f'], [sg, 'g']] as const) for (let i = 0; i < 32; i++) b.name(`${sp}.o${i}`, `${nm}${i}`, true);
    const o = Array.from({ length: 32 }, (_, i) => b.op1(MUX2, [`${sg}.o${i}`, `${sf}.o${i}`, `${se}.o${i}`]));
    o.forEach((d, i) => b.name(d, `y${i}`, true));
    b.next();
    b.wire(b.op1(merger(W32), o), 'y');
    return define({
      id: 'sha_ch', name: 'Ch (choose)', category: 'gate',
      summary: 'Ch(e, f, g) = (e ∧ f) ⊕ (¬e ∧ g): where e is 1 take f, where it is 0 take g. A multiplexer per bit, four NANDs each.',
      ports: [bus('e', 32, 'in'), bus('f', 32, 'in'), bus('g', 32, 'in'), bus('y', 32, 'out')], symbol: { kind: 'box', label: 'Ch' },
      spec: ([e, f, g]) => [ch(e, f, g)],
      netlist: () => ({ pins: { e: [0, 12], f: [0, 24], g: [0, 36], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The majority of three bits: three NANDs of pairs into a NAND3. */
export const maj1 = (): ComponentDef => memo('sha_maj1', () => {
  const b = new Builder(8, 10, 2);
  b.pins('a', 'b', 'c');
  const ab = b.op1(NAND, ['a', 'b']), ac = b.op1(NAND, ['a', 'c']), bc = b.op1(NAND, ['b', 'c']);
  b.next();
  b.wire(b.op1(NAND3, [ab, ac, bc]), 'y');
  return define({
    id: 'sha_maj1', name: 'Majority of three bits', category: 'gate',
    summary: 'The bit that at least two of a, b, c agree on: ab + ac + bc = NAND(NAND(a,b), NAND(a,c), NAND(b,c)). Six NANDs.',
    ports: [bit('a', 'in'), bit('b', 'in'), bit('c', 'in'), bit('y', 'out')], symbol: { kind: 'box', label: 'MAJ' },
    spec: ([a, bb, c]) => [a + bb + c >= 2 ? 1 : 0],
    netlist: () => ({ pins: { a: [0, 2], b: [0, 6], c: [0, 10], y: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
  });
});

export function shaMaj(): ComponentDef {
  return memo('sha_maj', () => {
    const b = new Builder(8, 12, 2);
    b.maxH = 220;
    b.pins('a', 'b', 'c');
    const sa = b.op(splitter(W32), ['a']), sb = b.op(splitter(W32), ['b']), sc = b.op(splitter(W32), ['c']);
    b.next();
    for (const [sp, nm] of [[sa, 'a'], [sb, 'b'], [sc, 'c']] as const) for (let i = 0; i < 32; i++) b.name(`${sp}.o${i}`, `${nm}${i}`, true);
    const o = Array.from({ length: 32 }, (_, i) => b.op1(maj1(), [`${sa}.o${i}`, `${sb}.o${i}`, `${sc}.o${i}`]));
    o.forEach((d, i) => b.name(d, `y${i}`, true));
    b.next();
    b.wire(b.op1(merger(W32), o), 'y');
    return define({
      id: 'sha_maj', name: 'Maj (majority)', category: 'gate',
      summary: 'Maj(a, b, c) = (a ∧ b) ⊕ (a ∧ c) ⊕ (b ∧ c): each bit is what at least two of the three words hold there. Six NANDs a bit.',
      ports: [bus('a', 32, 'in'), bus('b', 32, 'in'), bus('c', 32, 'in'), bus('y', 32, 'out')], symbol: { kind: 'box', label: 'Maj' },
      spec: ([a, bb, c]) => [maj(a, bb, c)],
      netlist: () => ({ pins: { a: [0, 12], b: [0, 24], c: [0, 36], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** 32-bit sum of two drivers in `b`, the carry-in tied low (one shared tie per builder, passed as `zero`). */
const add32 = (b: Builder, x: string, y: string, zero: string, label?: string): string => b.op1(rca(32), [x, y, zero], label);

/** One round: T1 = h + Σ1(e) + Ch(e,f,g) + K + W, T2 = Σ0(a) + Maj(a,b,c); the variables shift down, a' = T1 + T2, e' = d + T1. */
export function shaRound(): ComponentDef {
  return memo('sha_round', () => {
    const b = new Builder(8, 14, 6);
    b.pins('v', 'k', 'w');
    const zero = `${b.add(TIE0, '0', 'zero')}.y`;
    const sp = b.op(splitter(words(8)), ['v']);
    const v = (i: number) => `${sp}.o${i}`; // a b c d e f g h
    b.next();
    const s1 = b.op1(bigSig1(), [v(4)]), chv = b.op1(shaCh(), [v(4), v(5), v(6)]), s0 = b.op1(bigSig0(), [v(0)]), mj = b.op1(shaMaj(), [v(0), v(1), v(2)]);
    b.next();
    const t1a = add32(b, v(7), s1, zero, 'h + Σ1'), t2 = add32(b, s0, mj, zero, 'T2');
    b.next();
    const t1b = add32(b, t1a, chv, zero, '+ Ch');
    b.next();
    const t1c = add32(b, t1b, 'k', zero, '+ K');
    b.next();
    const t1 = add32(b, t1c, 'w', zero, 'T1 = … + W');
    b.next();
    const na = add32(b, t1, t2, zero, 'a\' = T1 + T2'), ne = add32(b, v(3), t1, zero, 'e\' = d + T1');
    b.next();
    b.wire(b.op1(merger(words(8)), [na, v(0), v(1), v(2), ne, v(4), v(5), v(6)]), 'y');
    return define({
      id: 'sha_round', name: 'SHA-256 round', category: 'arithmetic',
      summary: 'One of the 64 rounds on the working variables a..h (a in the low word): two adders for T2 and a\', four for T1 and one for e\', Σ0, Σ1, Ch and Maj around them. The other six words just move one place: wiring.',
      ports: [bus('v', 256, 'in'), bus('k', 32, 'in'), bus('w', 32, 'in'), bus('y', 256, 'out')], symbol: { kind: 'box', label: 'SHA ROUND' },
      netlist: () => ({ pins: { v: [0, 12], k: [0, 24], w: [0, 36], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The schedule's recurrence: W[t] = σ1(W[t-2]) + W[t-7] + σ0(W[t-15]) + W[t-16], seen from the register: w14, w9, w1, w0. */
export function shaWnext(): ComponentDef {
  return memo('sha_wnext', () => {
    const b = new Builder(8, 14, 6);
    b.pins('w0', 'w1', 'w9', 'w14');
    const zero = `${b.add(TIE0, '0', 'zero')}.y`;
    const g1 = b.op1(smallSig1(), ['w14']), g0 = b.op1(smallSig0(), ['w1']);
    b.next();
    const a = add32(b, g1, 'w9', zero), c = add32(b, g0, 'w0', zero);
    b.next();
    b.wire(add32(b, a, c, zero), 'y');
    return define({
      id: 'sha_wnext', name: 'Message schedule step', category: 'arithmetic',
      summary: 'The next schedule word from four of the sixteen held: σ1(w14) + w9 + σ0(w1) + w0. Three adders and two sigma boxes.',
      ports: [bus('w0', 32, 'in'), bus('w1', 32, 'in'), bus('w9', 32, 'in'), bus('w14', 32, 'in'), bus('y', 32, 'out')], symbol: { kind: 'box', label: 'W NEXT' },
      spec: ([w0, w1, w9, w14]) => [(smallSigma1(w14) + w9 + smallSigma0(w1) + w0) >>> 0],
      netlist: () => ({ pins: { w0: [0, 8], w1: [0, 16], w9: [0, 24], w14: [0, 32], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** n 32-bit lanes, two buses, one select. */
export function wordMux(n: number): ComponentDef {
  return memo(`sha_muxw${n}`, () => {
    const M = busMux2(32), b = new Builder(8, 10, 10);
    b.pins('a', 'b', 's');
    const sa = b.op(splitter(words(n)), ['a']), sb = b.op(splitter(words(n)), ['b']);
    b.next();
    const o = Array.from({ length: n }, (_, i) => `${b.op(M, [`${sa}.o${i}`, `${sb}.o${i}`, 's'])}.y`);
    b.next();
    b.wire(b.op1(merger(words(n)), o), 'y');
    return define({
      id: `sha_muxw${n}`, name: `${32 * n}-bit 2:1 multiplexer`, category: 'routing',
      summary: `Chooses between two ${32 * n}-bit buses, word by word, with one shared select.`,
      ports: [bus('a', 32 * n, 'in'), bus('b', 32 * n, 'in'), bit('s', 'in', 'bottom'), bus('y', 32 * n, 'out')], symbol: { kind: 'mux' },
      netlist: () => ({ pins: { a: [0, 12], b: [0, 24], s: [0, 36], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The 16-word message schedule register. ld = 1 loads the block (word 0 into w0); each enabled clock after that shifts one
 * place and puts σ1(w14) + w9 + σ0(w1) + w0 into w15, so w0 is W[t] in round t and the sixteen words are all it ever holds.
 */
export function shaSchedule(): ComponentDef {
  return memo('sha_sched', () => {
    const b = new Builder(8, 14, 3);
    b.maxH = 400;
    b.pins('blk', 'ld', 'en', 'clk');
    const sp = b.op(splitter(words(16)), ['blk']);
    b.next();
    const M = busMux2(32), R = register(32);
    for (let i = 0; i < 16; i++) b.add(M, `w${i} next`, `m${i}`);
    b.next();
    for (let i = 0; i < 16; i++) b.add(R, `w${i}`, `r${i}`);
    b.next();
    const nx = b.op(shaWnext(), ['r0.q', 'r1.q', 'r9.q', 'r14.q'], 'new word', 'nx');
    for (let i = 0; i < 16; i++) {
      b.wire(i < 15 ? `r${i + 1}.q` : `${nx}.y`, `m${i}.a`);
      b.wire(`${sp}.o${i}`, `m${i}.b`);
      b.wire('ld', `m${i}.s`);
      b.wire(`m${i}.y`, `r${i}.d`);
      b.wire('en', `r${i}.en`);
      b.wire('clk', `r${i}.clk`);
    }
    b.wire('r0.q', 'w');
    return define({
      id: 'sha_sched', name: 'Message schedule (shift register)', category: 'sequential',
      summary: 'Sixteen 32-bit registers in a row. Load the block with ld; every enabled clock shifts them down one place and refills the top from the recurrence. The word on w is W[t] in round t: the other 48 words are never stored.',
      ports: [bus('blk', 512, 'in'), bit('ld', 'in'), bit('en', 'in'), clk(), bus('w', 32, 'out')], symbol: { kind: 'box', label: 'W SCHEDULE' },
      netlist: () => ({ pins: { blk: [0, 12], ld: [0, 24], en: [0, 36], clk: [0, 48], w: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The 64 round constants as gates: a 6 → 64 decoder, then an OR plane (per output bit the OR of the lines where K has a 1, or the NOR of the others, whichever is smaller). */
export function shaK(): ComponentDef {
  return memo('sha_k', () => {
    const b = new Builder(8, 14, 3);
    b.maxH = 1200;
    b.pins('t');
    const dec = b.op(decoder(6), ['t'], '6 → 64');
    b.next();
    const outs: string[] = [];
    for (let j = 0; j < 32; j++) {
      const on: number[] = [], off: number[] = [];
      K.forEach((k, t) => (((k >>> j) & 1 ? on : off).push(t)));
      const useOn = on.length <= off.length, lines = useOn ? on : off;
      const o = b.op(orN(lines.length), [], `K bit ${j}`);
      lines.forEach((t, i) => b.wire(`${dec}.y${t}`, `${o}.i${i}`));
      outs.push(useOn ? `${o}.y` : b.op1(NOT, [`${o}.y`]));
    }
    b.next();
    b.wire(b.op1(merger(W32), outs), 'k');
    return define({
      id: 'sha_k', name: 'SHA-256 round constants', category: 'routing',
      summary: 'K[t] for t = 0..63, the first 32 bits of the fractional parts of the cube roots of the first 64 primes, as a 64-line decoder feeding one OR gate per output bit. A ROM drawn in gates.',
      ports: [bus('t', 6, 'in'), bus('k', 32, 'out')], symbol: { kind: 'box', label: 'K[t]' },
      spec: ([t]) => [K[t]],
      netlist: () => ({ pins: { t: [0, 12], k: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The iterative compression function. start = 1 at a rising edge loads the chaining value h and the block (the working variables
 * a..h take h); each of the next 64 edges is a round. done goes high with out = h + a..h (the feed-forward, combinational) and
 * stays until the next start. 65 clocks from start to done. h and blk must be valid at start (they are copied).
 */
export function shaCore(): ComponentDef {
  return memo('sha_core', () => {
    const b = new Builder(26, 16, 6);
    b.pins('clk', 'rst', 'start', 'h', 'blk');
    const cs = b.op(splitter(ones(6)), ['CNT.q'], '', 'cs');
    const last = b.op1(andN(6), outOf(cs, 6), 'round 63', 'last');
    const run = b.op1(OR, ['start', 'busy.q'], 'start | busy', 'run');
    const nlast = b.op1(NOT, [last]), keep = b.op1(AND, ['busy.q', nlast]), finish = b.op1(AND, ['busy.q', last]);
    const nrst = b.op1(NOT, ['rst']), nstart = b.op1(NOT, ['start']);
    const busyD = b.op1(AND, [b.op1(OR, ['start', keep]), nrst], 'busy next');
    const doneD = b.op1(AND, [b.op1(AND, [b.op1(OR, ['done.q', finish]), nstart]), nrst], 'done next');
    b.next();
    b.add(register(256), 'a..h', 'V');
    b.add(register(256), 'chaining value', 'H');
    b.add(clearableRegister(6), 'round counter', 'CNT');
    b.add(DFF, 'busy', 'busy');
    b.add(DFF, 'done', 'done');
    b.next();
    const sched = b.op(shaSchedule(), ['blk', 'start', run, 'clk'], 'message schedule', 'sched');
    const kk = b.op(shaK(), ['CNT.q'], 'K[t]', 'kk');
    const inc = b.op(incrementer(6), ['CNT.q'], '+ 1', 'inc');
    b.next();
    const rd = b.op(shaRound(), ['V.q', `${kk}.k`, `${sched}.w`], 'round', 'rd');
    b.next();
    const vm = b.op(wordMux(8), [`${rd}.y`, 'h', 'start'], 'start: load h', 'vm');
    const zero = `${b.add(TIE0, '0', 'zero')}.y`;
    const sv = b.op(splitter(words(8), 10), ['V.q'], '', 'sv'), sh = b.op(splitter(words(8), 10), ['H.q'], '', 'sh');
    b.next();
    const sums = Array.from({ length: 8 }, (_, i) => add32(b, `${sh}.o${i}`, `${sv}.o${i}`, zero));
    b.next();
    b.wire(`${vm}.y`, 'V.d'); b.wire(run, 'V.en'); b.wire('clk', 'V.clk');
    b.wire('h', 'H.d'); b.wire('start', 'H.en'); b.wire('clk', 'H.clk');
    b.wire(`${inc}.y`, 'CNT.d'); b.wire('busy.q', 'CNT.en'); b.wire('start', 'CNT.clr'); b.wire('clk', 'CNT.clk');
    b.wire(busyD, 'busy.d'); b.wire('clk', 'busy.clk'); b.wire(doneD, 'done.d'); b.wire('clk', 'done.clk');
    b.wire(b.op1(merger(words(8), 10), sums, 'h + a..h'), 'out'); b.wire('done.q', 'done');
    // Drawn as a schematic: the datapath (V → round → mux → V) on top, the control chains in rows of gates whose outputs meet the next
    // gate's input on the same line, the eight adders in a column at the splitter's pitch, the sum merger beside them.
    const at: Record<string, [number, number]> = {
      V: [12, 0], kk: [26, 8], sched: [10, 12], rd: [40, 4], vm: [56, 6], zero: [66, 16],
      H: [12, 26], CNT: [12, 36], inc: [14, 48], cs: [30, 34], last: [34, 34], run: [36, 56],
      u0: [42, 39], u1: [47, 37], u5: [58, 36], u6: [65, 37], busy: [80, 37],
      u2: [42, 48], u7: [54, 47], u8: [61, 48], u9: [70, 49], done: [80, 49], u3: [58, 43], u4: [54, 54],
      sv: [102, 1], sh: [110, -1],
    };
    sums.forEach((_, i) => (at[`u${10 + i}`] = [118, 10 * i + 2]));
    at.u18 = [132, 0];
    for (const i of b.instances) if (at[i.name]) i.at = at[i.name];
    // the wide pins' bars run to the left of the pin, the output's to the right: kept over and under the drawing, not beside it
    const pins: Record<string, [number, number]> = { clk: [4, 50], rst: [4, 55], start: [4, 60], h: [122, -4], blk: [122, -8], out: [60, 86], done: [91, 52] };
    const outVia = [[135, 40], [135, 84], [60, 84]] as [number, number][];
    b.name('V.q', 'vars_q'); b.name('H.q', 'chain_q'); b.name('CNT.q', 'cnt_q'); b.name('done.q', 'done_q'); b.name('busy.q', 'busy_q');
    return define({
      id: 'sha_core', name: 'SHA-256 compression core', category: 'sequential',
      summary: 'One SHA-256 round a clock: the working variables a..h, the chaining value, the 16-word schedule register, a 6-bit round counter and the constants in gates. 65 clocks from start to done; out = h + a..h.',
      ports: [clk(), bit('rst', 'in'), bit('start', 'in'), bus('h', 256, 'in'), bus('blk', 512, 'in'), bus('out', 256, 'out'), bit('done', 'out')],
      symbol: { kind: 'box', label: 'SHA-256' },
      netlist: () => ({
        pins, pinDirs: { out: 'up' as const }, instances: b.instances,
        nets: b.nets().map((n) => {
          // wires where the sink is near, a pointer for the far ends
          const near: Record<string, string[] | true> = { done_q: ['u7.a'], vars_q: ['sv.in'], cnt_q: ['kk.t', 'inc.a'], chain_q: true };
          if (n.ends[n.ends.length - 1] === 'out') return { ...n, via: { out: outVia } };
          const byDriver: Record<string, string[]> = { 'last.y': ['u2.b'], 'u3.y': ['u9.b'] };
          if (byDriver[n.ends[0]]) return { ...n, tags: byDriver[n.ends[0]] };
          return n.name && near[n.name] ? { ...n, tags: near[n.name] } : n;
        }),
      }),
    });
  });
}

const outOf = (sp: string, n: number) => Array.from({ length: n }, (_, i) => `${sp}.o${i}`);
