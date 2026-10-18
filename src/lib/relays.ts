// Prologue P1's relays at switch level (prim 'relay', SwitchSim). A relay is a coil and changeover contacts: while
// current flows through the coil the armature is pulled in and every pole's common (c) touches its make contact (no);
// released, a spring holds it on the break contact (nc). Contacts are metal on metal, so they pass a signal both ways
// at full strength, and a line nothing drives reads 0 because the coil it feeds pulls it down: relay logic's "an open
// line is 0". Outputs here end on a load (a pull-down: the next relay's coil drawn as its resistance), so a part
// tested alone reads 0, not Z. The armature moves one relay step (about 8 ms) after its coil changes; current
// through closed contacts arrives at once, which is what makes the carry through contacts fast.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { define, merger, splitter } from './define';
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

/** Poles' port names: c, no, nc for a one-pole relay; c1, no1, nc1, c2 … for more. */
const poleNames = (n: number, i: number) => (n === 1 ? ['c', 'no', 'nc'] : [`c${i + 1}`, `no${i + 1}`, `nc${i + 1}`]);

/** A relay with n changeover poles (1 … 6): ports a, b (the coil), then per pole c, no, nc. */
export const relay = memo((n: number): ComponentDef => {
  if (!(n >= 1 && n <= 6)) throw new Error(`relay: 1 to 6 poles, not ${n}`);
  const poles = Array.from({ length: n }, (_, i) => poleNames(n, i));
  return define({
    id: n === 1 ? 'relay' : `relay${n}`, name: n === 1 ? 'Relay' : `Relay, ${n} poles`, category: 'transistor', prim: 'relay',
    summary: `A coil and ${n === 1 ? 'one changeover contact' : `${n} changeover contacts`}. Current through the coil pulls the armature in one relay step (about 8 ms) later: then c touches no; released, c touches nc. Contacts conduct both ways.`,
    ports: [bit('a', 'inout'), bit('b', 'inout'), ...poles.flatMap(([c, no, nc]) => [bit(c, 'inout'), bit(no, 'inout'), bit(nc, 'inout')])],
    symbol: { kind: 'relay' },
    notes: `The coil's two ends are a and b; usually b goes to GND and a is the line that operates the relay. In this model the
      coil is a weak resistor between them (it pulls an undriven line to 0) and current flows when its ends differ. The
      armature follows the coil at the next <em>relay step</em>: every relay of the circuit moves at once, then the current
      through the contacts settles at once. A contact is a strong switch (strength 4), stronger than any resistor.
      Telephone relays carried up to a dozen springsets on one armature; ${n} here.`,
    hdl: { verilog: `// a relay: coil a–b, ${n} changeover contact${n === 1 ? '' : 's'} (electromechanical: not Verilog)` },
  });
});

export const RELAY = relay(1);
for (const n of [2, 3, 4, 5, 6]) relay(n);

/** A pull-down standing for the next relay's coil: the load that makes an open line read 0. */
const load = (name: string, at: [number, number]): InstanceDef => ({ name, def: PULLDOWN, at, label: 'load' });

/** NOT: the break contact from VDD. */
export const RELAY_NOT: ComponentDef = define({
  id: 'relay_not', name: 'Relay inverter', category: 'gate',
  summary: 'One relay: its break contact connects the output to VDD while the coil is off.',
  ports: [bit('a', 'in'), bit('y', 'out')],
  symbol: { kind: 'box', label: 'R¬', w: 4, h: 2 },
  spec: ([a]) => [a ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [2, 5], y: [18, 10] },
    instances: [
      { name: 'r', def: RELAY, at: [6, 4] }, { name: 'g', def: GND, at: [6, 9] },
      { name: 'vdd', def: VDD, at: [9, 1] }, load('ld', [13, 10]),
    ],
    nets: [
      { name: 'a', ends: ['a', 'r.a'] }, { name: 'gnd', ends: ['r.b', 'g.p'] }, { name: 'vdd', ends: ['vdd.p', 'r.c'] },
      { name: 'y', ends: ['r.nc', 'ld.y', 'y'], trunk: 10 },
    ],
  }),
});

