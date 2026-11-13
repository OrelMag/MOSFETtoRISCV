// Lay out by logic depth (editor/relayout.ts) on the importers' fixtures: the connectivity unchanged (every net's ends, name,
// stored charge and power-on value), the chip's interface unchanged (port order is canvas order), the result clean (sanitizer,
// no part on a part or a pin, no two nets on one line, every wire on a net), simulating as before, and the drawing measured
// before and after and pinned: wires of different nets crossing, segments through a part they do not end on, pointers.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { UserLibrary } from '../src/editor/library';
import { SCHEMA, type ChipDoc, type PartRef, polyline } from '../src/editor/model';
import { partBox, pinBody } from '../src/editor/geom';
import { lintChip } from '../src/editor/lint';
import { partDef } from '../src/editor/parts';
import { layoutMetrics, relayoutChip, relayoutOffer, relayoutRefusal } from '../src/editor/relayout';
import { sanitizeChip } from '../src/editor/store';
import { importDigital } from '../src/import/digital';
import { importLogisim } from '../src/import/logisim';
import type { ImportResult } from '../src/import/report';
import { evalOnce, forEachInput, inputBits, simulate } from '../src/sim/harness';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { pack } from '../src/sim/values';

const file = (name: string) => ({ name, text: readFileSync(new URL(`./import/${name}`, import.meta.url), 'utf8') });

const SETS: string[][] = [['arith.dig'], ['counter2.dig'], ['full-adder.dig', 'half-adder.dig'], ['gates.dig'], ['ram.dig'],
  ['reverse4.dig'], ['seq.dig'], ['fulladder.circ'], ['bus.circ'], ['counter.circ'], ['rom.circ'], ['old27.circ']];

/**
 * Before → after per chip: crossings, segments through parts, pointers. Measured (the first run printed them); a change to the
 * placement shows here. Hand-drawn sheets with tunnels read better as drawn: the action is for sheets that do not.
 */
const PINNED: Record<string, string> = {
  'arith.dig: NOT ×4': 'cross 0→2, through 0→0, pointers 20→0',
  'arith.dig: Subtract 4 (Digital)': 'cross 0→2, through 0→0, pointers 16→2',
  'arith.dig: Compare 4 (Digital)': 'cross 0→3, through 0→0, pointers 10→0',
  'arith.dig: Compare 4 signed (Digital)': 'cross 0→3, through 0→0, pointers 10→0',
  'arith.dig: Negate 4 (Digital)': 'cross 0→2, through 0→0, pointers 10→2',
  'arith.dig: Sign-extend 4→6': 'cross 0→0, through 0→0, pointers 8→0',
  'arith.dig: Demultiplexer 2×4 (Digital)': 'cross 0→0, through 0→0, pointers 16→6',
  'arith.dig: arith': 'cross 0→70, through 0→0, pointers 25→18', // before: untangle keeps wires under 8 units as drawn (unravel.ts SHORT_WIRE)
  'counter2.dig: counter2': 'cross 5→2, through 0→0, pointers 0→0',
  'full-adder.dig: half-adder': 'cross 1→2, through 0→0, pointers 0→0',
  'full-adder.dig: full-adder': 'cross 2→4, through 0→0, pointers 0→0',
  'gates.dig: NAND 3×1': 'cross 0→0, through 0→0, pointers 12→0',
  'gates.dig: XOR 3×1': 'cross 0→0, through 0→0, pointers 10→0',
  'gates.dig: gates': 'cross 0→13, through 0→0, pointers 12→0',
  'ram.dig: ram': 'cross 1→0, through 0→0, pointers 0→0',
  'reverse4.dig: reverse4': 'cross 0→0, through 0→0, pointers 15→21',
  'seq.dig: Counter 3 (Digital)': 'cross 0→6, through 0→0, pointers 23→4',
  'seq.dig: seq': 'cross 0→10, through 0→0, pointers 4→2',
  'fulladder.circ: half_adder': 'cross 1→2, through 0→0, pointers 0→0',
  'fulladder.circ: full_adder': 'cross 2→2, through 0→0, pointers 0→0',
  'bus.circ: AND ×2 (4-bit)': 'cross 0→32, through 0→0, pointers 30→0',
  'bus.circ: main': 'cross 0→7, through 0→0, pointers 8→0',
  'counter.circ: D flip-flop': 'cross 0→2, through 0→0, pointers 15→0',
  'counter.circ: counter': 'cross 3→2, through 2→0, pointers 2→10',
  'rom.circ: Joystick (not imported)': 'refused (It has no parts to place.)',
  'rom.circ: main': 'cross 0→0, through 0→0, pointers 0→2',
  'old27.circ: main': 'cross 0→0, through 0→0, pointers 0→0',
};

function load(names: string[]): { r: ImportResult; lib: UserLibrary } {
  const r = names[0].endsWith('.dig') ? importDigital(names.map(file), { taken: new Set() }) : importLogisim(names.map(file), { taken: new Set() });
  if ('error' in r) throw new Error(r.error);
  const chips: Record<string, ChipDoc> = Object.fromEntries(r.chips.map((c) => [c.id, c]));
  return { r, lib: new UserLibrary({ schema: SCHEMA, chips, open: [r.top] }) };
}

