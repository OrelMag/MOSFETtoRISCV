// Logisim-evolution / Logisim 2.7 .circ import: every imported chip compiles, simulates as Logisim would, and survives
// the store's sanitizer unchanged; test vectors convert to Digital's syntax.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UserLibrary } from '../src/editor/library';
import { SCHEMA, type ChipDoc } from '../src/editor/model';
import { sanitizeChip } from '../src/editor/store';
import { importLogisim, isLogisimFile, logisimVectors } from '../src/import/logisim';
import type { ImportResult } from '../src/import/report';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';

const fixture = (name: string) => ({ name, text: readFileSync(new URL(`./import/${name}`, import.meta.url), 'utf8') });

function load(name: string, taken: string[] = []): { r: ImportResult; lib: UserLibrary; top: ComponentDef } {
  const r = importLogisim([fixture(name)], { taken: new Set(taken) });
  if ('error' in r) throw new Error(r.error);
  const chips: Record<string, ChipDoc> = {};
  for (const c of r.chips) chips[c.id] = c;
  const lib = new UserLibrary({ schema: SCHEMA, chips, open: [] });
  return { r, lib, top: lib.defOf(r.top)! };
}

function errorsOf(lib: UserLibrary, r: ImportResult) {
  return r.chips.flatMap((c) => lib.compiled(c.id)!.diags.filter((d) => d.level === 'error').map((d) => `${c.id}: ${d.msg}`));
}

const ports = (d: ComponentDef) => d.ports.map((p) => `${p.dir} ${p.name}${p.width > 1 ? `[${p.width}]` : ''}`);

