// Chapter 39 and 40's relays at switch level: the telegraph repeater (a coil on the incoming line closes a contact that
// puts a local battery on the next line), and below, the dial exchange (pulse counter, selector, crossbar). Every part is
// relay(n) contacts and coils on SwitchSim, so time counts relay steps. Outputs end on a load (the next coil, drawn as a
// pull-down) like lib/relays.ts.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { define, merger, ones } from './define';
import { RELAY, relay } from './relays';
import { PULLDOWN } from './switchparts';
import { GND, VDD } from './transistors';

function memo<A extends unknown[]>(f: (...a: A) => ComponentDef): (...a: A) => ComponentDef {
  const cache = new Map<string, ComponentDef>();
  return (...a: A) => {
    const k = JSON.stringify(a);
    let d = cache.get(k);
    if (!d) cache.set(k, (d = f(...a)));
    return d;
  };
}

const bit = (name: string, dir: 'in' | 'out' | 'inout', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const load = (name: string, at: [number, number]): InstanceDef => ({ name, def: PULLDOWN, at, label: 'load' });

/**
 * One station of a telegraph line: the incoming line feeds the coil, and the relay's make contact puts the station's
 * own battery on the outgoing line. The signal arrives weak and leaves at full strength; it is a copy, one relay step
 * later.
 */
export const TELEGRAPH_RELAY: ComponentDef = define({
  id: 'telegraph_relay', name: 'Telegraph repeater', category: 'sequential',
  summary: 'A relay on the incoming line, a local battery behind its make contact: the next line gets the full battery voltage, one relay step later.',
  ports: [bit('line', 'in'), bit('out', 'out')],
  symbol: { kind: 'box', label: 'REPEAT', w: 6, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { line: [2, 5], out: [20, 10] },
    instances: [
      { name: 'r', def: RELAY, at: [6, 4] }, { name: 'g', def: GND, at: [6, 9] }, { name: 'bat', def: VDD, at: [9, 1] },
      load('ld', [14, 10]),
    ],
    nets: [
      { name: 'line', ends: ['line', 'r.a'] }, { name: 'gnd', ends: ['r.b', 'g.p'] }, { name: 'battery', ends: ['bat.p', 'r.c'] },
      { name: 'out', ends: ['r.no', 'ld.y', 'out'], trunk: 12 },
    ],
  }),
  notes: `The relay was first used for exactly this: a telegraph line weakens with its length, and a relay at the end of a section re-sends the signal from a fresh battery. Here the coil is the line's end and the battery a rail.`,
});

/** key → n repeater stations → sounder: the key's level reaches the sounder n relay steps later. */
export const telegraphChain = memo((n: number): ComponentDef => {
  if (!(n >= 1 && n <= 6)) throw new Error(`telegraphChain: 1 to 6 stations, not ${n}`);
  const X0 = 6, P = 12;
  const instances: InstanceDef[] = [], nets: NetDef[] = [];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `st${i}`, def: TELEGRAPH_RELAY, at: [X0 + P * i, 3] });
    nets.push(i === 0 ? { name: 'key', ends: ['key', 'st0.line'] } : { name: `line${i}`, ends: [`st${i - 1}.out`, `st${i}.line`] });
  }
  nets.push({ name: 'sounder', ends: [`st${n - 1}.out`, 'sounder'] });
  return define({
    id: `telegraph${n}`, name: `Telegraph, key to sounder through ${n} repeater${n === 1 ? '' : 's'}`, category: 'sequential',
    summary: `A key, ${n} relay${n === 1 ? '' : 's'} each re-sending from a battery of its own, and the sounder at the end. The sounder follows the key ${n} relay step${n === 1 ? '' : 's'} later.`,
    ports: [bit('key', 'in'), bit('sounder', 'out')],
    symbol: { kind: 'box', label: `TEL${n}`, w: 6, h: 4 },
    spec: ([k]) => [k],
    netlist: () => ({
      level: 'switch',
      pins: { key: [2, 5], sounder: [X0 + P * n, 5] },
      instances, nets,
    }),
  });
});
for (let n = 1; n <= 4; n++) telegraphChain(n);



const relayAt = (name: string, poles: number, x: number, y = 6): InstanceDef[] => [
  { name, def: relay(poles), at: [x, y] }, { name: `g${name}`, def: GND, at: [x, y + 5] },
];
/** Pole i (0-based) of a relay(n) at [x, y]: its common above, break and make contacts below. */
const poleName = (n: number, i: number) => (n === 1 ? ['c', 'no', 'nc'] : [`c${i + 1}`, `no${i + 1}`, `nc${i + 1}`]);

/**
 * One stage of a relay pulse counter: it toggles on the falling edge of its input p, however long the pulse lasts.
 * pr follows p (the pulse relay); m (master) and s (slave) are held through the hold rail h:
 *     m' = p ? ¬s : m      s' = p ? s : m
 * while p is up m copies the inverse of s, and when p falls s copies m: s has toggled. q is s (a line at h while s is
 * operated) and clocks the next stage. `extra` more poles on s are the selector's contact tree (c, nc, no per pole).
 * Dropping h releases m and s, so the count returns to 0.
 */