/** NAND: two break contacts in parallel from VDD (the brick: one relay per input). */
export const RELAY_NAND: ComponentDef = define({
  id: 'relay_nand', name: 'Relay NAND', category: 'gate',
  summary: 'Two relays: their break contacts in parallel from VDD. The output is 1 unless both coils pull.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'nand' },
  spec: ([a, b]) => [a & b ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [2, 5], b: [2, 14], y: [26, 11] },
    instances: [
      { name: 'ra', def: RELAY, at: [6, 4] }, { name: 'ga', def: GND, at: [6, 9] }, { name: 'va', def: VDD, at: [9, 1] },
      { name: 'rb', def: RELAY, at: [15, 4] }, { name: 'gb', def: GND, at: [15, 9] }, { name: 'vb', def: VDD, at: [18, 1] },
      load('ld', [22, 11]),
    ],
    nets: [
      { name: 'a', ends: ['a', 'ra.a'] }, { name: 'b', ends: ['b', 'rb.a'], trunk: 13 },
      { name: 'gnd a', ends: ['ra.b', 'ga.p'] }, { name: 'gnd b', ends: ['rb.b', 'gb.p'] },
      { name: 'vdd a', ends: ['va.p', 'ra.c'] }, { name: 'vdd b', ends: ['vb.p', 'rb.c'] },
      { name: 'y', ends: ['ra.nc', 'rb.nc', 'ld.y', 'y'], trunk: 11 },
    ],
  }),
});

/**
 * XOR from two changeover contacts: relay a sends VDD to one of two lines, relay b picks the other one for the
 * output. What costs 4 NANDs is two relays here, with one relay step of delay.
 */
export const RELAY_XOR: ComponentDef = define({
  id: 'relay_xor', name: 'Relay XOR', category: 'gate',
  summary: 'Two relays, one changeover each: a puts VDD on one of two lines, b connects the output to the other one.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'xor' },
  spec: ([a, b]) => [a ^ b],
  netlist: () => ({
    level: 'switch',
    pins: { a: [2, 5], b: [2, 16], y: [28, 2] },
    instances: [
      { name: 'ra', def: RELAY, at: [6, 4] }, { name: 'ga', def: GND, at: [6, 9] }, { name: 'va', def: VDD, at: [9, 1] },
      { name: 'rb', def: RELAY, at: [16, 4] }, { name: 'gb', def: GND, at: [16, 9] },
      load('ld', [23, 2]),
    ],
    nets: [
      { name: 'a', ends: ['a', 'ra.a'] }, { name: 'b', ends: ['b', 'rb.a'], trunk: 14 },
      { name: 'gnd a', ends: ['ra.b', 'ga.p'] }, { name: 'gnd b', ends: ['rb.b', 'gb.p'] },
      { name: 'vdd', ends: ['va.p', 'ra.c'] },
      { name: 'L1', ends: ['ra.no', 'rb.nc'], trunk: 11 },
      { name: 'L0', ends: ['ra.nc', 'rb.no'], trunk: 13 },
      { name: 'y', ends: ['rb.c', 'ld.y', 'y'], trunk: 2 },
    ],
  }),
});

/**
 * Full adder with the carry through contacts. The carry travels on two lines, c and its complement nc (exactly one
 * carries VDD), because a contact can pass a line but never invert it. a and b operate the relays; ci / nci pass
 * through their contacts to co / nco and s with no relay waiting on them, so n of these add in one relay step:
 *   co  = b ? (a ? VDD : ci)  : (a ? ci : open)      nco = b ? (a ? open : nci) : (a ? nci : VDD)
 *   s   = a ? (b ? ci : nci)  : (b ? nci : ci)
 * Relay A has 5 poles (four for the carries, one choosing the sum's pair), B has 4.
 */
