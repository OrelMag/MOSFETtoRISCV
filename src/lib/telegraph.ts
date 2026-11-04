// Chapter 39 and 40's relays at switch level: the telegraph repeater (a coil on the incoming line closes a contact that
// puts a local battery on the next line), and below, the dial exchange (pulse counter, selector, crossbar). Every part is
// relay(n) contacts and coils on SwitchSim, so time counts relay steps. Outputs end on a load (the next coil, drawn as a
// pull-down) like lib/relays.ts.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { define, merger, ones, splitter } from './define';
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
  symbol: { kind: 'box', label: 'REPEAT', w: 10, h: 4 },
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
  const X0 = 6, P = 16;
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
  ports: [bit('line', 'in', 'left'), bit('pulse', 'in', 'left'), bit('hangup', 'in', 'left'), { name: 'count', width: 3, dir: 'out' }, { name: 'y', width: 8, dir: 'out' }],
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

/**
 * One crosspoint: a relay that joins a row line to a column line (pole 1), and holds itself through the row's hold rail
 * (pole 2) once the select path has fed its coil. Pole 3 marks the column busy. Operating takes the select path; letting
 * the select go changes nothing.
 */
export const CROSSPOINT: ComponentDef = define({
  id: 'crosspoint', name: 'Crossbar crosspoint', category: 'routing',
  summary: 'A 3-pole relay: row to column contacts, a hold contact from the row hold rail back to its own coil, and a busy contact onto the column.',
  ports: [bit('row', 'inout', 'left'), bit('col', 'inout', 'right'), bit('sel', 'in', 'top'), bit('hold', 'inout', 'top'), bit('busy', 'inout', 'bottom')],
  symbol: { kind: 'box', label: 'X', w: 10, h: 6 },
  netlist: () => ({
    level: 'switch',
    pins: { row: [0, 3], col: [36, 3], sel: [8, 0], hold: [24, 0], busy: [30, 20] },
    instances: [{ name: 'x', def: relay(3), at: [12, 8] }, { name: 'gx', def: GND, at: [12, 13] }],
    nets: [
      { name: 'gnd', ends: ['x.b', 'gx.p'] },
      { name: 'coil', ends: ['sel', 'x.a', 'x.no2'], tags: true },
      { name: 'row', ends: ['row', 'x.c1'], tags: true }, { name: 'col', ends: ['x.no1', 'col'], tags: true },
      { name: 'hold', ends: ['hold', 'x.c2', 'x.c3'], tags: true }, { name: 'busy', ends: ['x.no3', 'busy'], tags: true },
    ],
  }),
});

/**
 * A 3 × 3 crossbar exchange. Rows are the callers' lines, columns the called lines, and a crosspoint joins one to the
 * other with a contact that conducts speech both ways. A call is set up by raising a row select rs[r] and a column
 * select cs[c] together: the row relay puts a feed on its line, the column relay passes it to crosspoint (r, c), which
 * pulls in and holds itself, so both selects can drop. The column select goes through the column's busy relay's break
 * contact: while any crosspoint of the column is held, selecting it does nothing, and busy[c] says so. hang[r] opens row
 * r's hold rail and clears that caller's call. Relays: 9 crosspoints, 3 row selects, 3 column selects, 3 busy, 3 hang-ups.
 */
