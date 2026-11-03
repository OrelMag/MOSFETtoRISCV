// lr.w / sc.w on the designs that predate them (the shared-memory dual-core, the single-cycle CPU): what a learner sees.
import { describe, expect, it } from 'vitest';
import { CpuMonitor, mismatchText } from '../src/editor/cpu';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type ChipDoc, type Workspace } from '../src/editor/model';
import { MultiMonitor } from '../src/editor/multicpu';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { singleCycleCpu } from '../src/lib/cpu';
import { dualCore } from '../src/lib/multicore';
import { assemble } from '../src/riscv/asm';
import { COH_PROGRAMS } from '../src/riscv/cohprograms';
import { lrScNote } from '../src/riscv/hwgaps';
import type { ComponentDef } from '../src/sim/types';

function open(def: ComponentDef): { doc: () => ChipDoc; chips: () => Workspace['chips']; es: EditorSim } {
  const r = remixDef(emptyWorkspace(), def);
  if ('error' in r) throw new Error(r.error);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(new UserLibrary(r.ws).compiled(r.id)!, r.ws.chips[r.id].pins);
  return { es, doc: () => r.ws.chips[r.id], chips: () => r.ws.chips };
}
const src = COH_PROGRAMS.find((p) => p.id === 'lrsc')!.source;

describe('lr.w / sc.w on the older designs', { timeout: 120000 }, () => {
  it('the sandbox multi-core monitor on the shared-memory dual-core', () => {
    const c = open(dualCore(assemble(src).words));
    const m = new MultiMonitor(c.es, c.doc, c.chips);
    while (!m.done && c.es.cycles < 2000) m.runToHalt(Infinity);
    console.log('multi:', m.mismatch ? mismatchText(m.mismatch) : 'no mismatch');
    expect(m.mismatch).not.toBeNull();
    // the monitor's program is what the note is made from
    expect(m.prog && lrScNote(m.prog.words)).toMatch(/lr.w and sc.w is not in this design/);
  });
  it('the single-cycle CPU monitor', () => {
    const w = assemble(src).words;
    const c = open(singleCycleCpu(w));
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    while (!m.done && c.es.cycles < 500) m.runToHalt(Infinity);
    expect(m.mismatch).not.toBeNull();
    expect(m.prog && lrScNote(m.prog.words)).not.toBeNull();
  });
  it('the note names only what the program uses, and is silent without them', () => {
    expect(lrScNote(assemble('addi t0, t0, 1\namoadd.w t0, t1, (s0)').words)).toBeNull();
    expect(lrScNote(assemble('lr.w t0, (s0)').words)).toMatch(/^lr\.w is not/);
  });
});