export const RELAY_FA: ComponentDef = define({
  id: 'relay_fa', name: 'Relay full adder', category: 'arithmetic',
  summary: 'Two relays (5 and 4 poles). The carry passes through their contacts on two lines (c and not c), so a chain of these adds in one relay step.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('ci', 'inout', 'top'), bit('nci', 'inout', 'top'),
    bit('s', 'inout', 'right'), bit('co', 'inout', 'bottom'), bit('nco', 'inout', 'bottom')],
  symbol: { kind: 'box', label: 'RFA', w: 6, h: 6 },
  netlist: () => ({
    level: 'switch',
    pins: { a: [2, 23], b: [2, 5], ci: [40, 31], nci: [40, 33], s: [40, 12], co: [40, 2], nco: [40, 0] },
    instances: [
      // B on top: its first two poles choose the carry pair, the other two the sum's lines
      { name: 'rb', def: relay(4), at: [6, 4] }, { name: 'gb', def: GND, at: [2, 9] },
      // A below: four poles for the carries, the fifth picks the sum
      { name: 'ra', def: relay(5), at: [6, 22] }, { name: 'ga', def: GND, at: [2, 27] },
      { name: 'v1', def: VDD, at: [28, 22] }, { name: 'v2', def: VDD, at: [33, 22] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'ra.a'] }, { name: 'b', ends: ['b', 'rb.a'] },
      { name: 'gnd a', ends: ['ra.b', 'ga.p'] }, { name: 'gnd b', ends: ['rb.b', 'gb.p'] },
      { name: 'co', ends: ['rb.c1', 'co'], trunk: 2 },
      { name: 'nco', ends: ['rb.c2', 'nco'], trunk: 0 },
      { name: 'u1', ends: ['rb.no1', 'ra.c1'], tags: ['rb.no1', 'ra.c1'] },
      { name: 'u0', ends: ['rb.nc1', 'ra.c2'], tags: ['rb.nc1', 'ra.c2'] },
      { name: 'w1', ends: ['rb.no2', 'ra.c3'], tags: ['rb.no2', 'ra.c3'] },
      { name: 'w0', ends: ['rb.nc2', 'ra.c4'], tags: ['rb.nc2', 'ra.c4'] },
      { name: 'vdd 1', ends: ['v1.p', 'ra.no1'], tags: ['ra.no1'] },
      { name: 'vdd 2', ends: ['v2.p', 'ra.nc4'], tags: ['ra.nc4'] },
      { name: 'ci', ends: ['ci', 'ra.nc1', 'ra.no2', 'rb.no3', 'rb.nc4'], tags: ['ra.nc1', 'ra.no2', 'rb.no3', 'rb.nc4'] },
      { name: 'nci', ends: ['nci', 'ra.nc3', 'ra.no4', 'rb.nc3', 'rb.no4'], tags: ['ra.nc3', 'ra.no4', 'rb.nc3', 'rb.no4'] },
      { name: 's', ends: ['ra.c5', 's'], tags: ['ra.c5'] },
      { name: 'z1', ends: ['ra.no5', 'rb.c3'], tags: ['ra.no5', 'rb.c3'] },
      { name: 'z0', ends: ['ra.nc5', 'rb.c4'], tags: ['ra.nc5', 'rb.c4'] },
    ],
  }),
});

/**
 * n-bit relay adder: full adders whose carries pass through contacts, so the sum is ready one relay step after a and
 * b, whatever n is. Carry in is 0: its line open, its complement on VDD. Sum and carry lines end on loads.
 */
