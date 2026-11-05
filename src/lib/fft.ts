// Many carriers' FFT in gates. The rules are comm/fftfix.ts's header, and every part's spec is that model. A butterfly is four adders that halve; a twiddle of
// 1, or of -j, is wires; 1/√2 is shift-and-add; only the others need the general complex multiplier, four Booth multipliers. tests/comm-fft.test.ts compares them.

import { addH, butterflyFx, cmulFx, fftFx, flowGraph, bitRev, mulRoot, packFx, rootHalf, subH, twiddle, twKind, unpackFx, wrap } from '../comm/fftfix';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { HALF_ADDER, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { boothMul } from './multiply';
import { TIE0, TIE1 } from './transistors';
import { notBus } from './viterbi';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const uns = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Wiring: `w` bits to `to`, moved up `shift` places (`z` fills below) and sign-extended above. */
function placed(w: number, shift: number, to: number): ComponentDef {
  return memo(`fxplace${w}_${shift}_${to}`, () => {
    const alias: [string, number, string, number][] = [];
    for (let i = 0; i < to; i++) alias.push(i < shift ? ['z', 0, 'y', i] : ['a', Math.min(i - shift, w - 1), 'y', i]);
    return define({
      id: `fxplace${w}_${shift}_${to}`, name: `Wiring: ×2^${shift}, ${w} → ${to} bits`, category: 'plumbing',
      summary: 'A shift and a sign extension are only how the wires are laid: the top bit is copied upward, zeros come in below.',
      ports: [bus('a', w, 'in'), ...(shift ? [bit('z', 'in', 'bottom')] : []), bus('y', to, 'out')],
      symbol: { kind: 'box', label: shift ? `≪${shift}` : 'SX', w: 4, h: 2 }, prim: 'alias', alias,
    });
  });
}

/** Wiring: `w` bits of a word, from bit `lo`. */
function cut(n: number, lo: number, w: number): ComponentDef {
  return memo(`fxcut${n}_${lo}_${w}`, () => define({
    id: `fxcut${n}_${lo}_${w}`, name: `Wiring: bits ${lo + w - 1}:${lo}`, category: 'plumbing',
    summary: 'Keeps some of a word\'s bits: dropping the low ones is a shift right, and it costs nothing.',
    ports: [bus('a', n, 'in'), bus('y', w, 'out')], symbol: { kind: 'box', label: `[${lo + w - 1}:${lo}]`, w: 6, h: 2 }, prim: 'alias',
    alias: Array.from({ length: w }, (_, i): [string, number, string, number] => ['a', lo + i, 'y', i]),
  }));
}

/** y = (a + b + 1) >> 1, or (a - b) >> 1: a sign-extended adder whose carry-in is tied high and whose lowest bit is dropped. */
export function fxHalve(W: number, sub: boolean): ComponentDef {
  const id = `fx${sub ? 'sub' : 'add'}${W}`;
  return memo(id, () => {
    const b = new Builder(6, 8, 3);
    b.pins('a', 'b');
    const sa = b.op1(placed(W, 0, W + 1), ['a']);
    const nb = sub ? b.op1(notBus(W), ['b']) : 'b';
    const sb = b.op1(placed(W, 0, W + 1), [nb]);
    b.next();
    const one = b.op1(TIE1, []);
    const add = b.op(rca(W + 1), [sa, sb, one], sub ? 'a + ~b + 1' : 'a + b + 1');
    b.next();
    b.wire(b.op1(cut(W + 1, 1, W), [`${add}.s`]), 'y');
    const R = b.right;
    return define({
      id, name: `${W}-bit ${sub ? 'halving subtractor' : 'halving adder'}`, category: 'arithmetic',
      summary: sub ? 'a − b, then one place down. The carry-in tied to 1 is the two\'s complement\'s; an odd difference rounds down.' : 'a + b, then one place down. The carry-in tied to 1 rounds an odd sum up, so sum and difference together lose nothing.',
      ports: [bus('a', W, 'in'), bus('b', W, 'in'), bus('y', W, 'out')],
      symbol: { kind: 'box', label: sub ? '(a−b)/2' : '(a+b)/2' },
      spec: ([x, y]) => [uns((sub ? subH : addH)(wrap(x, W), wrap(y, W), W), W)],
      netlist: () => ({ pins: { a: [0, 2], b: [0, 8], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** y = a + c, half adders in a chain: the rounding step, the first dropped bit added back. */
export function roundUp(W: number): ComponentDef {
  return memo(`fxrnd${W}`, () => {
    const P = 8, X = 10;
    const instances: InstanceDef[] = [{ name: 'sa', def: splitter(ones(W), P), at: [5, 0] }, { name: 'my', def: merger(ones(W), P), at: [20, 0] }];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'y', ends: ['my.out', 'y'] }, { name: 'c', ends: ['c', 'ha0.b'] }];
    for (let i = 0; i < W; i++) {
      instances.push({ name: `ha${i}`, def: HALF_ADDER, at: [X, P * i + 1] });
      nets.push({ name: `a${i}`, ends: [`sa.o${i}`, `ha${i}.a`] }, { name: `y${i}`, ends: [`ha${i}.s`, `my.i${i}`] });
      if (i + 1 < W) nets.push({ name: `c${i + 1}`, ends: [`ha${i}.c`, `ha${i + 1}.b`] });
    }
    return define({
      id: `fxrnd${W}`, name: `${W}-bit rounder`, category: 'arithmetic',
      summary: 'Adds one bit to a word with half adders: rounding is the first bit dropped, added back.',
      ports: [bus('a', W, 'in'), bit('c', 'in', 'bottom'), bus('y', W, 'out')], symbol: { kind: 'box', label: '+c' },
      spec: ([a, c]) => [(a + c) % 2 ** W],
      netlist: () => ({ pins: { a: [1, (P * W) / 2], c: [X + 3, -2], y: [25, (P * W) / 2] }, pinDirs: { c: 'down' }, instances, nets }),
    });
  });
}

/** Non-adjacent signed digits, the fewest non-zero digits a constant can have: positions with their signs, low first. */
export function csdDigits(c: number): { pos: number; neg: boolean }[] {
  const out: { pos: number; neg: boolean }[] = [];
  let v = c, pos = 0;
  while (v > 0) {
    if (v % 2) { const neg = v % 4 === 3; out.push({ pos, neg }); v = neg ? v + 1 : v - 1; }
    v /= 2; pos++;
  }
  return out;
}

/** y = x / √2, rounded: 1/√2 written in signed digits, an adder a digit. No multiplier: the constant's digits are the wiring. */
export function fxRoot(W: number): ComponentDef {
  return memo(`fxroot${W}`, () => {
    const P = 2 * W - 1, digits = csdDigits(rootHalf(W)).reverse();
    const b = new Builder(6, 8, 3);
    b.pins('x');
    b.name('x', 'x', true);
    const z = b.name(b.op1(TIE0, []), 'z', true);
    b.next();
    const term = (s: number) => b.op1(placed(W + 1, s, P), s ? ['x', z] : ['x']);
    let acc = term(digits[0].pos);
    for (const d of digits.slice(1)) {
      const t = term(d.pos), o = d.neg ? b.op1(notBus(P), [t]) : t;
      const cin = b.op1(d.neg ? TIE1 : TIE0, []);
      b.next();
      acc = `${b.op(rca(P), [acc, o, cin], `${d.neg ? '−' : '+'} x ≪ ${d.pos}`)}.s`;
      b.next();
    }
    const hi = b.op1(cut(P, W - 1, W), [acc]), lo = b.op1(cut(P, W - 2, 1), [acc]);
    b.next();
    b.wire(b.op1(roundUp(W), [hi, lo], 'round'), 'y');
    const R = b.right;
    return define({
      id: `fxroot${W}`, name: `× 1/√2, ${W} bits`, category: 'arithmetic',
      summary: `Multiplies by 0x${rootHalf(W).toString(16).toUpperCase()} / 2^${W - 1} ≈ 0.7071 with ${digits.length - 1} adders: a constant multiplier has no multiplier in it, only its signed digits.`,
      ports: [bus('x', W + 1, 'in'), bus('y', W, 'out')], symbol: { kind: 'box', label: '×1/√2' },
      spec: ([x]) => [uns(mulRoot(wrap(x, W + 1), W), W)],
      netlist: () => ({ pins: { x: [0, 3], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

const splitFx = (W: number) => splitter([W, W], Math.max(2, 4));
const mergeFx = (W: number) => merger([W, W], Math.max(2, 4));

/** t = b · w: four Booth multipliers, a subtractor and an adder, each result rounded once. What a twiddle that is not a right angle or 45° costs. */
export function fxCmul(W: number): ComponentDef {
  return memo(`fxcmul${W}`, () => {
    const P = 2 * W, B = boothMul(W), g = new Builder(6, 10, 3);
    g.pins('b', 'w');
    const sb = g.op(splitFx(W), ['b']), sw = g.op(splitFx(W), ['w']);
    const br = `${sb}.o0`, bi = `${sb}.o1`, wr = `${sw}.o0`, wi = `${sw}.o1`;
    for (const [d, n] of [[br, 'bre'], [bi, 'bim'], [wr, 'wre'], [wi, 'wim']] as const) g.name(d, n, true);
    g.next();
    const rr = g.op1(B, [br, wr], 're · re'), ii = g.op1(B, [bi, wi], 'im · im'), ri = g.op1(B, [br, wi], 're · im'), ir = g.op1(B, [bi, wr], 'im · re');
    g.next();
    const nii = g.op1(notBus(P), [ii]);
    g.next();
    const hi = g.op(rca(P), [rr, nii, g.op1(TIE1, [])], 're'), sum = g.op(rca(P), [ri, ir, g.op1(TIE0, [])], 'im');
    g.next();
    const out = [hi, sum].map((a) => [g.op1(cut(P, W - 1, W), [`${a}.s`]), g.op1(cut(P, W - 2, 1), [`${a}.s`])]);
    g.next();
    const re = g.op1(roundUp(W), out[0], 'round'), im = g.op1(roundUp(W), out[1], 'round');
    g.next();
    g.wire(g.op1(mergeFx(W), [re, im]), 't');
    const R = g.right;
    return define({
      id: `fxcmul${W}`, name: `${W}-bit complex multiplier`, category: 'arithmetic',
      summary: 'b · w = (re·re − im·im) + j (re·im + im·re): four signed multipliers and two adders, the rounding done once per output, never per product. This block is why an FFT counts multiplications.',
      ports: [bus('b', 2 * W, 'in'), bus('w', 2 * W, 'in'), bus('t', 2 * W, 'out')], symbol: { kind: 'box', label: 'b·w' },
      spec: ([x, y]) => [packFx(cmulFx(unpackFx(x, W), unpackFx(y, W), W), W)],
      netlist: () => ({ pins: { b: [0, 2], w: [0, 12], t: [R, 8] }, instances: g.instances, nets: g.nets() }),
    });
  });
}

/** t = b (1 - j) / √2: the two parts' sum and difference, then a constant multiplier each. */
export function fxRot45(W: number): ComponentDef {
  return memo(`fxrot${W}`, () => {
    const R1 = fxRoot(W), g = new Builder(6, 10, 3);
    g.pins('b');
    const sb = g.op(splitFx(W), ['b']), br = `${sb}.o0`, bi = `${sb}.o1`;
    g.name(br, 'bre', true); g.name(bi, 'bim', true);
    g.next();
    const ext = (d: string) => g.op1(placed(W, 0, W + 1), [d]);
    const reS = ext(br), imS = ext(bi), reN = g.op1(placed(W, 0, W + 1), [g.op1(notBus(W), [br])]);
    g.next();
    const sum = g.op(rca(W + 1), [reS, imS, g.op1(TIE0, [])], 're + im'), dif = g.op(rca(W + 1), [imS, reN, g.op1(TIE1, [])], 'im − re');
    g.next();
    const y0 = g.op1(R1, [`${sum}.s`]), y1 = g.op1(R1, [`${dif}.s`]);
    g.next();
    g.wire(g.op1(mergeFx(W), [y0, y1]), 't');
    const R = g.right;
    return define({
      id: `fxrot${W}`, name: `× (1 − j)/√2, ${W} bits`, category: 'arithmetic',
      summary: 'A 45° turn: re + im and im − re, each times 1/√2. Two constant multipliers in place of four general ones.',
      ports: [bus('b', 2 * W, 'in'), bus('t', 2 * W, 'out')], symbol: { kind: 'box', label: '×W₈' },
      spec: ([x]) => { const b = unpackFx(x, W); return [packFx({ re: mulRoot(b.re + b.im, W), im: mulRoot(b.im - b.re, W) }, W)]; },
      netlist: () => ({ pins: { b: [0, 4], t: [R, 8] }, instances: g.instances, nets: g.nets() }),
    });
  });
}

/** y0 = (a + t) / 2, y1 = (a - t) / 2; with `swap` t is first multiplied by -j, which is only which adder gets which part. */
export function fxCore(W: number, swap: boolean): ComponentDef {
  return memo(`fxcore${W}${swap ? 's' : ''}`, () => {
    const A = fxHalve(W, false), S = fxHalve(W, true), g = new Builder(6, 12, 3);
    g.pins('a', 't');
    const sa = g.op(splitFx(W), ['a']), st = g.op(splitFx(W), ['t']);
    const ar = g.name(`${sa}.o0`, 'are', true), ai = g.name(`${sa}.o1`, 'aim', true), tr = g.name(`${st}.o0`, 'tre', true), ti = g.name(`${st}.o1`, 'tim', true);
    g.next();
    const parts = swap
      ? [g.op1(A, [ar, ti], 're: a + (−j t)'), g.op1(S, [ai, tr], 'im: a + (−j t)'), g.op1(S, [ar, ti], 're: a − (−j t)'), g.op1(A, [ai, tr], 'im: a − (−j t)')]
      : [g.op1(A, [ar, tr], 're: a + t'), g.op1(A, [ai, ti], 'im: a + t'), g.op1(S, [ar, tr], 're: a − t'), g.op1(S, [ai, ti], 'im: a − t')];
    g.next();
    g.wire(g.op1(mergeFx(W), [parts[0], parts[1]]), 'y0');
    g.wire(g.op1(mergeFx(W), [parts[2], parts[3]]), 'y1');
    const R = g.right;
    return define({
      id: `fxcore${W}${swap ? 's' : ''}`, name: `Butterfly's adders${swap ? ', with −j' : ''}, ${W} bits`, category: 'arithmetic',
      summary: swap ? 'The same four adders with the parts of t crossed and one sum and one difference exchanged: multiplying by −j costs no gate.' : 'Sum and difference of two complex words, each halved: four adders.',
      ports: [bus('a', 2 * W, 'in'), bus('t', 2 * W, 'in'), bus('y0', 2 * W, 'out'), bus('y1', 2 * W, 'out')], symbol: { kind: 'box', label: swap ? 'a±(−j)t' : 'a±t' },
      spec: ([x, y]) => {
        const a = unpackFx(x, W), t = unpackFx(y, W);
        return swap
          ? [packFx({ re: addH(a.re, t.im, W), im: subH(a.im, t.re, W) }, W), packFx({ re: subH(a.re, t.im, W), im: addH(a.im, t.re, W) }, W)]
          : [packFx({ re: addH(a.re, t.re, W), im: addH(a.im, t.im, W) }, W), packFx({ re: subH(a.re, t.re, W), im: subH(a.im, t.im, W) }, W)];
      },
      netlist: () => ({ pins: { a: [0, 2], t: [0, 12], y0: [R, 6], y1: [R, 16] }, instances: g.instances, nets: g.nets() }),
    });
  });
}

/** One butterfly with the twiddle W^k_N. */
export function fxButterfly(W: number, k: number, N: number): ComponentDef {
  const kind = twKind(k, N), tag = kind === 'general' ? `g${k}_${N}` : kind;
  return memo(`fxbf${W}_${tag}`, () => {
    const swap = kind === 'minusj' || kind === 'root3', g = new Builder(6, 10, 3);
    g.pins('a', 'b');
    let t = 'b';
    if (kind === 'root1' || kind === 'root3') t = g.op1(fxRot45(W), ['b'], 'turn');
    if (kind === 'general') { const c = twiddle(k, N, W); t = g.op1(fxCmul(W), ['b', g.op1(constWord(2 * W, packFx(c, W)), [])], `W${k}`); }
    g.next();
    const core = g.op(fxCore(W, swap), ['a', t]);
    g.next();
    g.wire(`${core}.y0`, 'y0'); g.wire(`${core}.y1`, 'y1');
    const R = g.right, label = kind === 'one' ? 'W⁰' : kind === 'minusj' ? '−j' : kind === 'root1' ? 'W₈¹' : kind === 'root3' ? 'W₈³' : `W${k}/${N}`;
    return define({
      id: `fxbf${W}_${tag}`, name: `Butterfly ${label}, ${W} bits`, category: 'arithmetic',
      summary: `y0 = (a + W b) / 2 and y1 = (a − W b) / 2, the FFT's only operation. ${kind === 'one' || kind === 'minusj' ? 'This twiddle is wires, so it is four adders.' : kind === 'general' ? 'This twiddle needs the general complex multiplier.' : 'This twiddle is a 45° turn: two constant multipliers.'}`,
      ports: [bus('a', 2 * W, 'in'), bus('b', 2 * W, 'in'), bus('y0', 2 * W, 'out'), bus('y1', 2 * W, 'out')], symbol: { kind: 'box', label },
      spec: ([x, y]) => butterflyFx(unpackFx(x, W), unpackFx(y, W), k, N, W).map((c) => packFx(c, W)),
      netlist: () => ({ pins: { a: [0, 2], b: [0, 10], y0: [R, 4], y1: [R, 8] }, instances: g.instances, nets: g.nets() }),
    });
  });
}

/** The whole flow graph of N points, combinational: the inputs wired in bit-reversed order, log₂ N columns of butterflies, X[k] / N out. */
export function fftNet(N: number, W: number): ComponentDef {
  return memo(`fftnet${N}_${W}`, () => {
    const bits = Math.log2(N), g = new Builder(10, 16, 4), stages = flowGraph(N);
    const inNames = Array.from({ length: N }, (_, i) => `x${i}`), outNames = Array.from({ length: N }, (_, i) => `X${i}`);
    g.pins(...inNames);
    let v = inNames.map((_, i) => `x${bitRev(i, bits)}`);
    stages.forEach((st, s) => {
      g.next();
      const nx = v.slice();
      for (const { a, b, k } of st) {
        const u = g.op(fxButterfly(W, k, N), [v[a], v[b]], undefined, `s${s}_${a}`);
        nx[a] = `${u}.y0`; nx[b] = `${u}.y1`;
      }
      v = nx;
    });
    g.next();
    v.forEach((d, i) => g.wire(d, `X${i}`));
    const R = g.right, PY = 7, pins: Record<string, [number, number]> = {};
    inNames.forEach((n, i) => { pins[n] = [0, 2 + PY * bitRev(i, bits)]; });
    outNames.forEach((n, i) => { pins[n] = [R, 2 + PY * i]; });
    return define({
      id: `fftnet${N}_${W}`, name: `${N}-point FFT, ${W} bits`, category: 'arithmetic',
      summary: `${N} complex samples in, ${N} tones out, each ${N}th of the sum: ${stages.flat().length} butterflies in ${bits} columns, the inputs in bit-reversed order, no clock. A complex sample is ${2 * W} bits, im above re.`,
      ports: [...inNames.map((n) => bus(n, 2 * W, 'in')), ...outNames.map((n) => bus(n, 2 * W, 'out'))], symbol: { kind: 'box', label: `FFT${N}` },
      spec: (ins) => fftFx(ins.map((x) => unpackFx(x, W)), W).map((c) => packFx(c, W)),
      netlist: () => ({ pins, instances: g.instances, nets: g.nets() }),
    });
  });
}

/** The inverse with no new gates: swap each sample's parts going in and coming out. */
export const swapParts = (v: number, W: number): number => (v % 2 ** W) * 2 ** W + Math.floor(v / 2 ** W);
