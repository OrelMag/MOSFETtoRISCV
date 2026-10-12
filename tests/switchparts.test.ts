// Switch-level parts beyond the transistor: resistors (weaker than any transistor), capacitors
// (charge-keeping nodes), the transmission gate, tri-state drivers, shared buses and wired logic.

import { describe, expect, it } from 'vitest';
import { deriveBehavior, circuitMode } from '../src/editor/derive';
import { sharedBusChip, wiredChip } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import type { ChipDoc } from '../src/editor/model';
import {
  CAP, GND, INV_CMOS, INV_PSEUDO, NMOS, PMOS, PULLDOWN, PULLUP, RES, TGATE, TRIBUF, TRIINV, VDD,
} from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { forEachInput, needsSwitchLevel, reachesTransistors } from '../src/sim/harness';
import { hasFeedback, stats } from '../src/sim/stats';
import { exportHdl } from '../src/sim/svexport';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BX, BZ, type Bit, type ComponentDef, type InstanceDef, type NetDef } from '../src/sim/types';
import { structuralVerilog } from '../src/sim/verilog';
import { chip, compileLib, part, pin, wire, workspace } from './editorkit';

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

  it('the library pseudo-NMOS inverter: one transistor and one resistor, a gate-level model like CMOS', () => {
    const s = sw(INV_PSEUDO);
    for (const a of [0, 1]) { set(s, { a }); expect(show(bit(s, 'y'))).toBe(String(1 - a)); }
    expect(stats(INV_PSEUDO)).toMatchObject({ transistors: 1, resistors: 1 });
    expect(deriveBehavior(INV_PSEUDO)).toMatchObject({ ok: true });
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

describe('in the sandbox', () => {
  const compiled = (doc: ChipDoc, ...more: ChipDoc[]) => {
    const lib = new UserLibrary(workspace(doc, ...more));
    return lib.compiled(doc.id)!;
  };
  const run = (def: ComponentDef) => sw(def);

  it('the shared-bus example: a value, a held 0, a fight', () => {
    const c = compiled(sharedBusChip('u_bus', 'Bus'));
    expect(c.mode).toBe('switch');
    expect(c.diags).toEqual([]);
    expect(c.derived).toMatchObject({ ok: true }); // the pull-down means it never floats
    const s = run(c.def);
    const y = (v: Record<string, number>) => { set(s, v); return show(bit(s, 'bus')); };
    expect(y({ ea: 1, a: 1, eb: 0, b: 0 })).toBe('1');
    expect(y({ ea: 0, eb: 1, b: 1 })).toBe('1');
    expect(y({ eb: 1, b: 0 })).toBe('0');
    expect(y({ ea: 0, eb: 0, a: 1, b: 1 })).toBe('0'); // the pull-down
    expect(y({ ea: 1, eb: 1, a: 1, b: 0 })).toBe('X');
  });

  it.each([['wiredand', (a: number, b: number) => a & b], ['wiredor', (a: number, b: number) => a | b]] as const)('the %s example', (id, f) => {
    const c = compiled(wiredChip(`u_${id}`, id, id === 'wiredand' ? 'and' : 'or'));
    expect(c.diags).toEqual([]);
    const s = run(c.def);
    for (const a of [0, 1]) for (const b of [0, 1]) {
      set(s, { a, b });
      expect(show(bit(s, 'y')), `(${a}, ${b})`).toBe(String(f(a, b)));
    }
  });

  it('a bus through a chip of the user: its output is tri, its parent switch level, no warning', () => {
    // a chip that is just a tri-state buffer, used twice on one net of another chip
    const drv = chip('u_drv', 'Drv', {
      pins: [pin('a', 'in', [0, 6]), pin('en', 'in', [0, 2]), pin('y', 'out', [12, 6])],
      parts: [part('t', { lib: 'tribuf' }, [4, 4])],
      wires: [wire('w1', 'pin:a', 't.a'), wire('w2', 'pin:en', 't.en', [[6, 2]]), wire('w3', 't.y', 'pin:y')],
    });
    const top = chip('u_top', 'Top', {
      pins: [pin('a', 'in', [0, 2]), pin('ea', 'in', [0, 4]), pin('b', 'in', [0, 12]), pin('eb', 'in', [0, 14]), pin('y', 'out', [30, 8])],
      parts: [part('d1', { chip: 'u_drv' }, [6, 1]), part('d2', { chip: 'u_drv' }, [6, 11]), part('pu', { lib: 'pullup' }, [20, 2])],
      wires: [
        wire('a', 'pin:a', 'd1.a'), wire('ea', 'pin:ea', 'd1.en'), wire('b', 'pin:b', 'd2.a'), wire('eb', 'pin:eb', 'd2.en'),
        wire('y1', 'd1.y', 'pin:y'), wire('y2', 'd2.y', 'pin:y'), wire('y3', 'pu.y', 'pin:y'),
      ],
    });
    const lib = new UserLibrary(workspace(top, drv));
    const d = lib.compiled('u_drv')!;
    expect(d.def.ports.find((p) => p.name === 'y')!.tri).toBe(true);
    expect(d.derived).toMatchObject({ ok: false, reason: expect.stringMatching(/floats/) });
    const t = lib.compiled('u_top')!;
    expect(t.mode).toBe('switch');
    expect(t.diags.filter((x) => /share one net/.test(x.msg))).toEqual([]);
    const s = run(t.def);
    set(s, { a: 0, ea: 1, b: 1, eb: 0 }); expect(show(bit(s, 'y'))).toBe('0');
    set(s, { ea: 0 }); expect(show(bit(s, 'y'))).toBe('1'); // the pull-up
  });

  it('warns when outputs that always drive share a net', () => {
    const doc = chip('u_fight', 'Fight', {
      pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 8]), pin('y', 'out', [20, 5])],
      parts: [part('i1', { lib: 'inv_cmos' }, [6, 1]), part('i2', { lib: 'inv_cmos' }, [6, 7])],
      wires: [wire('a', 'pin:a', 'i1.a'), wire('b', 'pin:b', 'i2.a'), wire('y1', 'i1.y', 'pin:y'), wire('y2', 'i2.y', 'pin:y')],
    });
    const c = compileLib(doc);
    expect(c.diags.map((x) => x.msg)).toEqual([expect.stringMatching(/2 outputs that always drive share one net.*tri-state/)]);
    expect(c.def.ports.find((p) => p.name === 'y')!.tri).toBeUndefined();
  });

  it('a capacitor part keeps charge like a wire marked "keeps charge"', () => {
    const doc = (capPart: boolean) => chip(capPart ? 'u_c1' : 'u_c2', 'C', {
      pins: [pin('wl', 'in', [0, 6]), pin('bl', 'in', [6, 0]), pin('q', 'out', [20, 10])],
      parts: [part('a', { lib: 'nmos' }, [3, 4]), ...(capPart ? [part('c', { lib: 'cap' }, [9, 12])] : [])],
      wires: [
        wire('w1', 'pin:wl', 'a.g'), wire('w2', 'pin:bl', 'a.d', [[6, 2]]),
        wire('w3', 'a.s', 'pin:q', [[6, 10]], capPart ? {} : { cap: true }),
        ...(capPart ? [wire('w4', { wire: 'w3', at: [10, 10] }, 'c.a')] : []),
      ],
    });
    for (const capPart of [true, false]) {
      const c = compileLib(doc(capPart));
      expect(c.diags).toEqual([]);
      const s = run(c.def);
      set(s, { wl: 1, bl: 1 }); set(s, { wl: 0, bl: 0 });
      expect(show(bit(s, 'q'))).toBe('1');
    }
  });
});