/** Outputs over 24 clock cycles from power-on, inputs from a seeded generator (a clocked chip). */
function clocked(def: ComponentDef): string {
  const s = simulate(def);
  s.reset('zero');
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const outs: number[] = [];
  for (let k = 0; k < 24; k++) {
    for (const p of def.ports) if (p.dir === 'in' && !p.clock) s.setInput(p.name, rnd() % 2 ** Math.min(p.width, 16));
    for (const p of def.ports) if (p.clock) { s.setInput(p.name, 0); s.settle(); s.setInput(p.name, 1); s.settle(); }
    if (!def.ports.some((p) => p.clock)) s.settle();
    for (const p of def.ports) if (p.dir === 'out') outs.push(pack(s.getBits(s.design.root.ports[p.name])));
  }
  return outs.join(',');
}

function measure() {
  const rows: { chip: string; metrics: string; problems: string[] }[] = [];
  for (const names of SETS) {
    const { r, lib } = load(names);
    const defOfRef = (ref: PartRef) => partDef(ref, (x) => lib.defOf(x));
    const defOf = (p: { ref: PartRef }) => { const d = defOfRef(p.ref); return 'error' in d ? undefined : d; };
    for (const c of r.chips) {
      const built = lib.compiled(c.id)!;
      if (built.diags.some((d) => d.level === 'error')) continue;
      const key = `${names[0]}: ${c.name}`;
      if (relayoutRefusal(c, false)) { rows.push({ chip: key, metrics: `refused (${relayoutRefusal(c, false)})`, problems: [] }); continue; }
      const res = relayoutChip(c, defOfRef);
      if ('error' in res) { rows.push({ chip: key, metrics: '', problems: [`refused: ${res.error}`] }); continue; }
      const d = res.doc;
      const problems: string[] = [];
      const lib2 = new UserLibrary({ schema: SCHEMA, chips: { ...Object.fromEntries(r.chips.map((x) => [x.id, x])), [d.id]: d }, open: [d.id] });
      const after = lib2.compiled(d.id)!;
      const def0 = lib.defOf(c.id)!, def1 = lib2.defOf(d.id)!;
      // the same nets, their names and charge (a pin left open may lose the stub wire that made it a net of one end; a net with
      // no name drawn as pointers takes the pointers' name)
      const nets = (def: ComponentDef) => new Map(netlistOf(def)!.nets.filter((n) => n.ends.length > 1).map((n) => [[...n.ends].sort().join(' '), n]));
      const n0 = nets(def0), n1 = nets(def1);
      if (!isDeepStrictEqual([...n0.keys()].sort(), [...n1.keys()].sort())) problems.push('connectivity changed');
      for (const [k, n] of n0) if ((n.name !== undefined && n1.get(k)?.name !== n.name) || n1.get(k)?.cap !== n.cap) problems.push(`net ${k} renamed or its charge changed`);
      if (!isDeepStrictEqual(def0.powerOn ?? {}, def1.powerOn ?? {})) problems.push('power-on values changed');
      if (!isDeepStrictEqual(def0.ports, def1.ports)) problems.push('the interface (port order) changed');
      for (const e of after.diags.filter((x) => x.level === 'error')) problems.push(`error: ${e.msg}`);
      for (const w of d.wires) if (!((after.netOfWire.get(w.id) ?? -1) >= 0)) problems.push(`wire ${w.id} on no net`);
      if (!isDeepStrictEqual(sanitizeChip(JSON.parse(JSON.stringify(d))), JSON.parse(JSON.stringify(d)))) problems.push('changed by the sanitizer');
      const crosses = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      const boxes = d.parts.map((p) => ({ id: p.id, r: partBox(defOf(p), p.at, p.flip, p.rot) }));
      boxes.forEach((a, i) => {
        for (const b of boxes.slice(i + 1)) if (crosses(a.r, b.r)) problems.push(`${a.id} on ${b.id}`);
        for (const p of d.pins) if (crosses(a.r, pinBody(p))) problems.push(`${a.id} on pin ${p.name}`);
      });
      const polys = new Map(d.wires.flatMap((w) => { const p = polyline(d, w, defOf); return p ? [[w.id, p] as const] : []; }));
      for (const x of lintChip(d, after, polys).diags) if (x.msg.startsWith('two nets drawn on one line')) problems.push(x.msg);
      if (built.mode === 'gate') {
        if (inputBits(def0) <= 10 && !def0.ports.some((p) => p.clock) && !def0.ff) {
          const s0 = simulate(def0), s1 = simulate(def1);
          forEachInput(def0, (v) => { if (!isDeepStrictEqual(evalOnce(s0, v), evalOnce(s1, v))) problems.push(`differs on ${v}`); });
        } else if (clocked(def0) !== clocked(def1)) problems.push('a clocked run differs');
      }
      const m0 = layoutMetrics(c, defOf, built.netOfWire), m1 = layoutMetrics(d, defOf, after.netOfWire);
      rows.push({ chip: key, metrics: `cross ${m0.crossings}→${m1.crossings}, through ${m0.throughParts}→${m1.throughParts}, pointers ${m0.pointers}→${m1.pointers}`, problems: [...new Set(problems)] });
    }
  }
  return rows;
}