export const countStage = memo((extra: number): ComponentDef => {
  if (!(extra >= 0 && extra <= 4)) throw new Error(`countStage: 0 to 4 extra poles, not ${extra}`);
  const ns = 2 + extra;
  const [s1c, , s1nc] = poleName(ns, 0), [s2c, s2no] = poleName(ns, 1);
  const xs = 40, xEnd = xs + 3 * ns + 2;
  const instances: InstanceDef[] = [...relayAt('pr', 2, 8), ...relayAt('m', 2, 24), ...relayAt('s', ns, xs), load('ld', [xEnd + 2, 12])];
  const treeC = (j: number) => poleName(ns, 2 + j)[0], treeNo = (j: number) => poleName(ns, 2 + j)[1], treeNc = (j: number) => poleName(ns, 2 + j)[2];
  const pins: Record<string, [number, number]> = { p: [2, 7], h: [30, 1], q: [xEnd + 8, 12] };
  const nets: NetDef[] = [
    { name: 'p', ends: ['p', 'pr.a'] },
    { name: 'gnd pr', ends: ['pr.b', 'gpr.p'] }, { name: 'gnd m', ends: ['m.b', 'gm.p'] }, { name: 'gnd s', ends: ['s.b', 'gs.p'] },
    { name: 'coil m', ends: ['pr.c1', 'm.a'], tags: true }, { name: 'coil s', ends: ['pr.c2', 's.a'], tags: true },
    { name: 'A', ends: ['pr.no1', `s.${s1nc}`], tags: true }, { name: 'B', ends: ['pr.nc1', 'm.no1'], tags: true },
    { name: 'D', ends: ['pr.nc2', 'm.no2'], tags: true },
    { name: 'hold', ends: ['h', 'm.c1', 'm.c2', `s.${s1c}`, `s.${s2c}`], tags: true },
    { name: 'q', ends: [`s.${s2no}`, 'ld.y', 'q', 'pr.no2'], tags: ['pr.no2'] },
  ];
  const ports: PortDef[] = [bit('p', 'in', 'left'), bit('h', 'inout', 'top'), bit('q', 'out', 'right')];
  for (let j = 0; j < extra; j++) {
    const x = xs + 3 * (2 + j) + 4;
    pins[`tc${j}`] = [x, 1]; pins[`tn${j}`] = [x - 1, 16]; pins[`ty${j}`] = [x + 1, 16];
    ports.push(bit(`tc${j}`, 'inout', 'top'), bit(`tn${j}`, 'inout', 'bottom'), bit(`ty${j}`, 'inout', 'bottom'));
    nets.push({ name: `tree c${j}`, ends: [`tc${j}`, `s.${treeC(j)}`] }, { name: `tree nc${j}`, ends: [`s.${treeNc(j)}`, `tn${j}`] }, { name: `tree no${j}`, ends: [`s.${treeNo(j)}`, `ty${j}`] });
  }
  return define({
    id: `count_stage${extra ? `_${extra}` : ''}`, name: `Relay toggle stage${extra ? `, ${extra} tree pole${extra === 1 ? '' : 's'}` : ''}`, category: 'sequential',
    summary: 'Three relays: pulse relay, master and slave. Toggles on the falling edge of p, once per pulse however long it lasts; dropping the hold rail h clears it.',
    ports,
    symbol: { kind: 'box', label: 'TOGGLE', w: Math.max(8, 2 * Math.max(1 + extra, 2 * extra) + 2) },
    netlist: () => ({ level: 'switch', pins, instances, nets }),
  });
});
for (const k of [0, 1, 2, 4]) countStage(k);

/** The hold rail: VDD through a relay's break contact. Hanging up (operating it) opens the rail and releases whatever it feeds. */
function holdRail(at: [number, number]): { instances: InstanceDef[] } {
  const [x, y] = at;
  return { instances: [{ name: 'hr', def: relay(1), at: [x, y] }, { name: 'ghr', def: GND, at: [x - 4, y + 6] }, { name: 'vhr', def: VDD, at: [x + 3, y - 3] }] };
}

/**
 * A 3-bit relay pulse counter, one toggle stage per bit, the stages in a ripple (each clocked by the one before). pulse
 * is the dial's loop contact: the count advances on each falling edge. hangup operates the relay that opens the hold
 * rail, which releases every stage: the counter is back at 0.
 */
