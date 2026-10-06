// deriveBehavior(): a transistor-level chip becomes a gate-level brick (like the library NAND),
// provided it is combinational. circuitMode(): which simulator a circuit needs.

import { describe, expect, it } from 'vitest';
import { circuitMode, deriveBehavior } from '../src/editor/derive';
import { DRAM_CELL, SRAM_CELL, SRAM_COLUMN } from '../src/lib/cells';
import { counter, SR_LATCH } from '../src/lib/sequential';
import { INV_CMOS, NAND, NMOS, NMOS_SWITCH, NOR_CMOS, TIE0 } from '../src/lib/transistors';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, forEachInput } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';

/** The library NAND's own four transistors, as a user chip (no primitive, no behaviour). */
const MYNAND: ComponentDef = { id: 'u_mynand', name: 'My NAND', category: 'gate', ports: NAND.ports, symbol: { kind: 'box' }, netlist: NAND.netlist };

function derived(def: ComponentDef): ComponentDef {
  const d = deriveBehavior(def);
  if (!d.ok) throw new Error(d.reason);
  return { ...def, id: `${def.id}_g`, behavior: d.behavior, spec: d.spec };
}

/** XOR from four NANDs of the given kind. */
function xorOf(nand: ComponentDef, id: string): ComponentDef {
  return {
    id, name: id, category: 'gate', symbol: { kind: 'box' },
    ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
    netlist: () => ({
      instances: ['n1', 'n2', 'n3', 'n4'].map((name) => ({ name, def: nand })),
      nets: [
        { ends: ['a', 'n1.a', 'n2.a'] }, { ends: ['b', 'n1.b', 'n3.b'] },
        { ends: ['n1.y', 'n2.b', 'n3.a'] }, { ends: ['n2.y', 'n4.a'] }, { ends: ['n3.y', 'n4.b'] }, { ends: ['n4.y', 'y'] },
      ],
    }),
  };
}

describe('deriveBehavior', () => {
  it.each([
    ['NAND (its transistor netlist)', MYNAND, NAND.spec!],
    ['CMOS inverter', INV_CMOS, INV_CMOS.spec!],
    ['CMOS NOR', NOR_CMOS, NOR_CMOS.spec!],
  ])('%s matches the truth table', (_, def, spec) => {
    const d = deriveBehavior(def);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.behavior.delay).toBe(1);
    forEachInput(def, (ins) => {
      expect(d.spec(ins)).toEqual(spec(ins));
      expect(d.behavior.eval(ins, undefined)).toEqual(spec(ins));
    });
    expect(d.behavior.eval(def.ports.filter((p) => p.dir === 'in').map(() => -1), undefined)).toEqual([-1]);
  });

  it('refuses an output that can float (Z would become X): it stays at switch level', () => {
    expect(deriveBehavior(NMOS_SWITCH)).toMatchObject({ ok: false, reason: expect.stringMatching(/output 'out' floats \(Z\).*g = 0.*would turn into X/) });
  });

  it('the derived NAND is the only brick of a gate-level XOR', () => {
    const G = derived(MYNAND);
    expect(circuitMode(G)).toBe('gate');
    const xor = xorOf(G, 'u_xor');
    expect(circuitMode(xor)).toBe('gate');
    const sim = new GateSim(flatten(xor));
    expect(sim.design.leaves.map((l) => l.kind)).toEqual(['behavior', 'behavior', 'behavior', 'behavior']);
    forEachInput(xor, ([a, b]) => expect(evalOnce(sim, [a, b])).toEqual([a ^ b]));
    // with the raw transistor chip, the XOR can only be simulated at switch level
    const raw = xorOf(MYNAND, 'u_xor_raw');
    expect(circuitMode(raw)).toBe('switch');
    expect(() => flatten(raw)).toThrow();
  });

  it.each([
    ['6T SRAM cell', SRAM_CELL],
    ['DRAM cell', DRAM_CELL],
    ['SRAM column', SRAM_COLUMN],
  ])('refuses a chip with state: %s', (_, def) => {
    const d = deriveBehavior(def);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/state/);
  });

  it('refuses a cross-coupled pair of transistor NANDs (an SR latch at switch level)', () => {
    expect(deriveBehavior(SR_LATCH)).toMatchObject({ ok: false, reason: expect.stringMatching(/state/) });
  });

  it('refuses too many inputs, behavioural parts and chips without transistors', () => {
    const wide: ComponentDef = {
      id: 'u_wide', name: 'wide', category: 'gate', symbol: { kind: 'box' },
      ports: [{ name: 'a', width: 13, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
      netlist: () => ({ level: 'switch', instances: [{ name: 'n', def: NMOS }], nets: [{ ends: ['n.g', 'y'] }] }),
    };
    expect(deriveBehavior(wide)).toMatchObject({ ok: false, reason: expect.stringMatching(/too many inputs/) });
    const beh: ComponentDef = {
      id: 'u_beh', name: 'beh', category: 'gate', symbol: { kind: 'box' },
      ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
      behavior: { eval: ([a]) => [a] },
    };
    expect(deriveBehavior(beh)).toMatchObject({ ok: false, reason: expect.stringMatching(/behavioural/) });
    const wire: ComponentDef = { ...beh, id: 'u_wire', behavior: undefined, netlist: () => ({ instances: [], nets: [{ ends: ['a', 'y'] }] }) };
    expect(deriveBehavior(wire)).toMatchObject({ ok: false, reason: 'no transistors' });
    expect(deriveBehavior(TIE0)).toMatchObject({ ok: false, reason: 'no transistors' });
  });
});

describe('circuitMode', () => {
  it.each([
    ['NAND primitive', NAND, 'gate'],
    ['NAND transistor netlist', MYNAND, 'switch'],
    ['CMOS inverter', INV_CMOS, 'switch'],
    ['CMOS NOR', NOR_CMOS, 'switch'],
    ['NMOS', NMOS, 'switch'],
    ['tie cell (behaviour)', TIE0, 'gate'],
    ['SR latch', SR_LATCH, 'gate'],
    ['4-bit counter', counter(4), 'gate'],
    ['6T SRAM cell', SRAM_CELL, 'switch'],
    ['SRAM column', SRAM_COLUMN, 'switch'],
  ] as const)('%s → %s', (_, def, mode) => expect(circuitMode(def)).toBe(mode));
});
