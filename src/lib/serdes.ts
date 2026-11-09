// Chapter noise's parts: the line codes in gates (Manchester, 8b/10b, the self-synchronizing scrambler), a sender whose bit clock is a
// phase accumulator, a serializer, a line (a model: delay and an error stream), a receiver that finds the bit clock in the data
// (an Alexander bang-bang phase detector, a vote filter and a strobe counter) and a deserializer that aligns on the comma.
// Everything runs on ONE clock; the sender's bit rate is a number of that clock (comm/serdes.ts), so the two ends are unrelated at the
// bit level, and the receiver has only the line. Each block has a DOM-free golden model (comm/linecode.ts, comm/serdes.ts).

import type { ComponentDef, PortDef } from '../sim/types';
import { classOf, dec4, dec6, encode4, encode6, type Rd } from '../comm/linecode';
import { CYCLES_PER_BIT, FILTER_LIMIT, NCO_BITS } from '../comm/serdes';
import { Builder } from './builder';
import { andN, busMux2, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XNOR, XOR } from './gates';
import { counter, DFF, DFFE, register } from './sequential';
import { cover } from './sop';
import { TIE0, TIE1 } from './transistors';
import { constWord } from './alu';
import { orN } from './wide';
import { randomSource } from './seqparts';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const port = (name: string, width: number, dir: 'in' | 'out'): PortDef => (width === 1 ? bit(name, dir) : bus(name, width, dir));
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Pin positions: inputs down the left edge, outputs down the right. */
function pinsOf(ins: PortDef[], outs: PortDef[], R: number, pitch = 4): Record<string, [number, number]> {
  return { ...Object.fromEntries(ins.map((p, i) => [p.name, [0, 2 + pitch * i]])), ...Object.fromEntries(outs.map((p, j) => [p.name, [R, 2 + pitch * j]])) };
}

// ---- combinational blocks drawn from a table ---------------------------------------------------------------------------------

interface TPort { name: string; width: number }

/**
 * A combinational block from its function: every input combination is a row, each output bit minimized to a sum of products
 * (lib/sop.ts), inverters, AND gates per term, an OR per output. fn takes the input ports' values in order and returns the output
 * ports' values. Without `care`, fn is the whole spec; with it, a row and output it calls false are don't-cares (the logic is
 * smaller, and the block has no `spec`: only the cared-about rows are defined).
 */
export function tableBlock(id: string, name: string, summary: string, ins: TPort[], outs: TPort[], fn: (v: number[]) => number[], label = 'TABLE', care?: (v: number[], out: number) => boolean): ComponentDef {
  // The minimization runs on the first netlist() call, not when the module is evaluated: every chapter loads this module,
  // and the tables of all its blocks took about 300 ms of the first load.
  const inP = ins.map((p) => port(p.name, p.width, 'in')), outP = outs.map((p) => port(p.name, p.width, 'out'));
  const draw = () => {
    const n = ins.reduce((a, p) => a + p.width, 0), rows = 1 << n, nOut = outs.reduce((a, p) => a + p.width, 0);
    const onSets: number[][] = Array.from({ length: nOut }, () => []), dcSets: number[][] = Array.from({ length: nOut }, () => []);
    for (let m = 0; m < rows; m++) {
      let sh = 0;
      const v = ins.map((p) => { const x = (m >> sh) & ((1 << p.width) - 1); sh += p.width; return x; });
      const o = fn(v);
      let ob = 0;
      outs.forEach((p, j) => { for (let k = 0; k < p.width; k++) { if (care && !care(v, j)) dcSets[ob + k].push(m); else if ((o[j] >> k) & 1) onSets[ob + k].push(m); } ob += p.width; });
    }
    const b = new Builder(22, 18, 4);
    b.pins(...ins.map((p) => p.name));
    const src: string[] = [];
    for (const p of ins) {
      if (p.width === 1) src.push(p.name);
      else {
        const sp = b.op(splitter(ones(p.width)), [p.name], undefined, `sp_${p.name}`);
        for (let j = 0; j < p.width; j++) src.push(`${sp}.o${j}`);
      }
    }
    b.next();
    const covers = onSets.map((on, i) => (on.length === 0 || on.length + dcSets[i].length === rows ? null : cover(n, on, dcSets[i])));
    const needNeg = new Set<number>();
    covers.forEach((c) => c?.terms.forEach((t) => { for (let i = 0; i < n; i++) if (!(t.mask & (1 << i)) && !(t.val & (1 << i))) needNeg.add(i); }));
    const varName = (i: number) => { let k = i; for (const p of ins) { if (k < p.width) return p.width === 1 ? p.name : `${p.name}[${k}]`; k -= p.width; } return `x${i}`; };
    const neg = new Map<number, string>();
    for (const i of needNeg) neg.set(i, b.name(b.op1(NOT, [src[i]], `¬${varName(i)}`), `${varName(i)}_n`, true));
    b.next();
    const chunks = <T>(xs: T[], k: number): T[][] => { const o: T[][] = []; for (let i = 0; i < xs.length; i += k) o.push(xs.slice(i, i + k)); return o; };
    const andOf = (ds: string[], l?: string): string => (ds.length === 1 ? ds[0] : ds.length === 2 ? b.op1(AND, ds, l) : ds.length <= 8 ? b.op1(andN(ds.length), ds, l) : andOf(chunks(ds, 8).map((c) => andOf(c)), l));
    const orOf = (ds: string[], l?: string): string => (ds.length === 1 ? ds[0] : ds.length === 2 ? b.op1(OR, ds, l) : ds.length <= 4 ? b.op1(orN(ds.length), ds, l) : orOf(chunks(ds, 4).map((c) => orOf(c)), l));
    const termOf = new Map<string, string>();
    const termGate = (t: { val: number; mask: number }): string => {
      const key = `${t.val}/${t.mask}`;
      let d = termOf.get(key);
      if (d) return d;
      const lits: string[] = [], txt: string[] = [];
      for (let i = 0; i < n; i++) if (!(t.mask & (1 << i))) { const pos = !!(t.val & (1 << i)); lits.push(pos ? src[i] : neg.get(i)!); txt.push(pos ? varName(i) : `¬${varName(i)}`); }
      d = lits.length === 0 ? b.op1(TIE1, []) : andOf(lits, txt.join('·'));
      termOf.set(key, d);
      return d;
    };
    const sums = covers.map((c) => (c ? c.terms.map(termGate) : null));
    let k = 0;
    if (termOf.size > 8) for (const d of new Set(termOf.values())) if (d.includes('.')) b.name(d, `t${k++}`, true);
    b.next();
    const drivers = sums.map((s, i) => (s ? orOf(s) : b.op1(onSets[i].length ? TIE1 : TIE0, [])));
    b.next();
    let ob = 0;
    for (const p of outs) {
      if (p.width === 1) b.wire(drivers[ob], p.name);
      else b.wire(b.op1(merger(ones(p.width)), drivers.slice(ob, ob + p.width), undefined, `mg_${p.name}`), p.name);
      ob += p.width;
    }
    const R = Math.max(b.right, 30);
    return { pins: pinsOf(inP, outP, R), instances: b.instances, nets: b.nets() };
  };
  return memo(id, () => {
    let built: ReturnType<typeof draw> | undefined;
    return define({
      id, name, category: 'gate', summary,
      ports: [...inP, ...outP], symbol: { kind: 'box', label },
      ...(care ? {} : { spec: (v: number[]) => fn(v) }),
      netlist: () => (built ??= draw()),
    });
  });
}

