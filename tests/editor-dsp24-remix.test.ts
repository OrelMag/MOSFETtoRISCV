// Open in Sandbox on the DSP core chapter's whole computer: the chip is drawn as Examples ▸ DSP core (the core one part, the ROM in
// DSP24 assembly, X and Y RAM parts with the benchmark's data), so the CPU drawer finds it and runs it to halt against the golden model.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { assemble24 } from '../src/dsp/asm24';
import { BENCH24 } from '../src/dsp/programs24';
import { detectDsp24, Dsp24Monitor, dsp24Program } from '../src/editor/dsp24mon';
import { dspSource } from '../src/editor/exampledsp';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { dsp24Computer } from '../src/lib/dsp24core';

describe('the DSP core computer opened in the sandbox', () => {
  it('writes every word of every benchmark back as itself', () => {
    for (const b of BENCH24) {
      const w = Array.from({ length: 256 }, (_, i) => assemble24(b.src).words[i] ?? 0);
      expect(Array.from({ length: 256 }, (_, i) => assemble24(dspSource(w)).words[i] ?? 0), b.id).toEqual(w);
    }
  });

  for (const b of BENCH24) it(`${b.id}: found by the CPU drawer, and runs to halt in lock step`, () => {
    const words = assemble24(b.src).words;
    const r = remixDef(emptyWorkspace(), dsp24Computer(words, b.x, b.y));
    if ('error' in r) throw new Error(r.error);
    const { ws, id } = r;
    const doc = ws.chips[id];
    expect(detectDsp24(doc)).toEqual({ rom: 'rom', core: 'core', rams: ['xram', 'yram'] });
    expect(dsp24Program(doc, 'rom')).toEqual(Array.from({ length: 256 }, (_, i) => words[i] ?? 0));
    expect(doc.parts.find((p) => p.id === 'xram')!.ref).toMatchObject({ ram: { k: 8, w: 16 } });
    const lib = new UserLibrary(ws);
    const c = lib.compiled(id)!;
    expect(c.diags).toEqual([]);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, doc.pins);
    const mon = new Dsp24Monitor(es, () => ws.chips[id], () => ws.chips);
    expect(mon.checking).toBe(true);
    expect(mon.mem(0)).toEqual(Array.from({ length: 256 }, (_, i) => b.x[i] ?? 0));
    for (let i = 0; i < 400 && !mon.done; i++) mon.runToHalt(1e9);
    expect(mon.mismatch).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(mon.retired).toBe(mon.iss!.steps);
  }, 120000);
});
