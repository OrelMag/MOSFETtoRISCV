// compileChip: a drawn chip becomes a ComponentDef that simulates, routes as drawn, counts and
// exports; every problem in the drawing becomes a diagnostic, never an exception.

import { describe, expect, it } from 'vitest';
import { checkSimulatable, compileChip, type Compiled } from '../src/editor/compile';
import { type ChipDoc, type PartDoc, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { AND, XOR } from '../src/lib/gates';
import { exportHdl } from '../src/sim/svexport';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';
import { routeNetlist, wireOverlaps } from '../src/view/route';
import { chip, compileLib, halfAdder, part, pin, wire } from './editorkit';

const defOf = (p: PartDoc) => {
  const r = partDef(p.ref, () => undefined);
  return 'error' in r ? undefined : r;
};
const errors = (c: Compiled) => c.diags.filter((d) => d.level === 'error');

describe('compileChip: a half adder', () => {
  const doc = halfAdder();
  const c = compileLib(doc);
  const def = c.def;

  it('compiles cleanly at gate level', () => {
    expect(c.diags).toEqual([]);
    expect(c.mode).toBe('gate');
    expect(def.category).toBe('custom');
    expect(def.ports.map((p) => `${p.dir} ${p.name}`)).toEqual(['in a', 'in b', 'out s', 'out c']);
    expect(netlistOf(def)!.nets.map((n) => n.ends)).toEqual([['a', 'x.a', 'n.a'], ['b', 'x.b', 'n.b'], ['x.y', 's'], ['n.y', 'c']]);
    expect(def.netlist!()).toBe(def.netlist!()); // pre-built, one object
  });

  it('simulates: s = a ^ b, c = a & b', () => {
    const sim = simulate(def);
    forEachInput(def, ([a, b]) => expect(evalOnce(sim, [a, b])).toEqual([a ^ b, a & b]));
  });

  it('maps wires, ends and nets', () => {
    expect([...c.netOfWire]).toEqual([['w1', 0], ['w2', 0], ['w3', 1], ['w4', 1], ['w5', 2], ['w6', 3]]);
    expect(c.netOfEnd.get('p:n.y')).toBe(3);
    expect(c.netOfEnd.get('pin:c')).toBe(3);
  });

  it('routes exactly the drawn wires, branches included, from the driver', () => {
    const { nets } = routeNetlist(def, netlistOf(def)!);
    const pl = (id: string) => polyline(doc, doc.wires.find((w) => w.id === id)!, defOf)!;
    expect(nets[0].paths).toEqual([pl('w1'), [[0, 2], [4, 2], [4, 8], [8, 8]]]);
    expect(nets[1].paths).toEqual([pl('w3'), [[0, 6], [6, 6], [6, 10], [8, 10]]]);
    expect(nets[2].paths).toEqual([pl('w5')]);
    // w6 is drawn from the pin to the gate: the net still runs from its driver.
    expect(nets[3].paths).toEqual([pl('w6').reverse()]);
    expect(wireOverlaps(nets)).toEqual([]);
  });

  it('every sink has a non-empty via (a straight wire gets a midpoint)', () => {
    const n = netlistOf(def)!.nets[2];
    expect(n.via).toEqual({ s: [[16, 3]] });
  });

  it('counts and exports', () => {
    expect(stats(def).nands).toBe(stats(XOR).nands + stats(AND).nands);
    const hdl = exportHdl(def, 'structure');
    expect(hdl.text).toContain('module u_ha');
    expect(hdl.top).toBe('u_ha');
  });

  it('pin order follows y (inputs, then outputs)', () => {
    const moved = { ...doc, pins: doc.pins.map((p) => (p.id === 'b' ? { ...p, at: [0, -4] as [number, number] } : p)) };
    expect(compileLib(moved).def.ports.map((p) => p.name)).toEqual(['b', 'a', 's', 'c']);
  });

  it('connKey ignores moves and sees rewiring', () => {
    const moved = { ...doc, parts: doc.parts.map((p) => (p.id === 'x' ? { ...p, at: [9, 0] as [number, number] } : p)) };
    const m = compileLib(moved);
    expect(m.diags).toEqual([]);
    expect(m.connKey).toBe(c.connKey);
    expect(m.def).not.toBe(def);
    const swapped = { ...doc, wires: doc.wires.map((w) => (w.id === 'w1' ? { ...w, b: { part: 'x', port: 'b' } } : w.id === 'w3' ? { ...w, b: { part: 'x', port: 'a' } } : w)) };
    expect(compileLib(swapped).connKey).not.toBe(c.connKey);
  });

  it('checkSimulatable passes a good chip and catches a short', () => {
    expect(checkSimulatable(c)).toEqual([]);
    const nl = netlistOf(def)!;
    const shorted = { ...def, id: 'u_short', netlist: () => ({ ...nl, nets: [...nl.nets, { ends: ['x.y', 'n.y'] }] }) };
    const d = checkSimulatable({ ...c, def: shorted });
    expect(d).toHaveLength(1);
    expect(d[0].level).toBe('error');
    expect(d[0].msg).toMatch(/driven by both/);
    expect(d[0].parts!.sort()).toEqual(['n', 'x']);
  });
});

describe('compileChip: diagnostics', () => {
  const base = halfAdder();

  it('width mismatch: the net is dropped, its wires are named', () => {
    const doc = { ...base, pins: base.pins.map((p) => (p.id === 'a' ? { ...p, width: 8 } : p)) };
    const c = compileLib(doc);
    const e = errors(c);
    expect(e).toHaveLength(1);
    expect(e[0].msg).toMatch(/width mismatch/);
    expect(e[0].wires).toEqual(['w1', 'w2']);
    expect(e[0].pins).toEqual(['a']);
    expect(e[0].parts).toEqual(['x', 'n']);
    expect(c.netOfWire.get('w1')).toBe(-1);
    expect(c.netOfEnd.get('pin:a')).toBe(-1);
    expect(netlistOf(c.def)!.nets).toHaveLength(3);
    expect(checkSimulatable(c)).toEqual([]);
  });

  it('two drivers at gate level: error, dropped', () => {
    const doc = { ...base, wires: [...base.wires, wire('w7', 'n.y', 'pin:s', [[14, 9], [14, 3]])] };
    const c = compileLib(doc);
    const e = errors(c);
    expect(e).toHaveLength(1);
    expect(e[0].msg).toMatch(/2 outputs drive one net: x\.y, n\.y/);
    expect(e[0].parts).toEqual(['x', 'n']);
    expect(['w5', 'w6', 'w7'].map((w) => c.netOfWire.get(w))).toEqual([-1, -1, -1]);
    expect(checkSimulatable(c)).toEqual([]);
  });

  it('undriven: a warning, the sinks stay X', () => {
    const doc = { ...base, pins: [...base.pins, pin('z', 'out', [20, 14])], parts: [...base.parts, part('g', { lib: 'and' }, [8, 13])], wires: [...base.wires, wire('w8', 'pin:z', 'g.a')] };
    const c = compileLib(doc);
    expect(errors(c)).toEqual([]);
    const w = c.diags.filter((d) => d.level === 'warn');
    expect(w).toHaveLength(1);
    expect(w[0].msg).toMatch(/nothing drives/);
    expect(w[0].wires).toEqual(['w8']);
    expect(c.netOfWire.get('w8')).toBe(-1);
    // g.y drives nothing, z is undriven: X.
    expect(evalOnce(simulate(c.def), [1, 1])).toEqual([0, 1, -1]);
  });

  it('unknown part, unknown library id, unknown port', () => {
    const doc: ChipDoc = {
      ...base,
      parts: [...base.parts, part('q', { lib: 'no_such_part' }, [30, 0])],
      wires: [...base.wires, wire('w9', 'q.a', 'pin:a'), wire('w10', 'ghost.y', 'pin:b'), wire('w11', 'x.zz', 'pin:b')],
    };
    const c = compileLib(doc);
    const msgs = errors(c).map((d) => d.msg);
    expect(msgs).toContain("q: unknown library part 'no_such_part'");
    expect(msgs).toContain("wire to unknown part 'ghost'");
    expect(msgs).toContain("x has no port 'zz'");
    expect(errors(c).find((d) => d.msg.startsWith('q:'))!.parts).toEqual(['q']);
    expect(['w9', 'w10', 'w11'].map((w) => c.netOfWire.get(w))).toEqual([-1, -1, -1]);
    // The rest of the chip still works.
    expect(evalOnce(simulate(c.def), [1, 1])).toEqual([0, 1]);
  });

  it('duplicate and non-identifier pin names', () => {
    const doc = { ...base, pins: [...base.pins, pin('a2', 'in', [0, 12], 1, 'a'), pin('bad', 'in', [0, 14], 1, '3x')] };
    const c = compileLib(doc);
    const e = errors(c);
    expect(e.map((d) => d.msg)).toEqual(["duplicate pin name 'a'", "pin name '3x' is not an identifier (letters, digits, _)"]);
    expect(e[0].pins).toEqual(['a', 'a2']);
    expect(c.def.ports.map((p) => p.name)).toEqual(['a', 'b', 's', 'c']);
  });

  it('a ROM is not available yet; never throws on garbage', () => {
    const doc = { ...base, parts: [...base.parts, part('r', { rom: { k: 2, w: 8, addr: 'word', lang: 'hex', src: '' } }, [30, 0])] };
    expect(errors(compileLib(doc)).map((d) => d.msg)).toEqual(['r: ROM: not yet available']);
    const junk = { id: 'u_j', name: 'J', pins: [{ id: 'p' }], parts: [{ id: 'z', ref: {} }], wires: [{ id: 'w', a: {}, b: {} }], labels: [] } as unknown as ChipDoc;
    const c = compileChip(junk, (ref) => partDef(ref, () => undefined));
    expect(c.diags.length).toBeGreaterThan(0);
  });

  it('a branch off the line warns but still connects', () => {
    const doc = { ...base, wires: base.wires.map((w) => (w.id === 'w2' ? { ...w, a: { wire: 'w1', at: [5, 3] as [number, number] } } : w)) };
    const c = compileLib(doc);
    expect(c.diags.map((d) => d.msg)).toEqual(['branch does not start on its wire']);
    expect(c.netOfWire.get('w2')).toBe(0);
    const sim = simulate(c.def);
    forEachInput(c.def, ([a, b]) => expect(evalOnce(sim, [a, b])).toEqual([a ^ b, a & b]));
  });
});

describe('compileChip: wiring parts', () => {
  it('splitter, merger, constant and display', () => {
    // y = {a[1:0], 2'b10}: a merger of a constant and the low half of a split.
    const doc = chip('u_wiring', 'Wiring', {
      pins: [pin('a', 'in', [0, 4], 4), pin('y', 'out', [30, 4], 4)],
      parts: [
        part('sp', { split: [2, 2] }, [4, 2]),
        part('k', { const: { width: 2, value: 2 } }, [6, 10]),
        part('m', { merge: [2, 2] }, [16, 2]),
        part('d', { display: 'hex', width: 4 }, [24, 10]),
      ],
      wires: [
        wire('w1', 'pin:a', 'sp.in'), wire('w2', 'k.y', 'm.i0'), wire('w3', 'sp.o0', 'm.i1'),
        wire('w4', 'm.out', 'pin:y'), wire('w5', { wire: 'w4', at: [22, 4] }, 'd.a', [[22, 11]]),
      ],
    });
    const c = compileLib(doc);
    expect(c.diags).toEqual([]);
    const sim = simulate(c.def);
    for (let a = 0; a < 16; a++) expect(evalOnce(sim, [a])).toEqual([((a & 3) << 2) | 2]);
    expect(stats(c.def).nands).toBe(0);
    expect(exportHdl(c.def, 'structure').text).not.toContain('disp_');
  });
});