describe('Logisim import', () => {
  it('recognizes .circ files', () => {
    expect(isLogisimFile('a.circ', '')).toBe(true);
    expect(isLogisimFile('a.xml', fixture('halfadder.circ').text)).toBe(true);
    expect(isLogisimFile('a.dig', '<?xml version="1.0"?><circuit><version>2</version></circuit>')).toBe(false);
    expect(importLogisim([{ name: 'x.circ', text: '<project source="3.8.0"></project>' }], { taken: new Set() })).toEqual({ error: 'the project has no circuit' });
    expect(importLogisim([{ name: 'x.circ', text: '<project><circuit name="a">' }], { taken: new Set() })).toHaveProperty('error');
  });

  it('a half adder: library gates, the drawing kept, a comment', () => {
    const { r, lib, top } = load('halfadder.circ', ['u_half_adder']);
    expect(r.top).toBe('u_half_adder_2');
    expect(errorsOf(lib, r)).toEqual([]);
    expect(ports(top)).toEqual(['in A', 'in B', 'out S', 'out C']);
    const sim = simulate(top);
    forEachInput(top, ([a, b]) => expect(evalOnce(sim, [a, b])).toEqual([a ^ b, a & b]));
    const doc = r.chips.find((c) => c.id === r.top)!;
    expect(doc.parts.map((p) => p.ref)).toEqual([{ lib: 'xor' }, { lib: 'and' }]);
    expect(doc.pins.find((p) => p.name === 'A')!.at).toEqual([10, 17]);
    expect(doc.comments?.[0].text).toBe('Half adder');
    // Logisim's corners are ours: the branch to the AND gate turns at (15, 17) and (15, 24)
    expect(doc.wires.some((w) => w.pts.some((p) => p[0] === 15 && p[1] === 24))).toBe(true);
    expect(r.mapping.find((m) => m.from === 'XOR Gate')).toMatchObject({ count: 1, status: 'ok' });
  });

  it('a full adder from two half adders: subcircuits keep their ports (evolution appearance)', () => {
    const { r, lib, top } = load('fulladder.circ');
    expect(errorsOf(lib, r)).toEqual([]);
    expect(r.chips.map((c) => c.name)).toEqual(['half_adder', 'full_adder']);
    expect(ports(top)).toEqual(['in A', 'in B', 'in Cin', 'out Cout', 'out Sum']);
    const sim = simulate(top);
    forEachInput(top, ([a, b, c]) => {
      const s = a + b + c;
      expect(evalOnce(sim, [a, b, c])).toEqual([s >> 1, s & 1]);
    });
    const main = r.chips[1];
    expect(main.parts.filter((p) => 'chip' in p.ref).map((p) => p.id)).toEqual(['ha1', 'ha2']);
  });

  it('splitters and tunnels on a 4-bit bus, a wide gate with a constant, a probe dropped', () => {
    const { r, lib, top } = load('bus.circ');
    expect(errorsOf(lib, r)).toEqual([]);
    expect(ports(top)).toEqual(['in X[4]', 'out Y[4]', 'out Y2[4]']);
    const rev = (x: number) => ((x & 1) << 3) | ((x & 2) << 1) | ((x & 4) >> 1) | ((x & 8) >> 3);
    const sim = simulate(top);
    for (let x = 0; x < 16; x++) expect(evalOnce(sim, [x])).toEqual([rev(x), x & 5]);
    const doc = r.chips.find((c) => c.id === r.top)!;
    expect(doc.labels.filter((l) => l.name === 'b0')).toHaveLength(2);
    expect(doc.parts.map((p) => Object.keys(p.ref)[0]).sort()).toEqual(['chip', 'const', 'merge', 'split']);
    expect(r.mapping.find((m) => m.from === 'Probe')).toMatchObject({ status: 'dropped' });
    expect(r.mapping.find((m) => m.from === 'Splitter' && m.becomes === 'merger')).toBeTruthy();
  });

  it('a D flip-flop counter with a clock: crossing wires do not join, the clock becomes a pin', () => {
    const { r, lib, top } = load('counter.circ');
    expect(errorsOf(lib, r)).toEqual([]);
    expect(ports(top)).toEqual(['in clk', 'out Q0', 'out Q1']);
    expect(top.ports.find((p) => p.name === 'clk')!.clock).toBe(true);
    const sim = simulate(top);
    sim.reset('zero');
    const read = () => evalOnce(sim, [0]);
    expect(read()).toEqual([0, 0]);
    for (let n = 1; n <= 8; n++) {
      evalOnce(sim, [1]);
      const [q0, q1] = read();
      expect(q0 + 2 * q1).toBe(n % 4);
    }
  });

  it('a ROM keeps its contents; an unknown component becomes an empty chip with its pin', () => {
    const { r, lib, top } = load('rom.circ');
    expect(errorsOf(lib, r)).toEqual([]);
    const sim = simulate(top);
    const mem = [3, 5, 10, 15];
    for (let a = 0; a < 4; a++) expect(evalOnce(sim, [a])).toEqual([mem[a]]);
    expect(r.mapping.find((m) => m.from === 'Joystick')).toMatchObject({ status: 'stub', becomes: 'empty chip, same pins' });
    expect(r.problems.some((p) => p.startsWith('main ▸ Joystick: '))).toBe(true);
    const stub = r.chips.find((c) => c.name === 'Joystick (not imported)')!;
    expect(stub.pins.map((p) => `${p.dir} ${p.width}`)).toEqual(['in 4']);
    const doc = r.chips.find((c) => c.id === r.top)!;
    expect(doc.parts.some((p) => 'display' in p.ref && p.ref.display === 'hex')).toBe(true);
  });

  it('original Logisim 2.7: five-input gates by default (open inputs ignored), the multiplexer\'s enable', () => {
    const { r, lib, top } = load('old27.circ');
    expect(errorsOf(lib, r)).toEqual([]);
    expect(ports(top)).toEqual(['in I0', 'in I1', 'in S', 'in P', 'in Q', 'out Y', 'out PQ']);
    const sim = simulate(top);
    forEachInput(top, ([i0, i1, s, p, q]) => expect(evalOnce(sim, [i0, i1, s, p, q])).toEqual([s ? i1 : i0, p & q]));
  });

  it('every imported chip passes the store\'s sanitizer unchanged', () => {
    for (const f of ['halfadder.circ', 'fulladder.circ', 'bus.circ', 'counter.circ', 'rom.circ', 'old27.circ']) {
      const { r } = load(f);
      for (const c of r.chips) expect(sanitizeChip(JSON.parse(JSON.stringify(c)))).toEqual(c);
    }
  });

  it('attaches a test vector file to the main circuit', () => {
    const r = importLogisim([fixture('halfadder.circ'), { name: 'ha.txt', text: 'A B S C\n0 0 0 0\n1 1 0 1\n' }], { taken: new Set() });
    if ('error' in r) throw new Error(r.error);
    expect(r.chips.find((c) => c.id === r.top)!.tests).toEqual([{ name: 'ha', src: 'A B S C\n0 0 0 0\n1 1 0 1\n' }]);
  });
});

