// The sandbox's Manchester Baby example: the part resolves from the document (so a reload, a copy and a share link rebuild
// it), the chip draws without lint warnings, and it runs on EditorSim to the Stop lamp with Kilburn's answer in line 27.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { babyChip, BABY_EXAMPLE_N } from '../src/editor/examplebaby';
import { babyRefDef } from '../src/editor/babypart';
import { BabyMonitor, detectBaby } from '../src/editor/babymon';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeRef } from '../src/editor/store';
import { BABY_COST } from '../src/chapters/ch-baby';
import { isTubeState } from '../src/lib/baby';
import { SsemISS } from '../src/ssem/iss';
import { ssemWords } from '../src/ssem/asm';
import { KILBURN_ANSWER_LINE, kilburnSource } from '../src/ssem/programs';
import { groupDigits } from '../src/sim/numfmt';

const EX = EXAMPLES.find((e) => e.id === 'baby')!;

function open(src?: string) {
  let { ws, id } = addExample(emptyWorkspace(), EX);
  if (src) ws = { ...ws, chips: { ...ws.chips, [id]: babyChip(id, ws.chips[id].name, src) } };
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return { ws, id, lib, es };
}

const tubeLine = (es: EditorSim, line: number): number => {
  const sim = es.sim!;
  for (let i = 0; i < sim.design.leaves.length; i++) {
    const s = sim.leafState(i);
    if (isTubeState(s)) return s.mem[line] | 0;
  }
  throw new Error('no tube');
};

describe('the Manchester Baby example', () => {
  it('is in the gallery with its card, and its notes quote the machine\'s size', () => {
    expect(EX.group).toBe('computers');
    expect(EX.drawer).toBe(true);
    expect(EX.short.length).toBeGreaterThan(10);
    expect(EX.blurb).toContain(`on ${BABY_EXAMPLE_N}`);
    expect(babyChip('x', 'x').notes).toContain(groupDigits(BABY_COST.all).replace(/ | /g, ' '));
  });

  it('keeps its program as text in the part, which rebuilds the same machine and survives the store\'s sanitizer', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const ref = ws.chips[id].parts.find((p) => p.id === 'baby')!.ref;
    expect(ref).toEqual({ baby: { src: kilburnSource(BABY_EXAMPLE_N) } });
    expect(sanitizeRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
    expect(sanitizeRef({ baby: { src: 5 } })).toBeNull();
    const d = partDef(ref, () => undefined);
    expect('error' in d).toBe(false);
    expect(babyRefDef(kilburnSource(BABY_EXAMPLE_N))).toBe(d);
    expect(babyRefDef('FOO 1')).toMatchObject({ error: expect.stringContaining('unknown instruction') });
  });

  it('draws without lint warnings and compiles clean', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const doc = ws.chips[id];
    const c = lib.compiled(id)!;
    expect(c.diags).toEqual([]);
    const defOf = (p: { ref: PartRef }) => {
      const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    expect(lintChip(doc, c, polys).diags).toEqual([]);
    expect(doc.pins.map((p) => p.id)).toEqual(['clk', 'regen']);
  });

  it('runs to the Stop lamp and halts: line 27 holds the highest proper factor, as on the golden model', () => {
    const { es } = open();
    es.runCycles(100_000, () => es.halted, 1e9);
    expect(es.halted).toBe(true);
    const iss = new SsemISS(ssemWords(kilburnSource(BABY_EXAMPLE_N)));
    iss.run();
    expect(iss.halted).toBe(true);
    expect(iss.store[KILBURN_ANSWER_LINE] | 0).toBe(BABY_EXAMPLE_N / 2);
    expect(tubeLine(es, KILBURN_ANSWER_LINE)).toBe(BABY_EXAMPLE_N / 2);
  });
});

describe('the CPU drawer\'s monitor', () => {
  const mk = () => {
    const o = open();
    const mon = new BabyMonitor(o.es, () => o.ws.chips[o.id], () => o.ws.chips);
    return { ...o, mon };
  };

  it('is detected on the chip, and follows Kilburn\'s routine to its Stop instruction with every CI, A and the lamp equal to the model', () => {
    const { ws, id, es, mon } = mk();
    expect(detectBaby(ws.chips[id])).toMatchObject({ part: 'baby' });
    expect(mon.checking).toBe(true);
    for (let i = 0; i < 20 && !mon.done; i++) mon.runToHalt(1e9);
    expect(mon.mismatch).toBeNull();
    const iss = new SsemISS(ssemWords(kilburnSource(BABY_EXAMPLE_N)));
    iss.run();
    expect(mon.retired).toBe(iss.instrs);
    expect(mon.iss!.halted).toBe(true);
    expect(mon.read()!.store[KILBURN_ANSWER_LINE]).toBe(BABY_EXAMPLE_N / 2);
    expect(mon.read()!.stop).toBe(1);
    expect(mon.log.at(-1)).toMatchObject({ text: expect.stringContaining('STP'), effect: 'Stop' });
    expect(es.cycles).toBeGreaterThanOrEqual(4 * iss.instrs - 4);
  });

  it('steps an instruction at a time (four beats), listing each line as the program wrote it or as it now reads', () => {
    const { es, mon } = mk();
    mon.stepInstr();
    expect(mon.retired).toBe(1);
    expect(es.cycles).toBeLessThanOrEqual(8);
    expect(mon.log[0]).toMatchObject({ pc: 1, text: '1: LDN 24' });
    const r = mon.read()!;
    expect(mon.rowText(1, r.store[1])).toBe('LDN 24');
    expect(mon.rowText(24, r.store[24])).toBe(`NUM ${BABY_EXAMPLE_N - 1}`);
    expect(r.age.length).toBe(32);
  });

  it('with REGEN off the store fades, the run is followed but not checked, and the faded Stop is no longer there', () => {
    const { ws, id, es, mon } = mk();
    es.setInput(ws.chips[id].pins.find((p) => p.id === 'regen')!, 0);
    for (let i = 0; i < 200 && es.cycles < 3000; i++) es.runCycles(500);
    expect(mon.fading).toBe(true);
    expect(mon.checking).toBe(false);
    expect(mon.unchecked).toContain('REGEN is off');
    expect(mon.mismatch).toBeNull();
    expect(mon.read()!.age.some((a) => BabyMonitor.faded(a))).toBe(true);
  });

  it('a hardware that disagrees with the model is a mismatch, named', () => {
    const { es, mon } = mk();
    es.runCycles(1);
    mon.iss!.ci = 7; // the model now believes CI = 7
    for (let i = 0; i < 10 && !mon.mismatch; i++) es.runCycles(4);
    expect(mon.mismatch).toMatchObject({ what: 'baby' });
    expect(mon.mismatch!.detail).toContain('CI + T is');
    expect(mon.done).toBe(true);
  });

  it('a program that does not assemble is a problem, not a crash', () => {
    const o = mk();
    const bad = { ...o.ws.chips[o.id], parts: o.ws.chips[o.id].parts.map((p) => ('baby' in p.ref ? { ...p, ref: { baby: { src: 'FOO 1' } } } : p)) };
    const mon = new BabyMonitor(o.es, () => bad, () => undefined);
    expect(mon.problem).toContain('unknown instruction');
    expect(mon.checking).toBe(false);
    expect(babyRefDef('FOO 1')).toMatchObject({ error: expect.any(String) });
  });
});
