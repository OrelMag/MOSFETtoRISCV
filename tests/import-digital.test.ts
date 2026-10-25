// Digital .dig import (src/import/digital.ts): hand-written circuits in Digital's file format, each imported chip
// compiled and simulated against what Digital computes, and kept unchanged by the sandbox's sanitizer.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importDigital, isDigitalFile, normalizeWires } from '../src/import/digital';
import type { ImportResult, SourceFile } from '../src/import/report';
import { UserLibrary } from '../src/editor/library';
import { SCHEMA, type ChipDoc } from '../src/editor/model';
import { sanitizeChip } from '../src/editor/store';
import { simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';
import type { ComponentDef } from '../src/sim/types';

const file = (name: string): SourceFile => ({ name, text: readFileSync(new URL(`./import/${name}`, import.meta.url), 'utf8') });

function load(names: string[], taken: string[] = []): { r: ImportResult; lib: UserLibrary; top: ComponentDef } {
  const r = importDigital(names.map(file), { taken: new Set(taken) });
  if ('error' in r) throw new Error(r.error);
  const chips: Record<string, ChipDoc> = Object.fromEntries(r.chips.map((c) => [c.id, c]));
  const lib = new UserLibrary({ schema: SCHEMA, chips, open: [r.top] });
  for (const c of r.chips) {
    const errs = lib.compiled(c.id)!.diags.filter((d) => d.level === 'error');
    expect(errs, `${c.name}: ${errs.map((d) => d.msg).join('; ')}`).toEqual([]);
    expect(sanitizeChip(JSON.parse(JSON.stringify(c)))).toEqual(c);
  }
  return { r, lib, top: lib.defOf(r.top)! };
}

/** A simulation driven and read by port name. */
function run(def: ComponentDef) {
  const s = simulate(def);
  s.reset('zero');
  return {
    set(v: Record<string, number>) {
      for (const [k, x] of Object.entries(v)) s.setInput(k, x);
      s.settle();
    },
    get: (k: string) => pack(s.getBits(s.design.root.ports[k])),
  };
}

/** Every chip a wire end names exists (no wire was dropped by compile). */
function allWiresKept(r: ImportResult, lib: UserLibrary) {
  for (const c of r.chips) {
    const cc = lib.compiled(c.id)!;
    for (const w of c.wires) expect(cc.netOfWire.has(w.id), `${c.name} ${w.id}`).toBe(true);
  }
}

describe('Digital import', () => {
  it('recognizes .dig files', () => {
    expect(isDigitalFile('x.dig', '')).toBe(true);
    expect(isDigitalFile('x.xml', '<?xml version="1.0"?>\n<circuit>\n  <version>2</version>\n  <visualElements/>')).toBe(true);
    expect(isDigitalFile('x.circ', '<project source="3.8"></project>')).toBe(false);
    expect(importDigital([{ name: 'a.dig', text: '<project/>' }], { taken: new Set() })).toHaveProperty('error');
    expect(importDigital([{ name: 'a.dig', text: '<circuit><bad' }], { taken: new Set() })).toHaveProperty('error');
  });

  it('merges and splits wires as Digital does', () => {
    // collinear touching wires merge; a T end splits the other wire; a crossing joins nothing
    const w = normalizeWires([[[0, 0], [20, 0]], [[20, 0], [60, 0]], [[40, 0], [40, 40]], [[100, -20], [100, 20]], [[80, 0], [120, 0]]]);
    const s = w.map(([a, b]) => `${a}-${b}`).sort();
    expect(s).toEqual(['0,0-40,0', '100,-20-100,20', '40,0-40,40', '40,0-60,0', '80,0-120,0'].sort());
  });

  it('a half adder: gates, wires crossing without joining, a comment and a test table', () => {
    const { r, lib, top } = load(['half-adder.dig'], ['u_half_adder']);
    allWiresKept(r, lib);
    const c = r.chips.find((x) => x.id === r.top)!;
    expect(c.id).toBe('u_half_adder_2');
    expect(c.pins.map((p) => p.name).sort()).toEqual(['A', 'B', 'C', 'S']);
    expect(c.comments?.[0].text).toMatch(/Half adder/);
    expect(c.tests).toEqual([{ name: 'truth table', src: 'A B S C\n0 0 0 0\n0 1 1 0\n1 0 1 0\n1 1 0 1\n' }]);
    // pins where Digital drew them: 20 px = 2 units
    expect(c.pins.find((p) => p.name === 'B')!.at).toEqual([10, 24]);
    const sim = run(top);
    for (let v = 0; v < 4; v++) {
      const [a, b] = [v >> 1, v & 1];
      sim.set({ A: a, B: b });
      expect([sim.get('S'), sim.get('C')]).toEqual([a ^ b, a & b]);
    }
    expect(r.mapping.find((m) => m.from === 'XOr')).toMatchObject({ count: 1, status: 'ok' });
    expect(r.mapping.find((m) => m.from === 'Testcase')?.becomes).toBe('test table');
  });

  it('a full adder placing half-adder.dig twice', () => {
    const { r, top } = load(['full-adder.dig', 'half-adder.dig']);
    expect(r.chips.map((c) => c.name)).toEqual(['half-adder', 'full-adder']);
    expect(r.top).toBe(r.chips[1].id);
    expect(r.chips[1].parts.filter((p) => 'chip' in p.ref)).toHaveLength(2);
    const sim = run(top);
    for (let v = 0; v < 8; v++) {
      const [a, b, ci] = [v >> 2, (v >> 1) & 1, v & 1];
      sim.set({ A: a, B: b, Cin: ci });
      expect(sim.get('S') + 2 * sim.get('Cout')).toBe(a + b + ci);
    }
    // the top is the file nobody places, whatever the order
    const again = importDigital(['half-adder.dig', 'full-adder.dig'].map(file), { taken: new Set() }) as ImportResult;
    expect(again.chips.find((c) => c.id === again.top)!.name).toBe('full-adder');
  });

  it('4 bits through splitters, mergers and tunnels', () => {
    const { r, lib, top } = load(['reverse4.dig']);
    allWiresKept(r, lib);
    expect(r.chips[0].labels.length).toBeGreaterThan(8);
    const sim = run(top);
    for (let x = 0; x < 16; x++) {
      sim.set({ X: x });
      const rev = ((x & 1) << 3) | ((x & 2) << 1) | ((x & 4) >> 1) | ((x & 8) >> 3);
      expect(sim.get('Y')).toBe(rev);
      expect(sim.get('Z')).toBe(x & rev);
      expect(sim.get('H')).toBe(x >> 2);
      expect(sim.get('L0')).toBe(x & 1);
    }
    // Out pins without Bits take their net's width
    expect(r.chips[0].pins.find((p) => p.name === 'H')!.width).toBe(2);
  });

  it('gates: three inputs, a negated input, mirrored and turned parts', () => {
    const { r, top } = load(['gates.dig']);
    const sim = run(top);
    for (let v = 0; v < 8; v++) {
      const [a, b, c] = [(v >> 2) & 1, (v >> 1) & 1, v & 1];
      sim.set({ a, b, c });
      expect(sim.get('Y1')).toBe(a & (1 - b) & c);
      expect(sim.get('Y2')).toBe(1 - (a & b & c));
      expect(sim.get('Y3')).toBe(a ^ b ^ c);
      expect(sim.get('Y4')).toBe(1 - (a | c));
      expect(sim.get('Y5')).toBe(1 - b);
    }
    const chip = r.chips.find((c) => c.id === r.top)!;
    expect(chip.parts.find((p) => p.ref && 'lib' in p.ref && p.ref.lib === 'nor')).toMatchObject({ flip: true, rot: 2 });
    expect(chip.parts.find((p) => 'lib' in p.ref && p.ref.lib === 'not' && p.rot === 3)).toBeTruthy();
  });

  it('arithmetic, comparators, multiplexers, decoders', () => {
    const { top } = load(['arith.dig']);
    const sim = run(top);
    const sx = (v: number) => (v & 8 ? v - 16 : v);
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b += 3) for (const ci of [0, 1]) {
      const sel = (a + b) & 1;
      sim.set({ a, b, ci, sel });
      expect(sim.get('S') + 16 * sim.get('CO')).toBe(a + b + ci);
      const d = a - b - ci;
      expect([sim.get('D'), sim.get('BO')]).toEqual([(d + 32) & 15, d < 0 ? 1 : 0]);
      expect([sim.get('GT'), sim.get('EQ'), sim.get('LT')]).toEqual([+(a > b), +(a === b), +(a < b)]);
      expect(sim.get('SLT')).toBe(+(sx(a) < sx(b)));
      expect(sim.get('M')).toBe(sel ? b : a);
      expect(sim.get('N')).toBe((16 - a) & 15);
      expect(sim.get('E')).toBe(sx(a) & 63);
      expect(sim.get('D2')).toBe(+((a & 3) === 1));
      expect(sim.get('DM1')).toBe(sel ? b : 0);
    }
  });

  it('a D flip-flop counter: the clock on a T junction, and its test case', () => {
    const { r, lib, top } = load(['counter2.dig']);
    allWiresKept(r, lib);
    const chip = r.chips.find((c) => c.id === r.top)!;
    expect(chip.pins.find((p) => p.name === 'C')!.kind).toBe('clock');
    expect(chip.tests?.[0].name).toBe('counts');
    const sim = run(top);
    sim.set({ C: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      sim.set({ C: 1 });
      sim.set({ C: 0 });
      seen.push(2 * sim.get('Q1') + sim.get('Q0'));
    }
    expect(seen).toEqual([1, 2, 3, 0, 1]);
  });

  it("Digital's counter, a register and a ROM", () => {
    const { r, top } = load(['seq.dig']);
    const sim = run(top);
    sim.set({ clk: 0, en: 1, clr: 0, d: 9, A: 0 });
    const tick = () => { sim.set({ clk: 1 }); sim.set({ clk: 0 }); };
    const qs: number[] = [], ovf: number[] = [];
    for (let i = 0; i < 9; i++) { tick(); qs.push(sim.get('Q')); ovf.push(sim.get('OVF')); }
    expect(qs).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1]);
    expect(ovf).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0]);
    expect(sim.get('R')).toBe(9);
    sim.set({ clr: 1 });
    tick();
    expect(sim.get('Q')).toBe(0);
    sim.set({ clr: 0, en: 0, d: 3 });
    tick();
    expect([sim.get('Q'), sim.get('R')]).toEqual([0, 9]);
    const words = [5, 10, 15, 15, 15, 0, 0, 0];
    for (let a = 0; a < 8; a++) { sim.set({ A: a }); expect(sim.get('ROMD')).toBe(words[a]); }
    expect(r.mapping.map((m) => m.from)).toEqual(expect.arrayContaining(['Counter', 'Register', 'ROM']));
  });

  it('a RAM: written at the clock edge with str, read on D', () => {
    const { r, top } = load(['ram.dig']);
    const sim = run(top);
    sim.set({ C: 0, str: 1, ld: 1, A: 2, Din: 7 });
    sim.set({ C: 1 });
    sim.set({ C: 0, A: 1, Din: 9 });
    sim.set({ C: 1 });
    sim.set({ C: 0, str: 0, A: 2 });
    expect(sim.get('D')).toBe(7);
    sim.set({ A: 1 });
    expect(sim.get('D')).toBe(9);
    expect(r.problems).toEqual(['ram ▸ RAMDualPort: ld is ignored: the RAM always drives D']);
  });

  it("follows XStream's references and reads version-0 files on their 10 px grid", () => {
    const el = (rot: string, x: number) => `<visualElement><elementName>Not</elementName><elementAttributes><entry><string>rotation</string>${rot}</entry></elementAttributes><pos x="${x}" y="50"/></visualElement>`;
    const text = `<circuit><version>2</version><attributes/><visualElements>${el('<rotation rotation="1"/>', 100)}${el('<rotation reference="../../../../visualElement[1]/elementAttributes/entry/rotation"/>', 200)}</visualElements><wires/></circuit>`;
    const r = importDigital([{ name: 'refs.dig', text }], { taken: new Set() }) as ImportResult;
    expect(r.chips[0].parts.map((p) => p.rot)).toEqual([3, 3]);
    const old = importDigital([{ name: 'old.dig', text: '<circuit><visualElements><visualElement><elementName>In</elementName><elementAttributes><entry><string>Label</string><string>x</string></entry></elementAttributes><pos x="30" y="40"/></visualElement></visualElements><wires/></circuit>' }], { taken: new Set() }) as ImportResult;
    expect(old.chips[0].pins[0].at).toEqual([6, 8]);
  });

  it('elements it cannot draw and files it was not given become empty chips with their pins', () => {
    const { r, lib } = load(['unknown.dig']);
    allWiresKept(r, lib);
    const stub = r.chips.find((c) => c.name.startsWith('Mul'))!;
    expect(stub.pins.map((p) => `${p.dir}:${p.name}:${p.width}`)).toEqual(['in:in0:4', 'in:in1:4', 'out:out0:1']);
    const missing = r.chips.find((c) => c.name === 'missing')!;
    expect(missing.pins.map((p) => p.dir)).toEqual(['in', 'out']);
    expect(r.problems.some((p) => /^unknown ▸ Mul: not imported/.test(p))).toBe(true);
    expect(r.problems.some((p) => /missing\.dig was not among the files/.test(p))).toBe(true);
    expect(r.mapping.find((m) => m.from === 'Mul')?.status).toBe('stub');
    expect(r.mapping.find((m) => m.from === 'Probe')?.status).toBe('dropped');
    // the stub's pins are on the nets Digital drew
    const top = lib.compiled(r.top)!;
    const part = r.chips.find((c) => c.id === r.top)!.parts.find((p) => 'chip' in p.ref && p.ref.chip === stub.id)!;
    expect(top.netOfEnd.get(`p:${part.id}.in0`)).toBeGreaterThanOrEqual(0);
    expect(top.netOfEnd.get(`p:${part.id}.out0`)).toBeGreaterThanOrEqual(0);
  });
});