describe('Logisim test vectors → Digital test syntax', () => {
  it('binary, hex, octal, decimal and negative values; widths', () => {
    const v = logisimVectors('# adder\nA[4] B[4] Sum[5]\n0011 0x4 7\n1111 0o17 -1\n');
    expect(v).toEqual({ src: 'A B Sum\n0b0011 0x4 7\n0b1111 15 31\n' });
  });
  it("don't cares and floating values; 1-bit columns", () => {
    expect(logisimVectors('a b[2] y[3]\n1 xx <DC>\n0 0b1x <float>\n')).toEqual({
      src: "# partial don't cares (0b1x) are checked as X here\na b y\n1 X X\n0 X Z\n",
    });
  });
  it('sets and sequences are dropped as columns, kept as comments', () => {
    const v = logisimVectors('<set> <seq> clk q\n1 1 0 0\n1 2 1 1\n2 1 0 0\n');
    expect(v).toEqual({ src: '# Logisim resets the circuit between sets; here the rows run in one sequence\nclk q\n# set 1\n0 0\n1 1\n# set 2\n0 0\n' });
  });
  it('names become identifiers; errors name the line', () => {
    expect(logisimVectors('A.out[2] 9in\n01 1\n')).toEqual({ src: 'A_out _9in\n0b01 1\n' });
    expect(logisimVectors('a b\n0\n')).toEqual({ error: 'line 2: not enough values' });
    expect(logisimVectors('a\n2x\n')).toEqual({ error: 'line 2: "2x" is not a value' });
    expect(logisimVectors('a[x]\n')).toHaveProperty('error');
    expect(logisimVectors('# nothing\n')).toEqual({ error: 'empty test vector file' });
  });
});

// ---- one component per circuit, a pin touching each port (Logisim joins touching ports) ----

type P = [label: string, x: number, y: number, dir: 'in' | 'out', width?: number];

function single(lib: string, name: string, attrs: Record<string, string>, pins: P[], source = '3.8.0', loc: [number, number] = [300, 300]): string {
  const a = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `<a name="${k}" val="${v}"/>`).join('');
  const pinXml = pins.map(([l, x, y, d, w]) => `<comp lib="0" loc="(${loc[0] + x},${loc[1] + y})" name="Pin">${a({
    label: l, ...(d === 'out' ? { type: 'output', facing: 'west' } : {}), ...(w && w > 1 ? { width: String(w) } : {}),
  })}</comp>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="${source}" version="1.0">
  <lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/><lib desc="#Plexers" name="2"/><lib desc="#Arithmetic" name="3"/><lib desc="#Memory" name="4"/>
  <main name="main"/>
  <circuit name="main">
    <comp lib="${lib}" loc="(${loc[0]},${loc[1]})" name="${name}">${a(attrs)}</comp>
    ${pinXml}
  </circuit>
</project>`;
}

function build(xml: string) {
  const r = importLogisim([{ name: 't.circ', text: xml }], { taken: new Set() });
  if ('error' in r) throw new Error(r.error);
  const chips: Record<string, ChipDoc> = {};
  for (const c of r.chips) chips[c.id] = c;
  const lib = new UserLibrary({ schema: SCHEMA, chips, open: [] });
  expect(errorsOf(lib, r)).toEqual([]);
  for (const c of r.chips) expect(sanitizeChip(JSON.parse(JSON.stringify(c)))).toEqual(c);
  const top = lib.defOf(r.top)!;
  const sim = simulate(top);
  sim.reset('zero');
  const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) sim.setInput(k, v); sim.settle(); };
  const get = (n: string) => {
    const bits = sim.getBits(sim.design.root.ports[n]);
    return bits.some((b) => b > 1) ? -1 : bits.reduce((s: number, b, i) => s + b * 2 ** i, 0);
  };
  const tick = (o: Record<string, number> = {}) => { set({ ...o, clk: 0 }); set({ clk: 1 }); };
  return { r, top, set, get, tick };
}

