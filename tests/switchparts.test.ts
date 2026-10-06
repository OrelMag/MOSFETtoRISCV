// Switch-level parts beyond the transistor: resistors (weaker than any transistor), capacitors
// (charge-keeping nodes), the transmission gate, tri-state drivers, shared buses and wired logic.

import { describe, expect, it } from 'vitest';
import { deriveBehavior, circuitMode } from '../src/editor/derive';
import {
  CAP, GND, INV_CMOS, NMOS, PMOS, PULLDOWN, PULLUP, RES, TGATE, TRIBUF, TRIINV, VDD,
} from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { forEachInput, needsSwitchLevel, reachesTransistors } from '../src/sim/harness';
import { hasFeedback, stats } from '../src/sim/stats';
import { exportHdl } from '../src/sim/svexport';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BX, BZ, type Bit, type ComponentDef, type InstanceDef, type NetDef } from '../src/sim/types';
import { structuralVerilog } from '../src/sim/verilog';

const sw = (def: ComponentDef) => new SwitchSim(flatten(def, { mode: 'switch' }));
const bit = (s: SwitchSim, p: string): Bit => s.get(s.design.root.ports[p][0]);
const set = (s: SwitchSim, v: Record<string, number>) => {
  for (const [k, x] of Object.entries(v)) s.setInput(k, x);
  s.settle();
};
const NAME = ['0', '1', 'X', 'Z'];
const show = (b: Bit) => NAME[b];

/** A test circuit: 1-bit ports (`>name` an output, `~name` an inout, else an input). */
function circuit(id: string, ports: string[], instances: InstanceDef[], nets: NetDef[]): ComponentDef {
  return {
    id, name: id, category: 'cell', symbol: { kind: 'box' },
    ports: ports.map((p) => ({ name: p.replace(/^[>~]/, ''), width: 1, dir: p[0] === '>' ? 'out' : p[0] === '~' ? 'inout' : 'in' })),
    netlist: () => ({ level: 'switch', instances, nets }),
  };
}