export const DIAL_COUNTER: ComponentDef = define({
  id: 'dial_counter', name: 'Relay pulse counter', category: 'sequential',
  summary: 'Three toggle stages of three relays each (pulse relay, master, slave) and a hang-up relay. Counts dial pulses 0 to 7, one per falling edge; hangup clears it.',
  ports: [bit('pulse', 'in'), bit('hangup', 'in'), { name: 'count', width: 3, dir: 'out' }],
  symbol: { kind: 'box', label: 'PULSES', w: 12, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { pulse: [2, 6], hangup: [2, 19], count: [86, 6] },
    instances: [
      ...holdRail([6, 18]).instances,
      { name: 'st0', def: countStage(0), at: [14, 4] }, { name: 'st1', def: countStage(0), at: [34, 4] }, { name: 'st2', def: countStage(0), at: [54, 4] },
      { name: 'ms', def: merger(ones(3), 2), at: [72, 3] },
    ],
    nets: [
      { name: 'pulse', ends: ['pulse', 'st0.p'] }, { name: 'hangup', ends: ['hangup', 'hr.a'] },
      { name: 'gnd', ends: ['hr.b', 'ghr.p'] }, { name: 'vdd', ends: ['vhr.p', 'hr.c'] },
      { name: 'hold', ends: ['hr.nc', 'st0.h', 'st1.h', 'st2.h'], tags: true },
      { name: 'n0', ends: ['st0.q', 'st1.p', 'ms.i0'], tags: ['ms.i0'] }, { name: 'n1', ends: ['st1.q', 'st2.p', 'ms.i1'], tags: ['ms.i1'] },
      { name: 'n2', ends: ['st2.q', 'ms.i2'], tags: ['ms.i2'] },
      { name: 'count', ends: ['ms.out', 'count'] },
    ],
  }),
});

/**
 * A stepping selector: the counter's three stages with a contact tree on their slave relays. The caller's line passes
 * through bit 0's changeover, then bit 1's, then bit 2's: after n pulses it is connected to output n of 8, and the other
 * seven stay open. The tree is only contacts on relays that exist anyway, so selecting adds no relay step. Hanging up
 * releases the stages and the line falls back to output 0.
 *     level 1 (bit 0):  line → x[b0]            level 2 (bit 1): x[j] → z[j + 2 b1]
 *     level 3 (bit 2):  z[j] → y[j + 4 b2]
 */
export const DIAL_SELECTOR: ComponentDef = define({
  id: 'dial_selector', name: 'Dial selector, 1 of 8', category: 'routing',
  summary: 'The pulse counter with a three-level contact tree: after n pulses the caller line is connected to output n. 10 relays, no extra step for the tree.',
  ports: [bit('line', 'inout', 'left'), bit('pulse', 'in', 'left'), bit('hangup', 'in', 'left'), { name: 'count', width: 3, dir: 'out' }, { name: 'y', width: 8, dir: 'out' }],
  symbol: { kind: 'box', label: 'SELECTOR', w: 14 },
  netlist: () => {
    const loads: InstanceDef[] = Array.from({ length: 8 }, (_, i) => load(`ld${i}`, [20 + 6 * i, 22]));
    const nets: NetDef[] = [
      { name: 'pulse', ends: ['pulse', 'st0.p'] }, { name: 'hangup', ends: ['hangup', 'hr.a'] },
      { name: 'gnd', ends: ['hr.b', 'ghr.p'] }, { name: 'vdd', ends: ['vhr.p', 'hr.c'] },
      { name: 'hold', ends: ['hr.nc', 'st0.h', 'st1.h', 'st2.h'], tags: true },
      { name: 'n0', ends: ['st0.q', 'st1.p', 'mc.i0'], tags: ['mc.i0'] }, { name: 'n1', ends: ['st1.q', 'st2.p', 'mc.i1'], tags: ['mc.i1'] },
      { name: 'n2', ends: ['st2.q', 'mc.i2'], tags: ['mc.i2'] },
      { name: 'count', ends: ['mc.out', 'count'] },
      { name: 'line', ends: ['line', 'st0.tc0'], tags: true },
      { name: 'x0', ends: ['st0.tn0', 'st1.tc0'], tags: true }, { name: 'x1', ends: ['st0.ty0', 'st1.tc1'], tags: true },
      { name: 'z0', ends: ['st1.tn0', 'st2.tc0'], tags: true }, { name: 'z2', ends: ['st1.ty0', 'st2.tc2'], tags: true },
      { name: 'z1', ends: ['st1.tn1', 'st2.tc1'], tags: true }, { name: 'z3', ends: ['st1.ty1', 'st2.tc3'], tags: true },
      { name: 'y', ends: ['my.out', 'y'] },
    ];
    for (let j = 0; j < 4; j++) {
      nets.push({ name: `y${j}`, ends: [`st2.tn${j}`, `ld${j}.y`, `my.i${j}`], tags: true }, { name: `y${j + 4}`, ends: [`st2.ty${j}`, `ld${j + 4}.y`, `my.i${j + 4}`], tags: true });
    }
    return {
      level: 'switch',
      pins: { line: [2, 10], pulse: [2, 6], hangup: [2, 30], count: [100, 6], y: [92, 29] },
      instances: [
        ...holdRail([6, 26]).instances,
        { name: 'st0', def: countStage(1), at: [14, 4] }, { name: 'st1', def: countStage(2), at: [34, 4] }, { name: 'st2', def: countStage(4), at: [58, 4] },
        { name: 'mc', def: merger(ones(3), 2), at: [92, 3] }, { name: 'my', def: merger(ones(8), 2), at: [74, 24] },
        ...loads,
      ],
      nets,
    };
  },
});