describe('Logisim components: helper chips behave as Logisim', () => {
  it('AND, 3 inputs, 2 bits, the middle one negated', () => {
    const t = build(single('1', 'AND Gate', { inputs: '3', width: '2', negate1: 'true' }, [['a', -50, -20, 'in', 2], ['b', -60, 0, 'in', 2], ['c', -50, 20, 'in', 2], ['y', 0, 0, 'out', 2]]));
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) { t.set({ a, b, c }); expect(t.get('y')).toBe(a & ~b & c & 3); }
  });
  it('XOR, 3 inputs, exactly one', () => {
    const t = build(single('1', 'XOR Gate', { inputs: '3', xor: '1' }, [['a', -60, -20, 'in'], ['b', -60, 0, 'in'], ['c', -60, 20, 'in'], ['y', 0, 0, 'out']]));
    for (let v = 0; v < 8; v++) { t.set({ a: v & 1, b: (v >> 1) & 1, c: v >> 2 }); expect(t.get('y')).toBe([1, 2, 4].includes(v) ? 1 : 0); }
  });
  it('NAND with one input connected is an inverter', () => {
    const t = build(single('1', 'NAND Gate', {}, [['a', -60, -20, 'in'], ['y', 0, 0, 'out']]));
    t.set({ a: 0 }); expect(t.get('y')).toBe(1);
    t.set({ a: 1 }); expect(t.get('y')).toBe(0);
    expect(t.r.chips[0].parts[0].ref).toEqual({ lib: 'not' });
  });
  it('a 4-input, 3-bit multiplexer', () => {
    const t = build(single('2', 'Multiplexer', { select: '2', width: '3' }, [['d0', -40, -20, 'in', 3], ['d1', -40, -10, 'in', 3], ['d2', -40, 0, 'in', 3], ['d3', -40, 10, 'in', 3], ['s', -20, 20, 'in', 2], ['y', 0, 0, 'out', 3]]));
    for (let s = 0; s < 4; s++) { t.set({ d0: 1, d1: 2, d2: 5, d3: 7, s }); expect(t.get('y')).toBe([1, 2, 5, 7][s]); }
  });
  it('a decoder (enable left open reads 1) and a demultiplexer', () => {
    const d = build(single('2', 'Decoder', { select: '2' }, [['y0', 20, -40, 'out'], ['y1', 20, -30, 'out'], ['y2', 20, -20, 'out'], ['y3', 20, -10, 'out'], ['s', 0, 0, 'in', 2]]));
    for (let s = 0; s < 4; s++) { d.set({ s }); expect([0, 1, 2, 3].map((i) => d.get(`y${i}`))).toEqual([0, 1, 2, 3].map((i) => +(i === s))); }
    const m = build(single('2', 'Demultiplexer', { width: '2' }, [['y0', 30, -10, 'out', 2], ['y1', 30, 10, 'out', 2], ['s', 20, 20, 'in'], ['x', 0, 0, 'in', 2]]));
    m.set({ x: 3, s: 1 }); expect([m.get('y0'), m.get('y1')]).toEqual([0, 3]);
    m.set({ x: 2, s: 0 }); expect([m.get('y0'), m.get('y1')]).toEqual([2, 0]);
  });
  it('comparator (signed by default), subtractor (borrow in open), adder with carry, bit extender', () => {
    const c = build(single('3', 'Comparator', { width: '4' }, [['a', -40, -10, 'in', 4], ['b', -40, 10, 'in', 4], ['gt', 0, -10, 'out'], ['eq', 0, 0, 'out'], ['lt', 0, 10, 'out']]));
    const sx = (v: number) => (v & 8 ? v - 16 : v);
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
      c.set({ a, b });
      expect([c.get('gt'), c.get('eq'), c.get('lt')]).toEqual([+(sx(a) > sx(b)), +(a === b), +(sx(a) < sx(b))]);
    }
    const s = build(single('3', 'Subtractor', { width: '4' }, [['a', -40, -10, 'in', 4], ['b', -40, 10, 'in', 4], ['d', 0, 0, 'out', 4], ['bo', -20, 20, 'out']]));
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) { s.set({ a, b }); expect([s.get('d'), s.get('bo')]).toEqual([(a - b) & 15, +(a < b)]); }
    const ad = build(single('3', 'Adder', { width: '4' }, [['a', -40, -10, 'in', 4], ['b', -40, 10, 'in', 4], ['s', 0, 0, 'out', 4], ['ci', -20, -20, 'in'], ['co', -20, 20, 'out']]));
    ad.set({ a: 9, b: 8, ci: 1 }); expect([ad.get('s'), ad.get('co')]).toEqual([2, 1]);
    const e = build(single('0', 'Bit Extender', { in_width: '3', out_width: '6' }, [['a', -40, 0, 'in', 3], ['y', 0, 0, 'out', 6]]));
    for (let a = 0; a < 8; a++) { e.set({ a }); expect(e.get('y')).toBe(a & 4 ? a | 0x38 : a); }
  });
  it('a register with clear and enable (evolution appearance)', () => {
    const t = build(single('4', 'Register', { width: '4' }, [['q', 60, 30, 'out', 4], ['d', 0, 30, 'in', 4], ['clk', 0, 70, 'in'], ['clr', 30, 90, 'in'], ['en', 0, 50, 'in']]));
    t.set({ clr: 0, en: 1 });
    t.tick({ d: 9 }); expect(t.get('q')).toBe(9);
    t.set({ en: 0 }); t.tick({ d: 3 }); expect(t.get('q')).toBe(9);
    t.set({ clr: 1 }); expect(t.get('q')).toBe(0);
  });
  it('a counter to 5 that wraps (open inputs: count up, enabled)', () => {
    const t = build(single('4', 'Counter', { width: '3', max: '0x5' }, [['q', 180, 110, 'out', 3], ['clk', 0, 80, 'in'], ['carry', 180, 50, 'out']]));
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) { seen.push(t.get('q')); t.tick(); }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
  });
  it('a classic D flip-flop on the falling edge with reset; a J-K flip-flop', () => {
    const t = build(single('4', 'D Flip-Flop', { appearance: 'classic', trigger: 'falling' }, [['d', -40, 20, 'in'], ['clk', -40, 0, 'in'], ['q', 0, 0, 'out'], ['nq', 0, 20, 'out'], ['rst', -10, 30, 'in']]));
    t.set({ rst: 0, d: 1, clk: 1 }); t.set({ clk: 0 }); expect([t.get('q'), t.get('nq')]).toEqual([1, 0]);
    t.set({ d: 0, clk: 1 }); expect(t.get('q')).toBe(1);
    t.set({ rst: 1 }); expect(t.get('q')).toBe(0);
    const jk = build(single('4', 'J-K Flip-Flop', {}, [['j', -10, 10, 'in'], ['k', -10, 30, 'in'], ['clk', -10, 50, 'in'], ['q', 50, 10, 'out']]));
    jk.tick({ j: 1, k: 0 }); expect(jk.get('q')).toBe(1);
    jk.tick({ j: 1, k: 1 }); expect(jk.get('q')).toBe(0);
    jk.tick({ j: 1, k: 1 }); expect(jk.get('q')).toBe(1);
  });
  it("a RAM with Logisim-evolution's defaults", () => {
    const t = build(single('4', 'RAM', { addrWidth: '3', dataWidth: '4' }, [['a', 0, 10, 'in', 3], ['dout', 240, 90, 'out', 4], ['din', 0, 90, 'in', 4], ['we', 0, 50, 'in'], ['clk', 0, 70, 'in']]));
    t.tick({ a: 2, din: 7, we: 1 });
    t.tick({ a: 5, din: 3, we: 1 });
    t.set({ we: 0, a: 2 }); expect(t.get('dout')).toBe(7);
    t.set({ a: 5 }); expect(t.get('dout')).toBe(3);
  });
});