export const relayAdder = memo((n: number): ComponentDef => {
  const P = 10, X = 12, Y0 = 3;
  const ones = Array.from({ length: n }, () => 1);
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones, P), at: [4, Y0 - 3] },
    { name: 'sb', def: splitter(ones, P), at: [7, Y0 - 1] },
    { name: 'ms', def: merger(ones, P), at: [27, Y0 - 2] },
    { name: 'vin', def: VDD, at: [X + 3, Y0 - 3] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] }, { name: 's', ends: ['ms.out', 's'] },
    { name: 'nc0', ends: ['vin.p', 'fa0.nci'] },
  ];
  for (let i = 0; i < n; i++) {
    const y = Y0 + P * i;
    instances.push({ name: `fa${i}`, def: RELAY_FA, at: [X, y] }, load(`ls${i}`, [22, y + 4]));
    nets.push(
      { name: `a${i}`, ends: [`sa.o${i}`, `fa${i}.a`] }, { name: `b${i}`, ends: [`sb.o${i}`, `fa${i}.b`] },
      { name: `s${i}`, ends: [`fa${i}.s`, `ls${i}.y`, `ms.i${i}`] },
    );
    if (i < n - 1) nets.push({ name: `c${i + 1}`, ends: [`fa${i}.co`, `fa${i + 1}.ci`] }, { name: `nc${i + 1}`, ends: [`fa${i}.nco`, `fa${i + 1}.nci`] });
  }
  instances.push(load('lc', [X + 1, Y0 + P * n + 1]));
  nets.push({ name: 'co', ends: [`fa${n - 1}.co`, 'lc.y', 'co'] });
  const M = 2 ** n - 1;
  return define({
    id: `radd${n}`, name: `${n}-bit relay adder`, category: 'arithmetic',
    summary: `${n} relay full adders, ${2 * n} relays. The carry runs through contacts, so the sum is ready one relay step after the operands, for any width.`,
    ports: [{ name: 'a', width: n, dir: 'in' }, { name: 'b', width: n, dir: 'in' }, { name: 's', width: n, dir: 'out' }, bit('co', 'out', 'bottom')],
    symbol: { kind: 'box', label: `RADD${n}` },
    spec: ([a, b]) => [(a + b) & M, a + b > M ? 1 : 0],
    netlist: () => ({
      level: 'switch',
      pins: { a: [1, Y0 - 3 + 5 * n], b: [1, Y0 - 1 + 5 * n], s: [32, Y0 - 2 + 5 * n], co: [X + 10, Y0 + P * n + 1] },
      instances, nets,
    }),
  });
});

/**
 * A relay that holds itself: set closes a path to its coil, and its own make contact keeps the coil fed (through
 * reset's break contact) after set lets go. Reset opens that path. Set and reset are relays too: a push button
 * would be a contact, and so is everything here.
 */
export const RELAY_LATCH: ComponentDef = define({
  id: 'relay_latch', name: 'Self-holding relay', category: 'sequential',
  summary: 'Three relays: set feeds the coil of k, k keeps feeding itself through its own contact, reset breaks that path.',
  ports: [bit('set', 'in'), bit('reset', 'in'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'RLATCH', w: 7, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { set: [2, 5], reset: [2, 15], q: [32, 11] },
    instances: [
      { name: 'rs', def: RELAY, at: [6, 4] }, { name: 'gs', def: GND, at: [6, 9] }, { name: 'vs', def: VDD, at: [9, 1] },
      { name: 'rr', def: RELAY, at: [6, 14] }, { name: 'gr', def: GND, at: [6, 19] }, { name: 'vr', def: VDD, at: [9, 11] },
      { name: 'k', def: RELAY, at: [20, 14] }, { name: 'gk', def: GND, at: [20, 19] },
    ],
    nets: [
      { name: 'set', ends: ['set', 'rs.a'] }, { name: 'reset', ends: ['reset', 'rr.a'] },
      { name: 'gnd s', ends: ['rs.b', 'gs.p'] }, { name: 'gnd r', ends: ['rr.b', 'gr.p'] }, { name: 'gnd k', ends: ['k.b', 'gk.p'] },
      { name: 'vdd s', ends: ['vs.p', 'rs.c'] }, { name: 'vdd r', ends: ['vr.p', 'rr.c'] },
      { name: 'hold', ends: ['rr.nc', 'k.c'], trunk: 22 },
      { name: 'q', ends: ['rs.no', 'k.no', 'k.a', 'q'], trunk: 11 },
    ],
  }),
  notes: `Zuse's Z3 kept its 64 words of 22 bits this way, one relay per bit: 1 408 of its 2 600 relays were memory.`,
});

