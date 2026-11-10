// The device puzzles' reference circuits (Show answer, Do it for me, and the par a circuit's NANDs are graded against): each a
// chip with the device, a clock pin and the controller in library gates and flip-flops, drawn by docFromDef as a learner would
// have drawn it. Their behaviour step by step is REFERENCE_CONTROLLERS', written out in TypeScript (tests/puzzle-devices.test.ts
// plays both on every test and compares every pin of every step). No DOM.

import { Builder } from '../lib/builder';
import { addSub, rca } from '../lib/combinational';
import { merger, splitter } from '../lib/define';
import { AND, NOT, OR, XOR } from '../lib/gates';
import { DFF, register } from '../lib/sequential';
import { TIE0, TIE1 } from '../lib/transistors';
import type { ComponentDef } from '../sim/types';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { deviceDef } from '../editor/devparts';
import type { DeviceId } from './devices';

/** The reference controllers as functions of the sense pins (fresh state per call): the circuits below, step for step. */
export const REFERENCE_CONTROLLERS: Record<DeviceId, () => (sense: number[]) => number[]> = {
  // a Moore machine: G (cars go) until a press has waited and green has lasted 6 steps, Y for 2, WALK for 4, one step of
  // all red to clear, back to G; a 3-bit step counter, cleared on each change of state (it wraps in a long green)
  crossing: () => {
    let s = 0, c = 0;
    return ([req]) => {
      const out = [s >= 2 ? 1 : 0, s === 1 ? 1 : 0, s === 0 ? 1 : 0, s === 2 ? 1 : 0];
      const adv = s === 0 ? req === 1 && c >= 5 : s === 1 ? c >= 1 : s === 2 ? c >= 3 : true;
      if (adv) { s = (s + 1) & 3; c = 0; } else c = (c + 1) & 7;
      return out;
    };
  },
  // the left-hand rule with one flip-flop: after a left turn, always forward (else it would turn round where it came from)
  maze: () => {
    let t = 0;
    return ([wf, wl, , goal]) => {
      const go = goal ? 0 : 1;
      const f = go & (t | (wl & (1 - wf))), l = go & (1 - t) & (1 - wl), r = go & (1 - t) & wl & wf;
      t = l;
      return [f, l, r];
    };
  },
  // credit in 5¢ units (4 bits) and a pay bit: vend on buy with 30¢ or more; then (or on refund) return 10¢, then 5¢, until 0
  vend: () => {
    let cr = 0, pay = 0;
    return ([coin, buy, refund]) => {
      const vend = buy === 1 && cr >= 6 && !pay ? 1 : 0;
      const chg = pay ? (cr >= 2 ? 2 : cr >= 1 ? 1 : 0) : 0;
      const next = (cr + [0, 1, 2, 5][coin] - 6 * vend - chg) & 15;
      pay = (pay || vend || refund) && next !== 0 ? 1 : 0;
      cr = next;
      return [vend, chg];
    };
  },
};

const CLK = { name: 'clk', width: 1, dir: 'in' as const, clock: true };

function crossingDef(): ComponentDef {
  const b = new Builder(10, 10, 4);
  b.pins('clk');
  const ff = (n: string) => b.add(DFF, n, n);
  const s0 = ff('s0'), s1 = ff('s1'), c0 = ff('c0'), c1 = ff('c1'), c2 = ff('c2');
  for (const f of [s0, s1, c0, c1, c2]) b.wire('clk', `${f}.clk`);
  const q = (f: string) => b.name(`${f}.q`, f, true);
  const S0 = q(s0), S1 = q(s1), C0 = q(c0), C1 = q(c1), C2 = q(c2);
  b.next();
  const ns0 = b.op1(NOT, [S0]), ns1 = b.op1(NOT, [S1]);
  const g = b.name(b.op1(AND, [ns1, ns0], 'green'), 'car_g', true);
  const y = b.name(b.op1(AND, [ns1, S0], 'yellow'), 'car_y', true);
  const w = b.name(b.op1(AND, [S1, ns0], 'walk'), 'walk', true);
  const sc = b.op1(AND, [S1, S0], 'clear');
  b.next();
  const o10 = b.op1(OR, [C1, C0]), a10 = b.name(b.op1(AND, [C1, C0]), 'c1c0', true);
  const advG = b.op1(AND, ['', b.op1(AND, [C2, o10])], 'G: press, 6 steps', 'advg');
  const advY = b.op1(OR, [C2, o10], 'Y: 2 steps');
  const advW = b.op1(OR, [C2, a10], 'W: 4 steps');
  b.next();
  const adv = b.name(b.op1(OR, [b.op1(OR, [b.op1(AND, [g, advG]), b.op1(AND, [y, advY])]), b.op1(OR, [b.op1(AND, [w, advW]), sc])], 'next state'), 'adv', true);
  b.next();
  b.wire(b.op1(XOR, [S0, adv]), `${s0}.d`);
  b.wire(b.op1(XOR, [S1, b.op1(AND, [adv, S0])]), `${s1}.d`);
  const nadv = b.op1(NOT, [adv]);
  b.wire(b.op1(AND, [b.op1(NOT, [C0]), nadv]), `${c0}.d`);
  b.wire(b.op1(AND, [b.op1(XOR, [C1, C0]), nadv]), `${c1}.d`);
  b.wire(b.op1(AND, [b.op1(XOR, [C2, a10]), nadv]), `${c2}.d`);
  b.next();
  const dev = b.op(deviceDef('crossing'), [S1, y, g, w, 'clk'], 'crossing', 'dev');
  b.wire(b.name(`${dev}.req`, 'req', true), 'advg.a');
  return top('crossing', b);
}

