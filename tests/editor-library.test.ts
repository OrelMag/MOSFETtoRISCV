// UserLibrary: chips placing chips, Merkle-cached so untouched chips keep their def objects;
// cycles, renames and deletions; a transistor-level chip reused as a gate-level brick.

import { describe, expect, it } from 'vitest';
import { checkSimulatable } from '../src/editor/compile';
import { removeChip, renamePort, UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { NAND } from '../src/lib/transistors';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { chip, halfAdder, part, pin, wire } from './editorkit';

/** Full adder from two user half adders and an OR. Wires without corners: ends follow the pins. */
const fullAdder = (): ChipDoc => chip('u_fa', 'FA', {
  pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('cin', 'in', [0, 10]), pin('s', 'out', [40, 2]), pin('cout', 'out', [40, 10])],
  parts: [part('h1', { chip: 'u_ha' }, [6, 0]), part('h2', { chip: 'u_ha' }, [18, 0]), part('o', { lib: 'or' }, [30, 8])],
  wires: [
    wire('w1', 'pin:a', 'h1.a'), wire('w2', 'pin:b', 'h1.b'), wire('w3', 'h1.s', 'h2.a'), wire('w4', 'pin:cin', 'h2.b'),
    wire('w5', 'h2.s', 'pin:s'), wire('w6', 'h1.c', 'o.a'), wire('w7', 'h2.c', 'o.b'), wire('w8', 'o.y', 'pin:cout'),
  ],
});

/** 4-bit ripple-carry adder from four user full adders, with splitters and a merger. */
const rca4 = (): ChipDoc => chip('u_rca4', 'RCA4', {
  pins: [pin('a', 'in', [0, 0], 4), pin('b', 'in', [0, 2], 4), pin('cin', 'in', [0, 4]), pin('s', 'out', [90, 0], 4), pin('cout', 'out', [90, 2])],
  parts: [
    part('sa', { split: [1, 1, 1, 1] }, [4, 10]), part('sb', { split: [1, 1, 1, 1] }, [4, 30]), part('ms', { merge: [1, 1, 1, 1] }, [80, 10]),
    ...[0, 1, 2, 3].map((i) => part(`fa${i}`, { chip: 'u_fa' }, [20 + 14 * i, 10 + 6 * i])),
  ],
  wires: [
    wire('wa', 'pin:a', 'sa.in'), wire('wb', 'pin:b', 'sb.in'), wire('wc', 'pin:cin', 'fa0.cin'),
    wire('wm', 'ms.out', 'pin:s'), wire('wo', 'fa3.cout', 'pin:cout'),
    ...[0, 1, 2, 3].flatMap((i) => [
      wire(`a${i}`, `sa.o${i}`, `fa${i}.a`), wire(`b${i}`, `sb.o${i}`, `fa${i}.b`), wire(`s${i}`, `fa${i}.s`, `ms.i${i}`),
      ...(i < 3 ? [wire(`c${i}`, `fa${i}.cout`, `fa${i + 1}.cin`)] : []),
    ]),
  ],
});

/** An unrelated chip: a NOT. */
const inverter = (): ChipDoc => chip('u_not', 'NOT', {
  pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [10, 2])],
  parts: [part('g', { lib: 'not' }, [4, 1])],
  wires: [wire('w1', 'pin:a', 'g.a'), wire('w2', 'g.y', 'pin:y')],
});

const workspace = (...chips: ChipDoc[]): Workspace => ({ ...emptyWorkspace(), chips: Object.fromEntries(chips.map((c) => [c.id, c])), open: [chips[0].id] });