/**
 * The buzzer: a coil fed through its own break contact. Pulled in, it cuts its own current; released, it closes it
 * again: a square wave of two relay steps, the first clock. en (a relay) switches it on.
 */
export const RELAY_BUZZER: ComponentDef = define({
  id: 'relay_buzzer', name: 'Relay buzzer', category: 'sequential',
  summary: 'A relay whose coil is fed through its own break contact: it oscillates with a period of two relay steps.',
  ports: [bit('en', 'in'), bit('y', 'out')],
  symbol: { kind: 'box', label: 'BUZZ', w: 6, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { en: [2, 5], y: [28, 11] },
    instances: [
      { name: 're', def: RELAY, at: [6, 4] }, { name: 'ge', def: GND, at: [6, 9] }, { name: 've', def: VDD, at: [9, 1] },
      { name: 'k', def: RELAY, at: [18, 4] }, { name: 'gk', def: GND, at: [18, 9] },
    ],
    nets: [
      { name: 'en', ends: ['en', 're.a'] }, { name: 'gnd e', ends: ['re.b', 'ge.p'] }, { name: 'gnd k', ends: ['k.b', 'gk.p'] },
      { name: 'vdd', ends: ['ve.p', 're.c'] },
      { name: 'feed', ends: ['re.no', 'k.c'], trunk: 2 },
      { name: 'y', ends: ['k.nc', 'k.a', 'y'], trunk: 11 },
    ],
  }),
});

/**
 * The buzzer and a divide-by-two from two relays (the campaign's buzzer clock). k is the buzzer, fed by en through
 * its own break contact. t toggles at every step k is operated: k's second pole connects t's coil to N (VDD through
 * t's break contact: on while t is released) while k is operated and to P (VDD through t's make contact: on while t
 * is operated) while k is released, so t' = k ? ¬t : t. Every armature moves at once at a relay step, so the
 * toggle reads the old t: q has twice y's period. With en = 0, k rests released and t holds.
 */
export const RELAY_CLOCK: ComponentDef = define({
  id: 'relay_clock', name: 'Relay clock and ÷2', category: 'sequential',
  summary: 'Two relays: a buzzer (y changes every relay step) and a relay that toggles while the buzzer is operated (q, half the rate).',
  ports: [bit('en', 'in'), bit('y', 'out'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'CLK ÷2', w: 6, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { en: [2, 3], y: [40, 3], q: [40, 16] },
    instances: [
      { name: 'k', def: relay(2), at: [8, 6] }, { name: 'gk', def: GND, at: [8, 11] },
      { name: 't', def: relay(2), at: [24, 6] }, { name: 'gt', def: GND, at: [24, 11] },
      { name: 'vt', def: VDD, at: [27, 3] }, { name: 'vq', def: VDD, at: [30, 3] },
      load('lq', [35, 13]),
    ],
    nets: [
      { name: 'en', ends: ['en', 'k.c1'] }, { name: 'gnd k', ends: ['k.b', 'gk.p'] }, { name: 'gnd t', ends: ['t.b', 'gt.p'] },
      { name: 'y', ends: ['k.nc1', 'k.a', 'y'], trunk: 3 },
      { name: 'vdd t', ends: ['vt.p', 't.c1'] }, { name: 'vdd q', ends: ['vq.p', 't.c2'] },
      { name: 'coil t', ends: ['k.c2', 't.a'], trunk: 4 },
      { name: 'P', ends: ['t.no1', 'k.nc2'], tags: ['t.no1', 'k.nc2'] },
      { name: 'N', ends: ['t.nc1', 'k.no2'], tags: ['t.nc1', 'k.no2'] },
      { name: 'q', ends: ['t.no2', 'lq.y', 'q'], trunk: 16 },
    ],
  }),
});