export const CROSSBAR3: ComponentDef = define({
  id: 'crossbar3', name: 'Crossbar 3 × 3', category: 'routing',
  summary: 'Nine crosspoint relays on a 3 × 3 grid (21 relays with the selects). Two calls at once; a call to a busy column is refused and busy[c] is raised.',
  ports: [
    { name: 'rs', width: 3, dir: 'in' }, { name: 'cs', width: 3, dir: 'in' }, { name: 'hang', width: 3, dir: 'in' },
    { name: 'row', width: 3, dir: 'inout' }, { name: 'col', width: 3, dir: 'inout' }, { name: 'busy', width: 3, dir: 'out' },
  ],
  symbol: { kind: 'box', label: 'CROSSBAR 3×3', w: 16 },
  netlist: () => {
    const OY = 14, X0 = 44, DX = 20, Y0 = OY + 8, DY = 14;
    const instances: InstanceDef[] = [
      { name: 'sr', def: splitter(ones(3), 2), at: [4, 4] }, { name: 'sc', def: splitter(ones(3), 2), at: [30, 2] }, { name: 'sh', def: splitter(ones(3), 2), at: [4, 60] },
      { name: 'sw', def: splitter(ones(3), 2), at: [4, 30] }, { name: 'sl', def: splitter(ones(3), 2), at: [4, 44] }, { name: 'mb', def: merger(ones(3), 2), at: [X0 + 3 * DX + 6, Y0 + 3 * DY] },
    ];
    const nets: NetDef[] = [
      { name: 'rs', ends: ['rs', 'sr.in'] }, { name: 'cs', ends: ['cs', 'sc.in'] }, { name: 'hang', ends: ['hang', 'sh.in'] },
      { name: 'row', ends: ['row', 'sw.in'] }, { name: 'col', ends: ['col', 'sl.in'] }, { name: 'busy', ends: ['mb.out', 'busy'] },
      { name: 'vdd', ends: [], tags: true },
    ];
    const vddEnds: string[] = [];
    for (let r = 0; r < 3; r++) {
      const y = Y0 + DY * r;
      instances.push(
        { name: `sel${r}`, def: relay(1), at: [10, y] }, { name: `gsel${r}`, def: GND, at: [10, y + 5] },
        load(`lr${r}`, [34, y]), { name: `hr${r}`, def: relay(1), at: [24, y] }, { name: `ghr${r}`, def: GND, at: [20, y + 6] },
      );
      nets.push(
        { name: `rs${r}`, ends: [`sr.o${r}`, `sel${r}.a`], tags: true }, { name: `gnd sel${r}`, ends: [`sel${r}.b`, `gsel${r}.p`] },
        { name: `hang${r}`, ends: [`sh.o${r}`, `hr${r}.a`], tags: true }, { name: `gnd hr${r}`, ends: [`hr${r}.b`, `ghr${r}.p`] },
        { name: `feed${r}`, ends: [`sel${r}.no`, ...[0, 1, 2].map((c) => `sc${c}.c${r + 1}`)], tags: true },
        { name: `hold${r}`, ends: [`hr${r}.nc`, ...[0, 1, 2].map((c) => `x${r}${c}.hold`)], tags: true },
        { name: `row${r}`, ends: [`sw.o${r}`, ...[0, 1, 2].map((c) => `x${r}${c}.row`), `lr${r}.y`], tags: true },
      );
      vddEnds.push(`sel${r}.c`, `hr${r}.c`);
    }
    for (let c = 0; c < 3; c++) {
      const x = X0 + DX * c;
      instances.push(
        { name: `bz${c}`, def: relay(1), at: [x, Y0 + 3 * DY + 4] }, { name: `gbz${c}`, def: GND, at: [x - 4, Y0 + 3 * DY + 10] },
        { name: `sc${c}`, def: relay(3), at: [x, OY - 12] }, { name: `gsc${c}`, def: GND, at: [x, OY - 7] },
        load(`lb${c}`, [x + 8, Y0 + 3 * DY - 4]), load(`lcl${c}`, [x + 14, OY - 20]),
      );
      nets.push(
        { name: `cs${c}`, ends: [`sc.o${c}`, `bz${c}.c`], tags: true }, { name: `gnd bz${c}`, ends: [`bz${c}.b`, `gbz${c}.p`] }, { name: `gnd sc${c}`, ends: [`sc${c}.b`, `gsc${c}.p`] },
        { name: `csel${c}`, ends: [`bz${c}.nc`, `sc${c}.a`], tags: true },
        { name: `busy${c}`, ends: [`bz${c}.a`, ...[0, 1, 2].map((r) => `x${r}${c}.busy`), `lb${c}.y`, `mb.i${c}`], tags: true },
        { name: `col${c}`, ends: [`sl.o${c}`, ...[0, 1, 2].map((r) => `x${r}${c}.col`), `lcl${c}.y`], tags: true },
      );
      for (let r = 0; r < 3; r++) {
        instances.push({ name: `x${r}${c}`, def: CROSSPOINT, at: [x, Y0 + DY * r] });
        nets.push({ name: `sel${r}${c}`, ends: [`sc${c}.no${r + 1}`, `x${r}${c}.sel`], tags: true });
      }
    }
    instances.push({ name: 'vcc', def: VDD, at: [2, 80] });
    nets[6] = { name: 'vdd', ends: ['vcc.p', ...vddEnds], tags: true };
    return {
      level: 'switch',
      pins: { rs: [0, 6], cs: [0, 12], hang: [0, 62], row: [0, 32], col: [0, 46], busy: [X0 + 3 * DX + 14, Y0 + 3 * DY] },
      instances, nets,
    };
  },
});

/** The crossbar on a bench for the chapter: what the three callers say goes in, what the three called lines hear comes out. */
export const CROSSBAR_EXCHANGE: ComponentDef = define({
  id: 'crossbar_exchange', name: 'Crossbar exchange on a bench', category: 'routing',
  summary: 'The 3 × 3 crossbar with its speech lines split by direction: talk[r] is what caller r says, heard[c] what called line c hears.',
  ports: [
    { name: 'rs', width: 3, dir: 'in' }, { name: 'cs', width: 3, dir: 'in' }, { name: 'hang', width: 3, dir: 'in' },
    { name: 'talk', width: 3, dir: 'in' }, { name: 'heard', width: 3, dir: 'out' }, { name: 'busy', width: 3, dir: 'out' },
  ],
  symbol: { kind: 'box', label: 'EXCHANGE', w: 12 },
  netlist: () => ({
    level: 'switch',
    pins: { rs: [2, 4], cs: [2, 8], hang: [2, 12], talk: [2, 16], heard: [34, 6], busy: [34, 12] },
    instances: [{ name: 'xb', def: CROSSBAR3, at: [12, 2] }],
    nets: [
      { name: 'rs', ends: ['rs', 'xb.rs'] }, { name: 'cs', ends: ['cs', 'xb.cs'] }, { name: 'hang', ends: ['hang', 'xb.hang'] },
      { name: 'talk', ends: ['talk', 'xb.row'] }, { name: 'heard', ends: ['xb.col', 'heard'] }, { name: 'busy', ends: ['xb.busy', 'busy'] },
    ],
  }),
});