// ---- 8b/10b -------------------------------------------------------------------------------------------------------------------

/** The x that can be a control code: K28, and K23, K27, K29, K30 with y = 7. */
const K_X = [23, 27, 28, 29, 30];

/** 5b/6b encoder: x = EDCBA, k, rd → abcdei, the disparity flip, and the two classes of x that may take the alternate 7. */
export const ENC56 = tableBlock('enc56', '5b/6b encoder', 'The 8b/10b code\'s first half: the 5 low bits and the running disparity choose six bits; K28 is the one control 6b block. Also reports whether the block changes the disparity and which x may take the alternate 7 (D.17, D.18, D.20 after RD−; D.11, D.13, D.14 after RD+).',
  [{ name: 'x', width: 5 }, { name: 'k', width: 1 }, { name: 'rd', width: 1 }],
  [{ name: 'six', width: 6 }, { name: 'flip', width: 1 }, { name: 'a0', width: 1 }, { name: 'a1', width: 1 }],
  ([x, k, rd]) => {
    const six = encode6(x, !!k, rd as Rd), c = classOf(x);
    return [six, popBalance(six, 6), c.xa0, c.xa1];
  }, '5B/6B', ([x, k]) => !k || K_X.includes(x));

/** 3b/4b encoder: y = HGF, k, the disparity after the 6b block, and the alternate-7 classes → fghj and the flip. */
export const ENC34 = tableBlock('enc34', '3b/4b encoder', 'The code\'s second half: the 3 high bits, read at the running disparity after the 6b block. D.x.7 takes the alternate 7 where the primary would make a run of five.',
  [{ name: 'y', width: 3 }, { name: 'k', width: 1 }, { name: 'rd', width: 1 }, { name: 'a0', width: 1 }, { name: 'a1', width: 1 }],
  [{ name: 'four', width: 4 }, { name: 'flip', width: 1 }],
  ([y, k, rd, a0, a1]) => {
    const x = a0 ? 17 : a1 ? 11 : 0, four = encode4(y, !!k, rd as Rd, x);
    return [four, popBalance(four, 4)];
  }, '3B/4B', ([, k, , a0, a1]) => !(a0 && a1) && !(k && (a0 || a1)));

function popBalance(code: number, n: number): number {
  let ones = 0;
  for (let i = 0; i < n; i++) ones += (code >> i) & 1;
  return ones * 2 === n ? 0 : 1;
}