describe('resistors: weaker than any transistor', () => {
  // pseudo-NMOS inverter: a pull-up resistor and one NMOS to GND
  const PSEUDO = circuit('t_pseudo', ['a', '>y'],
    [{ name: 'pu', def: PULLUP }, { name: 'n', def: NMOS }, { name: 'gnd', def: GND }],
    [{ ends: ['pu.y', 'n.d', 'y'] }, { ends: ['a', 'n.g'] }, { ends: ['gnd.p', 'n.s'] }]);

  it('a node reached only through a pull-up is 1; a conducting NMOS overrides it (no short flagged)', () => {
    const s = sw(PSEUDO);
    set(s, { a: 0 }); expect(show(bit(s, 'y'))).toBe('1');
    set(s, { a: 1 }); expect(show(bit(s, 'y'))).toBe('0');
    expect(s.shorted.some((x) => x)).toBe(false); // the resistor's static current is by design
    s.setInputBit('a', BX); s.settle();
    expect(show(bit(s, 'y'))).toBe('X'); // the NMOS might conduct
  });

  it('a pull-down alone gives 0, a PMOS to VDD overrides it', () => {
    const c = circuit('t_pd', ['a', '>y'],
      [{ name: 'pd', def: PULLDOWN }, { name: 'p', def: PMOS }, { name: 'vdd', def: VDD }],
      [{ ends: ['pd.y', 'p.d', 'y'] }, { ends: ['a', 'p.g'] }, { ends: ['vdd.p', 'p.s'] }]);
    const s = sw(c);
    set(s, { a: 1 }); expect(show(bit(s, 'y'))).toBe('0');
    set(s, { a: 0 }); expect(show(bit(s, 'y'))).toBe('1');
  });

  it('two resistors pulling opposite ways give X (a divider); a resistor to a floating node gives Z', () => {
    const div = circuit('t_div', ['>y'],
      [{ name: 'pu', def: PULLUP }, { name: 'pd', def: PULLDOWN }], [{ ends: ['pu.y', 'pd.y', 'y'] }]);
    expect(show(bit(sw(div), 'y'))).toBe('X');
    const open = circuit('t_open', ['>y'], [{ name: 'r', def: RES }], [{ ends: ['r.a', 'y'] }]);
    expect(show(bit(sw(open), 'y'))).toBe('Z');
  });

  it('a path is as strong as its weakest element: pull-up then NMOS still loses to a direct NMOS', () => {
    // y ← R ← VDD and y ← NMOS(a) ← GND, plus y ← NMOS(b) ← R ← VDD: the second path is resistive
    const c = circuit('t_weakpath', ['a', 'b', '>y'],
      [{ name: 'pu', def: PULLUP }, { name: 'nb', def: NMOS }, { name: 'na', def: NMOS }, { name: 'gnd', def: GND }],
      [{ ends: ['pu.y', 'nb.s'] }, { ends: ['nb.d', 'na.d', 'y'] }, { ends: ['a', 'na.g'] }, { ends: ['b', 'nb.g'] }, { ends: ['gnd.p', 'na.s'] }]);
    const s = sw(c);
    set(s, { a: 0, b: 1 }); expect(show(bit(s, 'y'))).toBe('1');
    set(s, { a: 1, b: 1 }); expect(show(bit(s, 'y'))).toBe('0');
    set(s, { a: 0, b: 0 }); expect(show(bit(s, 'y'))).toBe('Z');
  });

  it('only at switch level; counted as resistors, not transistors', () => {
    expect(() => flatten(PSEUDO)).toThrow(); // a switch-level netlist has no gate-level reading
    expect(() => flatten(RES)).toThrow(/resistors and capacitors/);
    expect(reachesTransistors(PULLUP)).toBe(true);
    expect(needsSwitchLevel(RES)).toBe(true);
    expect(stats(PULLUP)).toMatchObject({ transistors: 0, resistors: 1, capacitors: 0 });
    expect(stats(PSEUDO)).toMatchObject({ transistors: 1, resistors: 1 });
    expect(hasFeedback(PSEUDO)).toBe(false);
  });
});

describe('capacitors keep their charge', () => {
  // a DRAM-like node: an NMOS pass transistor from d onto a capacitor
  const CELL = circuit('t_dram', ['g', 'd', '>q'],
    [{ name: 'a', def: NMOS }, { name: 'c', def: CAP }], [{ ends: ['g', 'a.g'] }, { ends: ['d', 'a.d'] }, { ends: ['a.s', 'c.a', 'q'] }]);
  const BARE = circuit('t_bare', ['g', 'd', '>q'], [{ name: 'a', def: NMOS }], [{ ends: ['g', 'a.g'] }, { ends: ['d', 'a.d'] }, { ends: ['a.s', 'q'] }]);

  it('holds the written value while the access transistor is off (without it: Z)', () => {
    const s = sw(CELL), b = sw(BARE);
    for (const x of [s, b]) set(x, { g: 1, d: 1 });
    expect([bit(s, 'q'), bit(b, 'q')].map(show)).toEqual(['1', '1']);
    for (const x of [s, b]) set(x, { g: 0, d: 0 });
    expect([bit(s, 'q'), bit(b, 'q')].map(show)).toEqual(['1', 'Z']);
    set(s, { g: 1 }); expect(show(bit(s, 'q'))).toBe('0');
    set(s, { g: 0, d: 1 }); expect(show(bit(s, 'q'))).toBe('0');
  });

  it('is the same as a `cap` net, and a resistor overrides the charge', () => {
    expect(flatten(CELL, { mode: 'switch' }).caps.size).toBe(1);
    expect(hasFeedback(CELL)).toBe(true);
    expect(stats(CELL)).toMatchObject({ transistors: 1, capacitors: 1 });
    const leaky = circuit('t_leaky', ['g', 'd', '>q'],
      [{ name: 'a', def: NMOS }, { name: 'c', def: CAP }, { name: 'pd', def: PULLDOWN }],
      [{ ends: ['g', 'a.g'] }, { ends: ['d', 'a.d'] }, { ends: ['a.s', 'c.a', 'pd.y', 'q'] }]);
    const s = sw(leaky);
    set(s, { g: 1, d: 1 }); expect(show(bit(s, 'q'))).toBe('1'); // the transistor beats the pull-down
    set(s, { g: 0 }); expect(show(bit(s, 'q'))).toBe('0'); // charge (weakest) loses to the resistor
  });
});

