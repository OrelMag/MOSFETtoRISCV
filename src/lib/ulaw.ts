// Chapter "Speech"'s G.711 μ-law in gates: an encoder from 14-bit samples to the 8-bit character signal, and a decoder back. dsp/speech.ts ulawEncode / ulawDecode are the golden
// model, and tests/dsp-speech.test.ts compares every one of the 16 384 samples and 256 codes.

import { ulawDecode, ulawEncode } from '../dsp/speech';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { muxTree, rca } from './combinational';
import { priorityEncoder } from './coding';
import { define, merger } from './define';
import { cut, placed } from './fft';
import { NOT, OR } from './gates';
import { incCin } from './rvc';
import { TIE0, TIE1 } from './transistors';
import { notBus } from './viterbi';
import { bitwise } from './wide';

const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
function built(b: Builder, ports: PortDef[]) {
  const R = b.right;
  let li = 0, ri = 0;
  const pins: Record<string, [number, number]> = {};
  for (const p of ports) pins[p.name] = p.dir === 'in' ? [0, 2 + 3 * li++] : [R, 2 + 3 * ri++];
  return { pins, instances: b.instances, nets: b.nets() };
}
const uns = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;
const sgn = (v: number, w: number) => (v >= 2 ** (w - 1) ? v - 2 ** w : v);

/** |x| of a 14-bit sample: each bit XORed with the sign, then the sign added back in as a carry. 14 bits out, as −8192 needs. */
function magnitude(): ComponentDef {
  return memo('ulaw_mag', () => {
    const b = new Builder(6, 8, 3);
    b.pins('x');
    const xw = b.op1(placed(14, 0, 14), ['x']);
    b.next();
    const s = b.op1(cut(14, 13, 1), [xw], 'sign');
    b.next();
    const ss = b.op1(placed(1, 0, 14), [s], 'sign × 14');
    b.next();
    const fl = b.op1(bitwise('xor', 14), [xw, ss], 'x ⊕ sign');
    b.next();
    b.wire(b.op1(incCin(14), [fl, s], '+ sign'), 'm');
    b.wire(s, 's');
    const ports = [bus('x', 14, 'in'), bus('m', 14, 'out'), bus('s', 1, 'out')];
    return define({ id: 'ulaw_mag', name: 'Magnitude, 14 bits', category: 'arithmetic', summary: 'The size of a two\'s complement sample: invert it if it is negative, and add one.', ports, symbol: { kind: 'box', label: '|x|', w: 4 }, spec: ([x]) => [Math.abs(sgn(x, 14)), x >= 8192 ? 1 : 0], netlist: () => built(b, ports) });
  });
}

/** G.711 μ-law encoder: a 14-bit sample to its character signal. */
export function ulawEncoder(): ComponentDef {
  return memo('ulaw_enc', () => {
    const b = new Builder(6, 10, 3);
    b.pins('x');
    const mg = b.op(magnitude(), ['x'], undefined, 'mag'), m = `${mg}.m`, sign = `${mg}.s`;
    b.next();
    // v = |x| + 33, 15 bits; 8192 or more is past the clip
    const c33 = b.op1(constWord(15, 33), [], '33');
    const m15 = b.op1(placed(14, 0, 15), [m]), z = b.op1(TIE0, []);
    b.next();
    const v = `${b.op(rca(15), [m15, c33, z], '|x| + 33', 'bias')}.s`;
    b.next();
    const sat = b.op1(OR, [b.op1(cut(15, 13, 1), [v]), b.op1(cut(15, 14, 1), [v])], 'v ≥ 8192', 'sat');
    const seg = b.op(priorityEncoder(8), [b.op1(cut(15, 5, 8), [v], 'v[12:5]')], 'segment', 'seg');
    b.next();
    const steps = Array.from({ length: 8 }, (_, e) => b.op1(cut(15, e + 1, 4), [v], `v[${e + 4}:${e + 1}]`));
    b.next();
    const step = b.op1(muxTree(3, 4), [...steps, `${seg}.y`], 'the 4 bits below the top one', 'stp');
    b.next();
    const n = b.op1(merger([4, 3]), [step, `${seg}.y`], 'n = segment, step');
    b.next();
    const n7 = b.op1(bitwise('or', 7), [n, b.op1(placed(1, 0, 7), [sat])], 'saturate');
    b.next();
    const inv = b.op1(notBus(7), [n7], 'inverted, as sent');
    const pol = b.op1(NOT, [sign], 'polarity');
    b.next();
    b.wire(b.op1(merger([7, 1]), [inv, pol]), 'code');
    const ports = [bus('x', 14, 'in'), bus('code', 8, 'out')];
    return define({
      id: 'ulaw_enc', name: 'μ-law encoder (G.711)', category: 'arithmetic',
      summary: 'A 14-bit sample to 8 bits: its size plus 33, whose top bit picks one of 8 segments and whose next 4 bits the step in it; then the code is inverted and the sign put in front.',
      ports, symbol: { kind: 'box', label: 'μ-law', w: 6 }, spec: ([x]) => [ulawEncode(sgn(x, 14))], netlist: () => built(b, ports),
    });
  });
}

