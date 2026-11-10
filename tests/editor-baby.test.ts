// The sandbox's Manchester Baby example: the part resolves from the document (so a reload, a copy and a share link rebuild
// it), the chip draws without lint warnings, and it runs on EditorSim to the Stop lamp with Kilburn's answer in line 27.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { babyChip, BABY_EXAMPLE_N } from '../src/editor/examplebaby';
import { babyRefDef } from '../src/editor/babypart';
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
