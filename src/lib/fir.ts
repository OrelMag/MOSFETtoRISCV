// The signals chapter's FIR filter in gates: five sample registers and a tree of adders, no multiplier. The taps 1 4 6 4 1 are shifts:
// 4 is two places, 6 is 4 + 2, and the symmetric pairs share an adder. comm/signals.ts FirModel is compared every cycle (tests/comm-signals.test.ts).

import { FIR_IN, FIR_OUT } from '../comm/signals';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

/** Pure wiring: an 8-bit two's complement word times 2^s as a 12-bit word: zeros below, copies of the sign above. No gates. */
const FIR_SCALE = (s: number): ComponentDef => {
  const id = `fir_scale${s}`;
  return define({
    id, name: `× ${2 ** s}, sign-extended`, category: 'plumbing',
    summary: `Wiring: moves the word up ${s} place${s === 1 ? '' : 's'} and repeats its sign bit above it. Costs nothing.`,
    ports: [bus('a', FIR_IN, 'in'), bus('y', FIR_OUT, 'out')],
    symbol: { kind: 'box', label: `×${2 ** s}`, w: 6, h: 4 },
    spec: ([a]) => [(((a >= 128 ? a - 256 : a) * 2 ** s) + 4096) % 4096],
    netlist: () => ({
      pins: { a: [1, 6], y: [28, 6] },
      instances: [...(s > 0 ? [{ name: 'z', def: TIE0, at: [8, 26] as [number, number] }] : []), { name: 'sp', def: splitter(ones(FIR_IN), 2), at: [4, 0] }, { name: 'm', def: merger(ones(FIR_OUT), 2), at: [22, 0] }],
      nets: [
        { name: 'a', ends: ['a', 'sp.in'] },
        ...(s > 0 ? [{ name: 'zero', ends: ['z.y', ...Array.from({ length: s }, (_, i) => `m.i${i}`)], tags: true as const }] : []),
        ...Array.from({ length: FIR_IN - 1 }, (_, i) => ({ name: `b${i}`, ends: [`sp.o${i}`, `m.i${i + s}`] })),
        { name: 'sign', ends: [`sp.o${FIR_IN - 1}`, ...Array.from({ length: FIR_OUT - FIR_IN + 1 - s }, (_, i) => `m.i${FIR_IN - 1 + s + i}`)], tags: true as const },
        { name: 'y', ends: ['m.out', 'y'] },
      ],
    }),
  });
};

const SCALE1 = FIR_SCALE(0), SCALE2 = FIR_SCALE(1), SCALE4 = FIR_SCALE(2);

/** Gate delays from a clock edge to the output's last change, worst over random samples: the ripple carries, pinned by the test. */
export const FIR_SETTLE = 40;

/** y = x0 + 4 x1 + 6 x2 + 4 x3 + x4, with the pairs that share a tap summed first. */
export const FIR5: ComponentDef = define({
  id: 'fir5', name: 'FIR filter (1 4 6 4 1)', category: 'arithmetic',
  summary: 'A low-pass filter with no multiplier: five sample registers, shifts for the taps (wiring), and five 12-bit adders. Gain 16 at DC, 0 at half the sample rate.',
  ports: [bus('x', FIR_IN, 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('y', FIR_OUT, 'out')],
  symbol: { kind: 'box', label: 'FIR', w: 8 },
  netlist: () => {
    const b = new Builder(10, 12);
    b.pins('x', 'clk');
    const load = b.op(TIE1, [], 'always load', 'one');
    const gnd = b.op(TIE0, [], 'no carry in', 'zero');
    b.next();
    let d = 'x';
    const regs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = b.op(register(FIR_IN), [d, `${load}.y`, 'clk'], `x[n−${i}]`, `x${i}`);
      regs.push(r);
      d = `${r}.q`;
      b.name(d, `x${i}`, true);
    }
    b.next();
    const s1 = (r: string, def: ComponentDef, nm: string) => b.op(def, [`${r}.q`], undefined, nm);
    const a0 = s1(regs[0], SCALE1, 'w0'), a4 = s1(regs[4], SCALE1, 'w4'), a1 = s1(regs[1], SCALE4, 'w1'), a3 = s1(regs[3], SCALE4, 'w3'), t4 = s1(regs[2], SCALE4, 'w2a'), t2 = s1(regs[2], SCALE2, 'w2b');
    b.next();
    const add = rca(FIR_OUT);
    const sEnds = b.op(add, [`${a0}.y`, `${a4}.y`, `${gnd}.y`], 'x0 + x4', 'sum04');
    const sMid = b.op(add, [`${a1}.y`, `${a3}.y`, `${gnd}.y`], '4 (x1 + x3)', 'sum13');
    const sSix = b.op(add, [`${t4}.y`, `${t2}.y`, `${gnd}.y`], '6 x2', 'six');
    b.next();
    const s2 = b.op(add, [`${sEnds}.s`, `${sMid}.s`, `${gnd}.y`], undefined, 'sumA');
    b.next();
    const s3 = b.op(add, [`${s2}.s`, `${sSix}.s`, `${gnd}.y`], undefined, 'sumB');
    b.next();
    b.wire(`${s3}.s`, 'y');
    // the last adder sits level with the 6·x2 sum it takes, so that wire no longer climbs through the one before
    const last = b.instances.find((i) => i.name === 'sumB')!;
    last.at = [last.at![0], 14];
    const R = b.right;
    return { pins: { x: [0, 6], clk: [0, 22], y: [R, 17] }, instances: b.instances, nets: b.nets() };
  },
});