/** G.711 μ-law decoder: a character signal back to its quantized value, ((33 + 2m) << e) − 33, signed. */
export function ulawDecoder(): ComponentDef {
  return memo('ulaw_dec', () => {
    const b = new Builder(6, 10, 3);
    b.pins('code');
    // through a wiring box, so the pin has one sink and the two cuts hang off its output
    const cw = b.op1(placed(8, 0, 8), ['code']);
    b.next();
    const n = b.op1(notBus(7), [b.op1(cut(8, 0, 7), [cw])], 'n = ~code');
    const pos = b.op1(cut(8, 7, 1), [cw], 'polarity', 'pol');
    b.next();
    const step = b.op1(cut(7, 0, 4), [n], 'step m'), seg = b.op1(cut(7, 4, 3), [n], 'segment e');
    const one = b.op1(TIE1, []), zero = b.op1(TIE0, []);
    b.next();
    // 33 + 2m is 1, m, 1 in binary: wiring, with a 0 on top so the shifts below fill with zeros
    const base = b.op1(merger([1, 4, 1, 1]), [one, step, one, zero], '33 + 2m');
    b.next();
    const shifted = Array.from({ length: 8 }, (_, e) => b.op1(placed(7, e, 14), e ? [base, zero] : [base], `≪ ${e}`));
    b.next();
    const sh = b.op1(muxTree(3, 14), [...shifted, seg], '≪ e', 'shift');
    b.next();
    // − 33: add 33's complement with a carry in
    const y = `${b.op(rca(14), [sh, b.op1(constWord(14, uns(-33, 14) - 1), [], '~33'), one], '− 33', 'unbias')}.s`;
    b.next();
    // negative when the polarity bit is 0
    const neg = b.op1(NOT, [pos]);
    b.next();
    const fl = b.op1(bitwise('xor', 14), [y, b.op1(placed(1, 0, 14), [neg])], 'y ⊕ negative');
    b.next();
    b.wire(b.op1(incCin(14), [fl, neg], '+ negative'), 'y');
    const ports = [bus('code', 8, 'in'), bus('y', 14, 'out')];
    return define({
      id: 'ulaw_dec', name: 'μ-law decoder (G.711)', category: 'arithmetic',
      summary: 'A code back to a 14-bit sample: undo the inversion, set 1, the step, 1 as six bits, shift by the segment, take 33 off, and negate if the polarity bit is 0.',
      ports, symbol: { kind: 'box', label: 'μ⁻¹', w: 6 }, spec: ([c]) => [uns(ulawDecode(c), 14)], netlist: () => built(b, ports),
    });
  });
}

/** Encoder then decoder: what a telephone line does to a sample. */
export function ulawLine(): ComponentDef {
  return memo('ulaw_line', () => {
    const b = new Builder(6, 12, 4);
    b.pins('x');
    const c = b.op1(ulawEncoder(), ['x'], undefined, 'enc');
    b.next();
    b.wire(c, 'code');
    b.wire(b.op1(ulawDecoder(), [c], undefined, 'dec'), 'y');
    const ports = [bus('x', 14, 'in'), bus('code', 8, 'out'), bus('y', 14, 'out')];
    return define({
      id: 'ulaw_line', name: 'μ-law, there and back', category: 'arithmetic',
      summary: 'A 14-bit sample, the 8 bits a telephone line carries, and the sample the far end gets back.',
      ports, symbol: { kind: 'box', label: 'G.711', w: 6 }, spec: ([x]) => { const c = ulawEncode(sgn(x, 14)); return [c, uns(ulawDecode(c), 14)]; }, netlist: () => built(b, ports),
    });
  });
}