describe('transmission gate', () => {
  it('passes 0 and 1 both ways while enabled, and isolates while not', () => {
    const s = sw(TGATE);
    set(s, { en: 1, en_n: 0 });
    for (const v of [B0, B1] as Bit[]) {
      s.setInputBit('a', v); s.setInputBit('b', BZ); s.settle();
      expect(show(bit(s, 'b'))).toBe(show(v));
      s.setInputBit('a', BZ); s.setInputBit('b', v); s.settle();
      expect(show(bit(s, 'a'))).toBe(show(v));
    }
    set(s, { en: 0, en_n: 1 });
    s.setInputBit('a', B1); s.setInputBit('b', BZ); s.settle();
    expect(show(bit(s, 'b'))).toBe('Z');
    // only one half on: still passes (this model has no threshold loss)
    set(s, { en: 1, en_n: 1 });
    expect(show(bit(s, 'b'))).toBe('1');
  });
  it('costs two transistors', () => expect(stats(TGATE).transistors).toBe(2));
});

describe('tri-state drivers', () => {
  it.each([['tribuf', TRIBUF, (a: number) => a], ['triinv', TRIINV, (a: number) => 1 - a]] as const)('%s: drives while en = 1, floats (Z) while en = 0', (_, def, f) => {
    const s = sw(def);
    forEachInput(def, ([a, en]) => {
      set(s, { a, en });
      expect(show(bit(s, 'y')), `${def.id}(a=${a}, en=${en})`).toBe(en ? String(f(a)) : 'Z');
    });
  });

  it('cost, switch level only, and no gate-level model (a Z would become X)', () => {
    expect(stats(TRIINV).transistors).toBe(6);
    expect(stats(TRIBUF).transistors).toBe(8);
    expect(circuitMode(TRIBUF)).toBe('switch');
    for (const d of [TRIBUF, TRIINV]) {
      const r = deriveBehavior(d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/output 'y' floats \(Z\).*en = 0/);
    }
  });
});

/** Two tri-state buffers on one bus, optionally held by a pull-down. */
const bus = (pull: boolean) => circuit(pull ? 't_bus_pd' : 't_bus', ['a', 'ea', 'b', 'eb', '>y'],
  [{ name: 'ta', def: TRIBUF }, { name: 'tb', def: TRIBUF }, ...(pull ? [{ name: 'pd', def: PULLDOWN }] : [])],
  [{ ends: ['a', 'ta.a'] }, { ends: ['ea', 'ta.en'] }, { ends: ['b', 'tb.a'] }, { ends: ['eb', 'tb.en'] },
    { name: 'bus', ends: ['ta.y', 'tb.y', ...(pull ? ['pd.y'] : []), 'y'] }]);

describe('a shared bus', () => {
  it('one enabled driver: its value; none: Z (or the pull-down); two that disagree: X; two that agree: their value', () => {
    for (const pull of [false, true]) {
      const s = sw(bus(pull));
      const y = (v: Record<string, number>) => { set(s, v); return show(bit(s, 'y')); };
      expect(y({ a: 1, ea: 1, b: 0, eb: 0 })).toBe('1');
      expect(y({ a: 0, ea: 1, b: 1, eb: 0 })).toBe('0');
      expect(y({ a: 0, ea: 0, b: 1, eb: 1 })).toBe('1');
      expect(y({ a: 1, ea: 0, b: 1, eb: 0 })).toBe(pull ? '0' : 'Z');
      expect(y({ a: 1, ea: 1, b: 0, eb: 1 })).toBe('X');
      expect(s.shorted.some((x) => x)).toBe(true); // contention: VDD to GND through both drivers
      expect(y({ a: 1, ea: 1, b: 1, eb: 1 })).toBe('1');
    }
  });
});