describe('UserLibrary: adders from adders', () => {
  const ws = workspace(halfAdder(), fullAdder(), rca4(), inverter());
  const lib = new UserLibrary(ws);

  it('compiles every chip cleanly', () => {
    for (const id of ['u_ha', 'u_fa', 'u_rca4', 'u_not']) {
      expect(lib.compiled(id)!.diags, id).toEqual([]);
      expect(checkSimulatable(lib.compiled(id)!), id).toEqual([]);
    }
  });

  it('the 4-bit adder adds: all 512 input combinations', () => {
    const def = lib.defOf('u_rca4')!;
    expect(def.ports.map((p) => p.name)).toEqual(['a', 'b', 'cin', 's', 'cout']);
    const sim = simulate(def);
    forEachInput(def, ([a, b, cin]) => {
      const sum = a + b + cin;
      expect(evalOnce(sim, [a, b, cin]), `${a}+${b}+${cin}`).toEqual([sum & 15, sum >> 4]);
    });
  });

  it('dependencies, dependents, placement rules', () => {
    expect(lib.deps('u_rca4').sort()).toEqual(['u_fa', 'u_ha']);
    expect(lib.usedBy('u_ha').sort()).toEqual(['u_fa', 'u_rca4']);
    expect(lib.usedBy('u_not')).toEqual([]);
    expect(lib.canPlace('u_fa', 'u_ha')).toBe(true);
    expect(lib.canPlace('u_ha', 'u_fa')).toBe(false);
    expect(lib.canPlace('u_ha', 'u_ha')).toBe(false);
    expect(lib.canPlace('u_ha', 'u_rca4')).toBe(false);
    expect(lib.canPlace('u_not', 'u_rca4')).toBe(true);
    expect(lib.canPlace('u_not', 'u_missing')).toBe(false);
    expect(lib.resolver()('u_fa')).toBe(lib.defOf('u_fa'));
  });

  it('editing a chip rebuilds it and its users only', () => {
    const before = Object.fromEntries(['u_ha', 'u_fa', 'u_rca4', 'u_not'].map((id) => [id, lib.defOf(id)]));
    const keyBefore = lib.compiled('u_ha')!.connKey;
    const l2 = new UserLibrary(ws);
    // Same snapshot again: nothing recompiled.
    l2.update(ws);
    const same = l2.defOf('u_fa');
    l2.update({ ...ws });
    expect(l2.defOf('u_fa')).toBe(same);
    // Move a part of the half adder.
    const ha = ws.chips.u_ha;
    const moved = { ...ha, parts: ha.parts.map((p) => (p.id === 'x' ? { ...p, at: [8, 0] as [number, number] } : p)) };
    lib.update({ ...ws, chips: { ...ws.chips, u_ha: moved } });
    expect(lib.compiled('u_ha')!.connKey).toBe(keyBefore);
    for (const id of ['u_ha', 'u_fa', 'u_rca4']) expect(lib.defOf(id), id).not.toBe(before[id]);
    expect(lib.defOf('u_not')).toBe(before.u_not);
    // The new FA really contains the new HA.
    expect(lib.defOf('u_fa')!.netlist!().instances[0].def).toBe(lib.defOf('u_ha'));
    lib.update(ws);
  });

  it('a cycle is an error on each chip of it, not a hang', () => {
    const ha = ws.chips.u_ha;
    const loop = { ...ha, parts: [...ha.parts, part('f', { chip: 'u_fa' }, [30, 30])] };
    const l = new UserLibrary({ ...ws, chips: { ...ws.chips, u_ha: loop } });
    expect(l.compiled('u_ha')!.diags.map((d) => d.msg)).toEqual(["f: cycle: 'u_fa' contains this chip"]);
    expect(l.compiled('u_fa')!.diags.map((d) => d.msg)).toEqual(["h1: cycle: 'u_ha' contains this chip", "h2: cycle: 'u_ha' contains this chip"]);
    const self = { ...ha, parts: [...ha.parts, part('me', { chip: 'u_ha' }, [30, 30])] };
    const l3 = new UserLibrary(workspace(self));
    expect(l3.compiled('u_ha')!.diags.map((d) => d.msg)).toEqual(['me: a chip cannot contain itself']);
    expect(l3.canPlace('u_ha', 'u_ha')).toBe(false);
  });

  it('renamePort rewrites the pin and every wire on it', () => {
    const ws2 = renamePort(ws, 'u_ha', 's', 'sum');
    expect(ws2.chips.u_ha.pins.map((p) => p.name)).toEqual(['a', 'b', 'sum', 'c']);
    expect(ws2.chips.u_fa.wires.find((w) => w.id === 'w3')!.a).toEqual({ part: 'h1', port: 'sum' });
    expect(ws2.chips.u_rca4).toBe(ws.chips.u_rca4);
    expect(ws2.chips.u_not).toBe(ws.chips.u_not);
    const l = new UserLibrary(ws2);
    expect(l.compiled('u_fa')!.diags).toEqual([]);
    const sim = simulate(l.defOf('u_fa')!);
    forEachInput(l.defOf('u_fa')!, ([a, b, c]) => expect(evalOnce(sim, [a, b, c])).toEqual([(a + b + c) & 1, (a + b + c) >> 1]));
  });

  it('removeChip refuses while the chip is used', () => {
    const r = removeChip(ws, 'u_ha');
    expect('error' in r && r.usedBy.sort()).toEqual(['u_fa', 'u_rca4']);
    const ok = removeChip(ws, 'u_not');
    expect('ws' in ok && Object.keys(ok.ws.chips).sort()).toEqual(['u_fa', 'u_ha', 'u_rca4']);
  });
});