function mazeDef(): ComponentDef {
  const b = new Builder(10, 10, 4);
  b.pins('clk');
  const tf = b.add(DFF, 'turned', 'turned');
  b.wire('clk', `${tf}.clk`);
  const t = b.name(`${tf}.q`, 'turned', true);
  b.next();
  const wf = 'dev.wall_f', wl = 'dev.wall_l', goal = 'dev.goal';
  const ng = b.op1(NOT, [goal], 'not at goal'), nt = b.op1(NOT, [t]), nwf = b.op1(NOT, [wf]), nwl = b.op1(NOT, [wl]);
  b.next();
  const free = b.op1(AND, [ng, nt], 'free to turn');
  const fwd = b.name(b.op1(AND, [ng, b.op1(OR, [t, b.op1(AND, [wl, nwf])])], 'forward'), 'fwd', true);
  const left = b.name(b.op1(AND, [free, nwl], 'left'), 'left', true);
  const right = b.name(b.op1(AND, [free, b.op1(AND, [wl, wf])], 'right'), 'right', true);
  b.wire(left, `${tf}.d`);
  b.next();
  b.op(deviceDef('maze'), [fwd, left, right, 'clk'], 'maze', 'dev');
  for (const n of ['wall_f', 'wall_l', 'wall_r', 'goal']) b.name(`dev.${n}`, n, true);
  return top('maze', b);
}

function vendDef(): ComponentDef {
  const b = new Builder(10, 10, 4);
  b.pins('clk');
  const credit = b.add(register(4), 'credit (5¢ units)', 'credit');
  const pay = b.add(DFF, 'paying out', 'pay');
  b.wire(b.op1(TIE1, []), `${credit}.en`);
  b.wire('clk', `${credit}.clk`);
  b.wire('clk', `${pay}.clk`);
  const K = b.name(`${credit}.q`, 'credit', true), P = b.name(`${pay}.q`, 'pay', true);
  b.next();
  const ks = b.op(splitter([1, 1, 1, 1]), [K], 'credit bits');
  const [k0, k1, k2, k3] = [0, 1, 2, 3].map((i) => `${ks}.o${i}`);
  const cs = b.op(splitter([1, 1]), ['dev.coin'], 'coin');
  const enough = b.op1(OR, [k3, b.op1(AND, [k2, k1])], '≥ 30¢');
  const ge2 = b.op1(OR, [k3, b.op1(OR, [k2, k1])], '≥ 10¢');
  b.next();
  const vend = b.name(b.op1(AND, ['dev.buy', b.op1(AND, [enough, b.op1(NOT, [P])])], 'vend'), 'vend', true);
  const chg1 = b.op1(AND, [P, ge2], 'return 10¢');
  const chg0 = b.op1(AND, [P, b.op1(AND, [b.op1(NOT, [ge2]), k0])], 'return 5¢');
  const u = b.op1(merger([1, 1, 1, 1]), [`${cs}.o0`, b.op1(AND, [`${cs}.o1`, b.op1(NOT, [`${cs}.o0`])]), b.op1(AND, [`${cs}.o1`, `${cs}.o0`]), b.op1(TIE0, [])], 'coin value');
  b.next();
  const chg = b.name(b.op1(merger([1, 1]), [chg0, chg1], 'change'), 'chg', true);
  const subv = b.op1(merger([1, 1, 1, 1]), [chg0, b.op1(OR, [vend, chg1]), vend, b.op1(TIE0, [])], 'taken out');
  const sum = b.op1(rca(4), [K, u, b.op1(TIE0, [])], 'credit + coin', 'add');
  b.next();
  const next = b.name(b.op1(addSub(4), [sum, subv, b.op1(TIE1, [])], '− item − change', 'sub'), 'next', true);
  b.wire(next, `${credit}.d`);
  const ns = b.op(splitter([1, 1, 1, 1]), [next], 'next bits');
  const nz = b.op1(OR, [b.op1(OR, [`${ns}.o0`, `${ns}.o1`]), b.op1(OR, [`${ns}.o2`, `${ns}.o3`])], 'any left');
  b.wire(b.op1(AND, [b.op1(OR, [P, b.op1(OR, [vend, 'dev.refund'])]), nz], 'keep paying'), `${pay}.d`);
  b.next();
  b.op(deviceDef('vend'), [vend, chg, 'clk'], 'vending machine', 'dev');
  for (const n of ['coin', 'buy', 'refund']) b.name(`dev.${n}`, n, true);
  return top('vend', b);
}

function top(dev: DeviceId, b: Builder): ComponentDef {
  return {
    id: `pzdev_ref_${dev}`, name: `${dev} controller`, category: 'sequential', symbol: { kind: 'box', label: 'CONTROLLER' },
    ports: [CLK],
    netlist: () => ({ pins: { clk: [0, 4] }, instances: b.instances, nets: b.nets() }),
  };
}

const built = new Map<DeviceId, ComponentDef>();

/** A device's reference circuit (memoized). */
export function referenceDef(dev: DeviceId): ComponentDef {
  let d = built.get(dev);
  if (!d) built.set(dev, (d = dev === 'crossing' ? crossingDef() : dev === 'maze' ? mazeDef() : vendDef()));
  return d;
}

const TIE_REF = (d: ComponentDef): PartRef | undefined =>
  d === TIE0 ? { const: { width: 1, value: 0 } } : d === TIE1 ? { const: { width: 1, value: 1 } } : undefined;

/** The reference as a chip document (id and name of the puzzle chip). */
export function referenceChip(dev: DeviceId, id: string, name: string): ChipDoc {
  const doc = docFromDef(referenceDef(dev), { id, name, refOf: TIE_REF });
  if ('error' in doc) throw new Error(`device reference ${dev}: ${doc.error}`);
  return doc;
}