describe('wired logic', () => {
  // open-drain stage: an inverter, then an NMOS that pulls the bus low when the input is 0
  const wiredAnd = circuit('t_wand', ['a', 'b', '>y'], [
    { name: 'pu', def: PULLUP }, { name: 'ia', def: INV_CMOS }, { name: 'ib', def: INV_CMOS },
    { name: 'na', def: NMOS }, { name: 'nb', def: NMOS }, { name: 'gnd', def: GND },
  ], [
    { ends: ['a', 'ia.a'] }, { ends: ['b', 'ib.a'] }, { ends: ['ia.y', 'na.g'] }, { ends: ['ib.y', 'nb.g'] },
    { name: 'bus', ends: ['pu.y', 'na.d', 'nb.d', 'y'] }, { ends: ['gnd.p', 'na.s', 'nb.s'] },
  ]);
  // open-source stage: an inverter, then a PMOS that pulls the bus high when the input is 1
  const wiredOr = circuit('t_wor', ['a', 'b', '>y'], [
    { name: 'pd', def: PULLDOWN }, { name: 'ia', def: INV_CMOS }, { name: 'ib', def: INV_CMOS },
    { name: 'pa', def: PMOS }, { name: 'pb', def: PMOS }, { name: 'vdd', def: VDD },
  ], [
    { ends: ['a', 'ia.a'] }, { ends: ['b', 'ib.a'] }, { ends: ['ia.y', 'pa.g'] }, { ends: ['ib.y', 'pb.g'] },
    { name: 'bus', ends: ['pd.y', 'pa.d', 'pb.d', 'y'] }, { ends: ['vdd.p', 'pa.s', 'pb.s'] },
  ]);
  it.each([['wired-AND (open drain + pull-up)', wiredAnd, (a: number, b: number) => a & b], ['wired-OR (open source + pull-down)', wiredOr, (a: number, b: number) => a | b]] as const)('%s', (_, def, f) => {
    const s = sw(def);
    forEachInput(def, ([a, b]) => {
      set(s, { a, b });
      expect(show(bit(s, 'y')), `(${a}, ${b})`).toBe(String(f(a, b)));
    });
    // and the gate-level model the sandbox derives agrees (no Z anywhere)
    const d = deriveBehavior(def);
    expect(d.ok).toBe(true);
  });
});

describe('HDL', () => {
  it('structural Verilog: rtran for a resistor, trireg for a capacitive node, nets not variables', () => {
    expect(structuralVerilog(PULLUP)).toMatch(/rtran r \(vdd, y\);/);
    const v = exportHdl(TRIBUF, 'structure').text;
    expect(v).toMatch(/module triinv/);
    expect(v).toMatch(/output wire y/);
    const cell = circuit('t_cap', ['g', 'd', '>q'], [{ name: 'a', def: NMOS }, { name: 'c', def: CAP }],
      [{ ends: ['g', 'a.g'] }, { ends: ['d', 'a.d'] }, { name: 'store', ends: ['a.s', 'c.a'] }, { ends: ['d', 'q'] }]);
    expect(structuralVerilog(cell)).toMatch(/trireg store;/);
  });
  it('the synthesizable export refuses switch-level parts with a reason', () => {
    expect(() => exportHdl(PULLUP, 'synth')).toThrow(/not synthesizable/);
    expect(() => exportHdl(TRIBUF, 'synth')).toThrow(/not synthesizable/);
  });
});