describe('UserLibrary: a transistor-level NAND as a brick', () => {
  // CMOS NAND: two PMOS in parallel from VDD to y, two NMOS in series from y to GND.
  const cmos = chip('u_cnand', 'CNAND', {
    pins: [pin('a', 'in', [0, 6]), pin('b', 'in', [0, 12]), pin('y', 'out', [30, 8])],
    parts: [
      part('vdd', { lib: 'vdd' }, [12, 0]), part('p1', { lib: 'pmos' }, [8, 2]), part('p2', { lib: 'pmos' }, [16, 2]),
      part('n1', { lib: 'nmos' }, [12, 10]), part('n2', { lib: 'nmos' }, [12, 16]), part('gnd', { lib: 'gnd' }, [14, 22]),
    ],
    wires: [
      wire('v1', 'vdd.p', 'p1.s'), wire('v2', 'vdd.p', 'p2.s'),
      wire('y1', 'p1.d', 'pin:y'), wire('y2', 'p2.d', 'pin:y'), wire('y3', 'n1.d', 'pin:y'),
      wire('m', 'n1.s', 'n2.d'), wire('g', 'n2.s', 'gnd.p'),
      wire('a1', 'pin:a', 'p1.g'), wire('a2', 'pin:a', 'n1.g'), wire('b1', 'pin:b', 'p2.g'), wire('b2', 'pin:b', 'n2.g'),
    ],
  });
  // OR from three of them: y = NAND(NAND(a, a), NAND(b, b)).
  const or3 = chip('u_or3', 'OR3', {
    pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 10]), pin('y', 'out', [40, 6])],
    parts: [part('na', { chip: 'u_cnand' }, [6, 0]), part('nb', { chip: 'u_cnand' }, [6, 10]), part('no', { chip: 'u_cnand' }, [24, 4])],
    wires: [
      wire('w1', 'pin:a', 'na.a'), wire('w2', 'pin:a', 'na.b'), wire('w3', 'pin:b', 'nb.a'), wire('w4', 'pin:b', 'nb.b'),
      wire('w5', 'na.y', 'no.a'), wire('w6', 'nb.y', 'no.b'), wire('w7', 'no.y', 'pin:y'),
    ],
  });
  const lib = new UserLibrary(workspace(cmos, or3));

  it('compiles at switch level and derives a gate-level model', () => {
    const c = lib.compiled('u_cnand')!;
    expect(c.diags).toEqual([]);
    expect(c.mode).toBe('switch');
    expect(c.derived?.ok).toBe(true);
    expect(c.def.netlist!().level).toBe('switch');
    forEachInput(c.def, (ins) => expect(c.def.spec!(ins)).toEqual(NAND.spec!(ins)));
    // Its own inside is still solved transistor by transistor.
    const sim = simulate(c.def);
    forEachInput(c.def, (ins) => expect(evalOnce(sim, ins)).toEqual(NAND.spec!(ins)));
    expect(checkSimulatable(c)).toEqual([]);
  });

  it('three of them make a gate-level OR', () => {
    const c = lib.compiled('u_or3')!;
    expect(c.diags).toEqual([]);
    expect(c.mode).toBe('gate');
    const sim = new GateSim(flatten(c.def));
    expect(sim.design.leaves.map((l) => l.kind)).toEqual(['behavior', 'behavior', 'behavior']);
    forEachInput(c.def, ([a, b]) => expect(evalOnce(sim, [a, b])).toEqual([a | b]));
  });

  it('a shorted switch-level node is legal (the solver resolves it)', () => {
    const shorted = { ...cmos, id: 'u_short', wires: [...cmos.wires, wire('s', 'vdd.p', 'pin:y')] };
    const c = new UserLibrary(workspace(shorted)).compiled('u_short')!;
    expect(c.diags).toEqual([]);
    expect(c.mode).toBe('switch');
  });
});