/** The 8b/10b encoder: byte, k and the running disparity in, ten bits (a first, bit 9) and the disparity after out. */
export const ENC8B10B = memo('enc8b10b', () => {
  const b = new Builder(10, 12);
  b.pins('d', 'k', 'rd');
  const sp = b.op(splitter([5, 3]), ['d'], undefined, 'sp');
  b.next();
  const e6 = b.op(ENC56, [`${sp}.o0`, 'k', 'rd'], '5b/6b', 'e6');
  b.next();
  const rd1 = b.op1(XOR, ['rd', `${e6}.flip`], 'disparity after the 6b block');
  b.name(rd1, 'rd1', true);
  b.next();
  const e4 = b.op(ENC34, [`${sp}.o1`, 'k', rd1, `${e6}.a0`, `${e6}.a1`], '3b/4b', 'e4');
  b.next();
  const rdo = b.op1(XOR, [rd1, `${e4}.flip`], 'disparity after the byte');
  b.wire(rdo, 'rdout');
  b.wire(b.op1(merger([4, 6]), [`${e4}.four`, `${e6}.six`], undefined, 'mg'), 'code');
  const R = b.right;
  const ins = [bus('d', 8, 'in'), bit('k', 'in'), bit('rd', 'in')], outs = [bus('code', 10, 'out'), bit('rdout', 'out')];
  return define({
    id: 'enc8b10b', name: '8b/10b encoder', category: 'gate',
    summary: 'A byte (or one of twelve control codes) becomes ten bits with at most five equal in a row and a running disparity that stays within one: a 5b/6b table, a 3b/4b table, and an XOR for each disparity change.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: '8B/10B' },
    notes: 'No spec: a control flag on a byte that is not one of the twelve control codes is a do not care row.',
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

/** 6b/5b decoder: abcdei and the running disparity → x, K28, the x classes, bad (not legal at this disparity), the disparity after. */
export const DEC56 = tableBlock('dec56', '6b/5b decoder', 'The decoder\'s first half. A 6b block that is legal only at the other disparity decodes to its x with bad = 1; K28 is accepted at either (a comma tells the receiver where the running disparity stands).',
  [{ name: 'six', width: 6 }, { name: 'rd', width: 1 }],
  [{ name: 'x', width: 5 }, { name: 'k28', width: 1 }, { name: 'xk', width: 1 }, { name: 'a0', width: 1 }, { name: 'a1', width: 1 }, { name: 'bad', width: 1 }, { name: 'rd1', width: 1 }],
  ([six, rd]) => { const r = dec6(six, rd as Rd); return [r.x, r.k28, r.xk, r.xa0, r.xa1, r.bad, r.rd1]; }, '6B/5B',
  ([six, rd], j) => j >= 5 || !dec6(six, rd as Rd).bad);

/** 4b/3b decoder. */
export const DEC34 = tableBlock('dec34', '4b/3b decoder', 'The decoder\'s second half: fghj read at the disparity after the 6b block, with what the 6b block said about x. K.x.7 is told from D.x.7 by the alternate 7 behind a K-able x.',
  [{ name: 'four', width: 4 }, { name: 'rd', width: 1 }, { name: 'k28', width: 1 }, { name: 'xk', width: 1 }, { name: 'a0', width: 1 }, { name: 'a1', width: 1 }],
  [{ name: 'y', width: 3 }, { name: 'kseven', width: 1 }, { name: 'bad', width: 1 }, { name: 'flip', width: 1 }],
  ([four, rd, k28, xk, a0, a1]) => { const r = dec4(four, rd as Rd, k28, xk, a0, a1); return [r.y, r.kseven, r.bad, r.flip]; }, '4B/3B',
  ([four, rd, k28, xk, a0, a1], j) => !(a0 && a1) && !(k28 && (xk || a0 || a1)) && !(xk && (a0 || a1)) && (j >= 2 || !dec4(four, rd as Rd, k28, xk, a0, a1).bad));

/** The 8b/10b decoder: ten bits and the running disparity in; byte, k, err (not a legal code at this disparity) and the disparity after. */
export const DEC8B10B = memo('dec8b10b', () => {
  const b = new Builder(10, 12);
  b.pins('code', 'rd');
  const sp = b.op(splitter([4, 6]), ['code'], undefined, 'sp');
  b.next();
  const d6 = b.op(DEC56, [`${sp}.o1`, 'rd'], '6b/5b', 'd6');
  b.next();
  const d4 = b.op(DEC34, [`${sp}.o0`, `${d6}.rd1`, `${d6}.k28`, `${d6}.xk`, `${d6}.a0`, `${d6}.a1`], '4b/3b', 'd4');
  b.next();
  b.wire(b.op1(merger([5, 3]), [`${d6}.x`, `${d4}.y`], undefined, 'mg'), 'd');
  b.wire(b.op1(OR, [`${d6}.k28`, `${d4}.kseven`], 'K28 or K.x.7'), 'k');
  b.wire(b.op1(OR, [`${d6}.bad`, `${d4}.bad`], 'illegal here'), 'err');
  b.wire(b.op1(XOR, [`${d6}.rd1`, `${d4}.flip`], 'disparity after'), 'rdout');
  const R = b.right;
  const ins = [bus('code', 10, 'in'), bit('rd', 'in')], outs = [bus('d', 8, 'out'), bit('k', 'out'), bit('err', 'out'), bit('rdout', 'out')];
  return define({
    id: 'dec8b10b', name: '8b/10b decoder', category: 'gate',
    summary: 'Ten bits back to a byte and a control flag, and an error flag for any code that is not legal at the running disparity: a corrupted bit shows as a code error, or a disparity error a word or two later.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: '10B/8B' },
    notes: 'No spec: on a code that is no 8b/10b code the byte and k are do not cares; err is exact.',
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

// ---- Manchester -------------------------------------------------------------------------------------------------------------

/** Manchester encoder: line = XNOR(bit, half). A 1 is low then high (half 0 then 1), a 0 is high then low. */
export const MANCH_ENC = define({
  id: 'manch_enc', name: 'Manchester encoder', category: 'gate',
  summary: 'One XNOR: the line is the bit XNOR the half-bit clock. A 1 goes low then high, a 0 high then low; every bit has a transition in the middle.',
  ports: [bit('d', 'in'), bit('half', 'in'), bit('line', 'out')], symbol: { kind: 'box', label: 'MANCH' },
  spec: ([d, half]) => [1 ^ d ^ half],
  netlist: () => ({ pins: { d: [0, 2], half: [0, 6], line: [10, 4] }, instances: [{ name: 'x', def: XNOR, at: [2, 1] }], nets: [{ ends: ['d', 'x.a'] }, { ends: ['half', 'x.b'] }, { ends: ['x.y', 'line'] }] }),
});

/** Manchester decoder: the bit is the second half; the halves must differ. */
export const MANCH_DEC = define({
  id: 'manch_dec', name: 'Manchester decoder', category: 'gate',
  summary: 'Two samples, one from each half of the bit: the bit is the second, and equal halves (no mid-bit transition) are an error: one XNOR.',
  ports: [bit('h1', 'in'), bit('h2', 'in'), bit('d', 'out'), bit('err', 'out')], symbol: { kind: 'box', label: 'UNMANCH' },
  spec: ([h1, h2]) => [h2, 1 ^ h1 ^ h2],
  netlist: () => ({ pins: { h1: [0, 2], h2: [0, 8], d: [12, 2], err: [12, 8] }, instances: [{ name: 'x', def: XNOR, at: [3, 4] }], nets: [{ ends: ['h1', 'x.a'] }, { ends: ['h2', 'x.b', 'd'] }, { ends: ['x.y', 'err'] }] }),
});

// ---- the self-synchronizing scrambler -----------------------------------------------------------------------------------------

function scrambleBlock(descramble: boolean, taps: [number, number]): ComponentDef {
  const n = Math.max(...taps), id = `${descramble ? 'descr' : 'scr'}_${taps[0]}_${taps[1]}`;
  return memo(id, () => {
    const b = new Builder(10, 12);
    b.pins('d', 'en', 'clk');
    // the register holds what was sent (scrambler) or received (descrambler); stage i is the bit i + 1 steps back
    const stage: string[] = [];
    for (let i = 0; i < n; i++) stage.push(`s${i}.q`);
    const x1 = b.op1(XOR, ['d', stage[taps[0] - 1]], `⊕ x^${taps[0]}`);
    b.next();
    const out = b.op1(XOR, [x1, stage[taps[1] - 1]], `⊕ x^${taps[1]}`);
    b.next();
    const feed = descramble ? 'd' : out;
    for (let i = 0; i < n; i++) {
      const s = b.op(DFFE, [i === 0 ? feed : stage[i - 1], 'en', 'clk'], `${i + 1} ago`, `s${i}`);
      b.name(`${s}.q`, `h${i + 1}`, true);
      if (i % 4 === 3) b.next();
    }
    b.wire(out, 'q');
    const R = b.right;
    const ins = [bit('d', 'in'), bit('en', 'in'), clk()], outs = [bit('q', 'out')];
    return define({
      id, name: `${descramble ? 'De-s' : 'S'}crambler x^${taps[1]} + x^${taps[0]} + 1`, category: 'sequential',
      summary: descramble
        ? `Out = in ⊕ (the bit received ${taps[0]} ago) ⊕ (the one ${taps[1]} ago): ${n} flip-flops of received bits and two XORs. It needs no reset: after ${n} bits it is right whatever it held, and a wrong bit on the line is three wrong bits out.`
        : `Out = in ⊕ (the bit sent ${taps[0]} ago) ⊕ (the one ${taps[1]} ago), and the output goes back into the register: ${n} flip-flops and two XORs. Its output looks random whatever goes in, but an all-zero register with all-zero input stays zero.`,
      ports: [...ins, ...outs], symbol: { kind: 'box', label: descramble ? 'DESCR' : 'SCRAM' },
      netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
    });
  });
}
export const scrambler = (taps: [number, number] = [6, 7]): ComponentDef => scrambleBlock(false, taps);
export const descrambler = (taps: [number, number] = [6, 7]): ComponentDef => scrambleBlock(true, taps);

// ---- the sender -------------------------------------------------------------------------------------------------------------

/** The sender's bit clock: acc += inc each cycle; the carry out of the 12-bit sum is the tick. inc = 1024 ticks every 4 cycles. */
export const BIT_NCO = memo('nco12', () => {
  const b = new Builder(10, 12);
  b.pins('inc', 'clk');
  const zero = b.op1(TIE0, []), one = b.op1(TIE1, []);
  b.next();
  const add = b.op(rca(NCO_BITS), ['acc.q', 'inc', zero], 'acc + inc');
  b.next();
  const acc = b.op(register(NCO_BITS), [`${add}.s`, one, 'clk'], 'phase accumulator', 'acc');
  b.name(`${acc}.q`, 'acc', true);
  b.wire(`${add}.cout`, 'tick');
  const R = b.right;
  const ins = [bus('inc', NCO_BITS, 'in'), clk()], outs = [bit('tick', 'out')];
  return define({
    id: 'nco12', name: 'Bit-clock accumulator', category: 'sequential',
    summary: `A ${NCO_BITS}-bit phase accumulator: every cycle it adds inc, and the carry out is a tick. inc = ${1 << (NCO_BITS - 2)} gives a tick every ${CYCLES_PER_BIT} cycles; ${1 << (NCO_BITS - 2)} + 1 is 1/${1 << NCO_BITS} faster than that. It stands for the sender's own oscillator, which the receiver does not share.`,
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'NCO' },
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

/** Bit count 0 … 9 and "last": the serializer's counter step as a table. */
const CNT10 = tableBlock('cnt10', 'Mod-10 count step', 'cnt + 1 modulo 10, and last = 1 when cnt is 9.',
  [{ name: 'cnt', width: 4 }], [{ name: 'next', width: 4 }, { name: 'last', width: 1 }],
  ([c]) => (c === 9 ? [0, 1] : c < 9 ? [c + 1, 0] : [0, 0]), 'MOD10');

/** The serializer: a 10-bit shift register, MSB first. On each tick it shifts; after the tenth it loads the next word and says so (wload). */
export const SERIALIZER10 = memo('ser10', () => {
  const b = new Builder(10, 12);
  b.pins('word', 'tick', 'clk');
  const zero = b.op1(TIE0, []);
  b.next();
  const ct = b.op(CNT10, ['cnt.q'], 'count step', 'ct');
  const ssp = b.op(splitter(ones(10)), ['sr.q'], undefined, 'ssp');
  b.next();
  const shifted = b.op1(merger(ones(10)), [zero, ...Array.from({ length: 9 }, (_, i) => `${ssp}.o${i}`)], 'shifted left', 'shf');
  b.next();
  const mx = b.op1(busMux2(10), [shifted, 'word', `${ct}.last`], 'last bit? take the next word', 'mx');
  b.next();
  const sr = b.op(register(10), [mx, 'tick', 'clk'], 'shift register', 'sr');
  const cnt = b.op(register(4), [`${ct}.next`, 'tick', 'clk'], 'bit count', 'cnt');
  b.name(`${sr}.q`, 'sr', true); b.name(`${cnt}.q`, 'cnt', true);
  b.wire(`${ssp}.o9`, 'txd');
  b.wire(b.op1(AND, ['tick', `${ct}.last`], 'tick on the last bit'), 'wload');
  const R = b.right;
  const ins = [bus('word', 10, 'in'), bit('tick', 'in'), clk()], outs = [bit('txd', 'out'), bit('wload', 'out')];
  return define({
    id: 'ser10', name: '10-bit serializer', category: 'sequential',
    summary: 'Ten flip-flops that shift left on each tick, the top one the line. After the tenth bit the next tick loads the next word instead (wload tells the encoder to present one), so the line never idles.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'SER10' },
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

/** The whole sender: bit-clock accumulator and serializer. */
export const SER_TX = memo('sertx', () => {
  const b = new Builder(10, 12);
  b.pins('inc', 'word', 'clk');
  const nco = b.op(BIT_NCO, ['inc', 'clk'], 'bit clock', 'nco');
  b.next();
  const ser = b.op(SERIALIZER10, ['word', `${nco}.tick`, 'clk'], 'serializer', 'ser');
  b.next();
  b.wire(`${ser}.txd`, 'txd'); b.wire(`${ser}.wload`, 'wload');
  const R = b.right;
  const ins = [bus('inc', NCO_BITS, 'in'), bus('word', 10, 'in'), clk()], outs = [bit('txd', 'out'), bit('wload', 'out')];
  return define({
    id: 'sertx', name: 'Serial sender', category: 'sequential',
    summary: 'A bit-clock accumulator ticking the serializer: one bit per tick, 4 cycles a bit at inc = 1024. wload pulses in the cycle the next word is taken.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'TX' },
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

// ---- the line ---------------------------------------------------------------------------------------------------------------

interface LineState { q: number[]; clk: number; inp: number; err: number }

/** A line of `delay` cycles: out(t) = in(t − delay), the bit flipped where err = 1 as it enters. A model, not gates: the one box in the link that does not end in transistors. */
export function serialLine(delay: number): ComponentDef {
  return memo(`serline${delay}`, () => define({
    id: `serline${delay}`, name: `Line (${delay} cycles)`, category: 'memory',
    summary: `A serial line: the bit that entered ${delay} cycles ago comes out, flipped if err was 1 as it entered. It stands for the channel of phys/line.ts; opened, the stage shows its eye diagram, not transistors.`,
    ports: [bit('in', 'in'), bit('err', 'in'), clk(), bit('out', 'out')], symbol: { kind: 'box', label: 'LINE' }, modelPanel: 'serial',
    behavior: {
      delay: 1,
      seq: { clk: 'clk', comb: [] },
      init: (): LineState => ({ q: Array(delay).fill(0), clk: 0, inp: 0, err: 0 }),
      eval: ([inp, err, c], st) => {
        const s = st as LineState, k = c < 0 ? 2 : c;
        if (k !== 1) { s.inp = inp; s.err = err; }
        if (s.clk === 0 && k === 1) { s.q.push(s.inp < 0 || s.err < 0 ? 0 : s.inp ^ s.err); s.q.shift(); }
        s.clk = k;
        return [s.q[0]];
      },
      carry: (prev) => prev,
    },
  }));
}

// ---- the receiver -----------------------------------------------------------------------------------------------------------

const signed3 = (f: number): number => (f >= 4 ? f - 8 : f);

/** The strobe counter and vote filter as a table: c counts down to 0 (a strobe), then reloads 3, 4 (delay: a 5-cycle bit) or 2 (advance: a 3-cycle bit). */
export const CDR_CTL = tableBlock('cdrctl', 'Strobe counter and vote filter', `c counts down to 0; at 0 the strobe fires, the filter f moves by the vote (early +1, late −1), and at ±${FILTER_LIMIT} the next period is 5 or 3 cycles and f clears. Otherwise the period is 4.`,
  [{ name: 'c', width: 3 }, { name: 'f', width: 3 }, { name: 'early', width: 1 }, { name: 'late', width: 1 }],
  [{ name: 'cn', width: 3 }, { name: 'fn', width: 3 }, { name: 'strobe', width: 1 }],
  ([c, f, e, l]) => {
    if (c !== 0) return [(c - 1) & 7, f, 0];
    const g = signed3(f) + e - l;
    if (g >= FILTER_LIMIT) return [4, 0, 1];
    if (g <= -FILTER_LIMIT) return [2, 0, 1];
    return [3, g & 7, 1];
  }, 'CDR CTL');

/**
 * Clock and data recovery. The line is sampled every cycle into x0 (newest) … x4. An Alexander (bang-bang) detector reads three of
 * them at a strobe: the data sample now (x0), the edge sample two before (x2) and the data sample before that (x4). If data changed
 * and the edge sample still shows the old value, the strobe is early; if it already shows the new one, late.
 */
export const CDR = memo('cdr', () => {
  const b = new Builder(10, 12);
  b.pins('rxd', 'clk');
  const xs: string[] = [];
  let prev = 'rxd';
  for (let i = 0; i < 5; i++) {
    const f = b.op(DFF, [prev, 'clk'], i === 0 ? 'sample' : `${i} ago`, `x${i}`);
    xs.push(`${f}.q`); prev = `${f}.q`;
    b.name(`${f}.q`, `x${i}`, true);
  }
  b.next();
  const trans = b.op1(XOR, [xs[0], xs[4]], 'data changed?');
  const xe = b.op1(XOR, [xs[2], xs[4]], 'edge sample differs from the old data?');
  const xne = b.op1(XNOR, [xs[2], xs[4]], 'edge sample still shows the old data?');
  b.next();
  const early = b.op1(AND, [trans, xne], 'early');
  const late = b.op1(AND, [trans, xe], 'late');
  b.name(early, 'early', true); b.name(late, 'late', true);
  b.next();
  const ctl = b.op(CDR_CTL, ['c.q', 'f.q', early, late], 'strobe counter, vote filter', 'ctl');
  b.next();
  const one = b.op1(TIE1, []);
  const c = b.op(register(3), [`${ctl}.cn`, one, 'clk'], 'strobe counter', 'c');
  const f = b.op(register(3), [`${ctl}.fn`, one, 'clk'], 'vote filter', 'f');
  b.name(`${c}.q`, 'c', true); b.name(`${f}.q`, 'f', true); b.name(`${ctl}.strobe`, 'strobe', true);
  b.wire(xs[0], 'bit'); b.wire(`${ctl}.strobe`, 'strobe'); b.wire(early, 'early'); b.wire(late, 'late'); b.wire(`${c}.q`, 'phase'); b.wire(`${f}.q`, 'vote');
  const R = b.right;
  const ins = [bit('rxd', 'in'), clk()], outs = [bit('bit', 'out'), bit('strobe', 'out'), bit('early', 'out'), bit('late', 'out'), bus('phase', 3, 'out'), bus('vote', 3, 'out')];
  return define({
    id: 'cdr', name: 'Clock and data recovery', category: 'sequential',
    summary: 'Samples the line every cycle (4 per bit), compares the data samples around an edge sample (an Alexander detector), and moves its bit strobe by one sample when four votes agree. No clock comes with the data: the transitions in it are the clock.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'CDR' },
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

const COMMA7 = tableBlock('comma7', 'Comma detector', 'The seven bits 0011111 or 1100000, newest in bit 0.', [{ name: 'a', width: 7 }], [{ name: 'hit', width: 1 }],
  ([a]) => [a === 0b0011111 || a === 0b1100000 ? 1 : 0], 'COMMA');
const BCNEXT = tableBlock('bcnext', 'Bit count step', 'bits received in the word so far: +1, or 7 where a comma has just arrived; done when it reaches 10.',
  [{ name: 'bc', width: 4 }, { name: 'comma', width: 1 }], [{ name: 'next', width: 4 }, { name: 'done', width: 1 }],
  ([bc, comma]) => { const s = comma ? 7 : bc + 1; return [s >= 10 ? 0 : s, s === 10 ? 1 : 0]; }, 'BITCOUNT');

/** The deserializer: shifts the recovered bit in at each strobe, counts to ten, and a comma sets the count to 7: that is the word boundary. */
export const DESER10 = memo('deser10', () => {
  const b = new Builder(10, 12);
  b.pins('d', 'strobe', 'clk');
  const sp = b.op(splitter(ones(10)), ['sr.q'], undefined, 'ssp');
  b.next();
  const srn = b.op1(merger(ones(10)), ['d', ...Array.from({ length: 9 }, (_, i) => `${sp}.o${i}`)], 'shifted in', 'srn');
  const low = b.op1(merger(ones(7)), ['d', ...Array.from({ length: 6 }, (_, i) => `${sp}.o${i}`)], 'low seven', 'low');
  b.next();
  const cm = b.op1(COMMA7, [low], 'comma?', 'cm');
  b.next();
  const bn = b.op(BCNEXT, ['bc.q', cm], 'bit count', 'bn');
  const wen = b.op1(AND, ['strobe', `${bn}.done`], 'word complete');
  b.next();
  const sr = b.op(register(10), [srn, 'strobe', 'clk'], 'shift register', 'sr');
  const bc = b.op(register(4), [`${bn}.next`, 'strobe', 'clk'], 'bit count', 'bc');
  const wr = b.op(register(10), [srn, wen, 'clk'], 'word', 'wr');
  const wv = b.op(DFF, [wen, 'clk'], 'word valid', 'wv');
  b.name(`${sr}.q`, 'sr', true); b.name(`${bc}.q`, 'bc', true);
  b.wire(`${wr}.q`, 'word'); b.wire(`${wv}.q`, 'wv'); b.wire(`${bc}.q`, 'count'); b.wire(b.op1(AND, ['strobe', cm], 'comma at a strobe'), 'comma');
  const R = b.right;
  const ins = [bit('d', 'in'), bit('strobe', 'in'), clk()], outs = [bus('word', 10, 'out'), bit('wv', 'out'), bus('count', 4, 'out'), bit('comma', 'out')];
  return define({
    id: 'deser10', name: '10-bit deserializer', category: 'sequential',
    summary: 'A shift register fed at each strobe, a bit counter, and a word register loaded when ten bits are in. A comma (0011111 or 1100000) in the last seven bits sets the counter to 7, so the word boundary comes from the data.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'DESER' },
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

/** The whole receiver: recovery and deserializer. */
export const SER_RX = memo('serrx', () => {
  const b = new Builder(10, 12);
  b.pins('rxd', 'clk');
  const cdr = b.op(CDR, ['rxd', 'clk'], 'clock and data recovery', 'cdr');
  b.next();
  const des = b.op(DESER10, [`${cdr}.bit`, `${cdr}.strobe`, 'clk'], 'deserializer', 'des');
  b.next();
  for (const o of ['word', 'wv', 'count', 'comma']) b.wire(`${des}.${o}`, o);
  for (const o of ['strobe', 'early', 'late', 'phase', 'vote']) b.wire(`${cdr}.${o}`, o);
  const R = b.right;
  const ins = [bit('rxd', 'in'), clk()];
  const outs = [bus('word', 10, 'out'), bit('wv', 'out'), bus('count', 4, 'out'), bit('comma', 'out'), bit('strobe', 'out'), bit('early', 'out'), bit('late', 'out'), bus('phase', 3, 'out'), bus('vote', 3, 'out')];
  return define({
    id: 'serrx', name: 'Serial receiver', category: 'sequential',
    summary: 'Clock and data recovery feeding a deserializer: from the line alone, ten-bit words (wv pulses with each) aligned on the comma.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'RX' },
    netlist: () => ({ pins: pinsOf(ins, outs, R), instances: b.instances, nets: b.nets() }),
  });
});

// ---- the link ---------------------------------------------------------------------------------------------------------------

/** Cycles of delay in the link's line. */
export const LINK_DELAY = 3;

/**
 * The whole link on one clock: a byte source (a K28.5 comma every eighth word, between them pseudo-random bytes or din by hand; kin
 * with manual makes every word a control code),
 * the 8b/10b encoder with its running disparity, the sender, a line with an error input, the receiver, and the decoder with its own
 * running disparity (a comma sets it). inc sets the sender's bit rate against the receiver's 4 samples a bit.
 */
export const SERDES_LINK = memo('serdeslink', () => {
  const b = new Builder(10, 12);
  b.pins('inc', 'manual', 'din', 'kin', 'flip', 'clk');
  const rnd = b.op(randomSource(8), ['clk'], 'bytes between the commas', 'rnd');
  const bcw = b.op1(constWord(8, 0xbc), [], 'K28.5');
  const wc = b.op(counter(3), ['tx.wload', 'clk'], 'word count', 'wc');
  b.next();
  const wsp = b.op(splitter(ones(3)), [`${wc}.q`], undefined, 'wsp');
  b.next();
  const anySet = b.op1(orN(3), [`${wsp}.o0`, `${wsp}.o1`, `${wsp}.o2`], 'count not 0?');
  const kauto = b.op1(NOT, [anySet], 'every 8th word: a comma');
  b.next();
  const vdata = b.op1(busMux2(8), [`${rnd}.q`, 'din', 'manual'], 'din by hand?', 'vdata');
  b.next();
  const v = b.op1(busMux2(8), [vdata, bcw, kauto], 'every 8th word: K28.5', 'vmux');
  const hand = b.op1(AND, ['manual', 'kin'], 'kin by hand');
  const k = b.op1(OR, [kauto, hand], 'K flag', 'kmux');
  b.name(v, 'byte', true); b.name(k, 'kflag', true);
  b.next();
  const enc = b.op(ENC8B10B, [v, k, 'rdt.q'], 'encoder', 'enc');
  b.next();
  b.op(register(1), [`${enc}.rdout`, 'tx.wload', 'clk'], 'sender running disparity', 'rdt');
  const tx = b.op(SER_TX, ['inc', `${enc}.code`, 'clk'], 'sender', 'tx');
  b.name(`${enc}.code`, 'tword', true); b.name('rdt.q', 'rdt', true);
  b.next();
  const line = b.op(serialLine(LINK_DELAY), [`${tx}.txd`, 'flip', 'clk'], 'the line (a model)', 'line');
  b.next();
  const rx = b.op(SER_RX, [`${line}.out`, 'clk'], 'receiver', 'rx');
  b.next();
  const dec = b.op(DEC8B10B, [`${rx}.word`, 'rdr.q'], 'decoder', 'dec');
  b.op(register(1), [`${dec}.rdout`, `${rx}.wv`, 'clk'], 'receiver running disparity', 'rdr');
  b.name(`${rx}.word`, 'rword', true); b.name('rdr.q', 'rdr', true);
  b.next();
  const map: [string, string][] = [
    ['txd', `${tx}.txd`], ['rxd', `${line}.out`], ['tword', `${enc}.code`], ['wload', `${tx}.wload`], ['rword', `${rx}.word`], ['wv', `${rx}.wv`],
    ['rbyte', `${dec}.d`], ['rk', `${dec}.k`], ['err', `${dec}.err`], ['strobe', `${rx}.strobe`], ['early', `${rx}.early`], ['late', `${rx}.late`],
    ['phase', `${rx}.phase`], ['vote', `${rx}.vote`], ['count', `${rx}.count`], ['sbyte', v], ['sk', k],
  ];
  for (const [o, d] of map) b.wire(d, o);
  const R = b.right;
  const ins = [bus('inc', NCO_BITS, 'in'), bit('manual', 'in'), bus('din', 8, 'in'), bit('kin', 'in'), bit('flip', 'in'), clk()];
  const outs = [bit('txd', 'out'), bit('rxd', 'out'), bus('tword', 10, 'out'), bit('wload', 'out'), bus('rword', 10, 'out'), bit('wv', 'out'), bus('rbyte', 8, 'out'), bit('rk', 'out'), bit('err', 'out'),
    bit('strobe', 'out'), bit('early', 'out'), bit('late', 'out'), bus('phase', 3, 'out'), bus('vote', 3, 'out'), bus('count', 4, 'out'), bus('sbyte', 8, 'out'), bit('sk', 'out')];
  return define({
    id: 'serdeslink', name: 'SerDes link', category: 'sequential',
    summary: 'Byte source, 8b/10b encoder, sender (bit-clock accumulator and serializer), a line, receiver (clock and data recovery, deserializer, comma alignment) and decoder, all on one clock: the receiver has only the line.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'SERDES' },
    netlist: () => ({ pins: pinsOf(ins, outs, R, 2), instances: b.instances, nets: b.nets() }),
  });
});
