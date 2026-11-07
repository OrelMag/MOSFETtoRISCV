// One Goertzel resonator in gates (chapter "Measuring a spectrum"): s[n] = x[n] + c s[n−1] − s[n−2], one multiplier, two adders, two registers.
// The coefficient c = 2 cos(2πf) is an input word (Q2.14), so one cell serves any frequency, one block after another; `clr` empties the state before a block.
// The product comes down by 14 and rounds half up, the sum wraps in the state word (the model sizes the word so that it never does for any 8-bit input):
// dsp/spectrum.ts goertzelFx is compared with it every cycle (tests/dsp-spectrum.test.ts).

import { COEF_BITS, COEF_FRAC } from '../dsp/spectrum';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { LIB_MUX2, rca, type Mux2Kind } from './combinational';
import { define } from './define';
import { cut, placed, roundUp } from './fft';
import { treeMul } from './muldiv';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { notBus } from './viterbi';

export const GZ_IN = 8;
/** The state word of the DTMF cell: dsp/spectrum.ts stateBits for the eight tones at a block of 205 is 16 (pinned by the test). */
export const GZ_STATE = 16;

const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const cache = new Map<string, ComponentDef>();

/** `mux`: the 2:1 bus mux of the clear (the campaign's references use the shared-inverter one, rv16/logic.ts RV16_MUX2). */
export function goertzelCell(sw = GZ_STATE, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  if (sw < COEF_BITS) throw new Error('goertzelCell: the state word must hold the coefficient');
  const key = `${sw}${mux.tag}`;
  let d = cache.get(key);
  if (d) return d;
  const b = new Builder(6, 10, 4);
  b.pins('x', 'c', 'clr', 'clk');
  const one = b.op1(TIE1, [], 'always load', 'one');
  const zero = b.op1(TIE0, [], 'no carry in', 'zero');
  const nothing = b.op1(constWord(sw, 0), [], 'cleared state', 'zeros');
  b.next();
  const xs = b.op1(placed(GZ_IN, 0, sw), ['x'], 'sign-extended', 'xs');
  const r1 = b.op(register(sw), ['', one, 'clk'], 's[n−1]', 'r1');
  const r2 = b.op(register(sw), ['', one, 'clk'], 's[n−2]', 'r2');
  b.next();
  const cs = sw === COEF_BITS ? 'c' : b.op1(placed(COEF_BITS, 0, sw), ['c'], 'sign-extended', 'cs');
  const mul = b.op(treeMul(sw, true, sw + COEF_FRAC), [cs, `${r1}.q`], 'c × s[n−1]', 'mul');
  const nr2 = b.op1(notBus(sw), [`${r2}.q`], 'for the subtraction', 'nr2');
  b.next();
  const hi = b.op1(cut(sw + COEF_FRAC, COEF_FRAC, sw), [`${mul}.p`], 'down by 14', 'hi');
  const lo = b.op1(cut(sw + COEF_FRAC, COEF_FRAC - 1, 1), [`${mul}.p`], 'first bit dropped', 'lo');
  b.next();
  const rnd = b.op1(roundUp(sw), [hi, lo], 'round half up', 'rnd');
  b.next();
  const a1 = b.op(rca(sw), [rnd, xs, zero], '+ x[n]', 'a1');
  b.next();
  const a2 = b.op(rca(sw), [`${a1}.s`, nr2, one], '− s[n−2]', 'a2');
  b.next();
  const m1 = b.op1(mux.of(sw), [`${a2}.s`, nothing, 'clr'], 'clear?', 'm1');
  const m2 = b.op1(mux.of(sw), [`${r1}.q`, nothing, 'clr'], 'clear?', 'm2');
  b.wire(m1, `${r1}.d`);
  b.wire(m2, `${r2}.d`);
  b.wire(`${r1}.q`, 's1');
  b.wire(`${r2}.q`, 's2');
  const R = b.right;
  d = define({
    id: `goertzel${sw}${mux.tag}`, name: `Goertzel resonator (${sw}-bit state)${mux.tag ? ' (RV16)' : ''}`, category: 'arithmetic',
    summary: `s[n] = x[n] + c·s[n−1] − s[n−2] with c in Q2.${COEF_FRAC}: one ${sw} × ${sw} multiplier, two adders, two registers and a clear. After a block of N samples, the power at the frequency c stands for is s1² + s2² − c·s1·s2.`,
    ports: [bus('x', GZ_IN, 'in'), bus('c', COEF_BITS, 'in'), { name: 'clr', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('s1', sw, 'out'), bus('s2', sw, 'out')],
    symbol: { kind: 'box', label: 'GOERTZEL', w: 10 },
    netlist: () => ({ pins: { x: [0, 2], c: [0, 8], clr: [0, 14], clk: [0, 20], s1: [R, 6], s2: [R, 14] }, instances: b.instances, nets: b.nets() }),
  });
  cache.set(key, d);
  return d;
}