describe('lay out by logic depth', () => {
  const rows = measure();
  it('keeps every imported chip\'s connectivity, interface and behaviour, and draws it cleanly', () => {
    for (const r of rows) expect(r.problems, r.chip).toEqual([]);
  });
  it('measures each drawing before and after', () => {
    const got = Object.fromEntries(rows.map((r) => [r.chip, r.metrics]));
    if (!Object.keys(PINNED).length) console.log(JSON.stringify(got, null, 2));
    expect(got).toEqual(PINNED);
  });
  it('is offered only where it reads better: fewer crossings plus wires through parts plus half a point per pointer', () => {
    const verdicts: Record<string, string> = {};
    for (const names of SETS) {
      const { r, lib } = load(names);
      for (const c of r.chips) if (!lib.compiled(c.id)!.diags.some((d) => d.level === 'error')) verdicts[`${names[0]}: ${c.name}`] = relayoutOffer(c, (ref) => partDef(ref, (x) => lib.defOf(x))).kind;
    }
    const better = Object.keys(verdicts).filter((k) => verdicts[k] === 'better');
    // counter.circ's counter lost its wires through parts by turning wires into 9 more pointers: not offered; the small
    // chips whose tunnels become wires at the cost of a crossing or two are
    expect(better).toEqual([
      'arith.dig: NOT ×4', 'arith.dig: Subtract 4 (Digital)', 'arith.dig: Compare 4 (Digital)', 'arith.dig: Compare 4 signed (Digital)',
      'arith.dig: Negate 4 (Digital)', 'arith.dig: Sign-extend 4→6', 'arith.dig: Demultiplexer 2×4 (Digital)', 'counter2.dig: counter2',
      'gates.dig: NAND 3×1', 'gates.dig: XOR 3×1', 'ram.dig: ram', 'seq.dig: Counter 3 (Digital)', 'counter.circ: D flip-flop',
    ]);
    expect(verdicts['rom.circ: Joystick (not imported)']).toBe('refused');
    expect(Object.values(verdicts).filter((v) => v === 'worse').length).toBe(Object.keys(verdicts).length - 14);
  });
  it('refuses what it cannot place, saying why', () => {
    const { r } = load(['rom.circ']);
    const empty = r.chips.find((c) => !c.parts.length)!;
    expect(relayoutRefusal(empty, false)).toMatch(/no parts/);
    const top = r.chips.find((c) => c.id === r.top)!;
    expect(relayoutRefusal(top, true)).toMatch(/generated/);
    expect(relayoutRefusal({ ...top, cpu: { pc: { wire: 'w1' } } } as ChipDoc, false)).toMatch(/processor settings/);
  });
  it('keeps the colours the learner gave nets: each coloured net is the same colour after', () => {
    const { r, lib } = load(['counter2.dig']);
    const defOfRef = (ref: PartRef) => partDef(ref, (x) => lib.defOf(x));
    const c = r.chips.find((x) => x.id === r.top)!;
    const built = lib.compiled(c.id)!;
    // colour every wire of the first two nets that have wires
    const nets = [...new Set(c.wires.map((w) => built.netOfWire.get(w.id)!).filter((n) => n >= 0))].slice(0, 2);
    expect(nets.length).toBe(2);
    const hues = [150, 290];
    const coloured: ChipDoc = { ...c, wires: c.wires.map((w) => { const i = nets.indexOf(built.netOfWire.get(w.id)!); return i < 0 ? w : { ...w, hue: hues[i] }; }) };
    const res = relayoutChip(coloured, defOfRef);
    if ('error' in res) throw new Error(res.error);
    const lib2 = new UserLibrary({ schema: SCHEMA, chips: { ...Object.fromEntries(r.chips.map((x) => [x.id, x])), [c.id]: res.doc }, open: [c.id] });
    const after = lib2.compiled(c.id)!;
    const key = (n: number) => [...built.netOfEnd].filter(([, m]) => m === n).map(([k]) => k).sort()[0];
    nets.forEach((n, i) => {
      const m = after.netOfEnd.get(key(n))!;
      const pieces = [...res.doc.wires.filter((w) => after.netOfWire.get(w.id) === m), ...res.doc.labels.filter((l) => after.netOfLabel.get(l.id) === m)];
      expect(pieces.length, `net ${n}`).toBeGreaterThan(0);
      for (const p of pieces) expect(p.hue, `net ${n}`).toBe(hues[i]);
    });
    // and nothing else got a colour
    expect(res.doc.wires.filter((w) => w.hue !== undefined && !nets.some((n, i) => w.hue === hues[i] && after.netOfWire.get(w.id) === after.netOfEnd.get(key(n))))).toEqual([]);
  });
});
