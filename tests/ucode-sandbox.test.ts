// The painter in the sandbox: a remixed multicycle CPU has the controller as a part; swapping its reference for an
// edited microprogram (what Apply does) keeps the wires, survives the store's sanitizer and runs against the golden
// model in the CPU drawer's monitor, in fewer cycles.

import { describe, expect, it } from 'vitest';
import { CpuMonitor, detectCpu } from '../src/editor/cpu';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type Workspace } from '../src/editor/model';
import { setRef } from '../src/editor/ops';
import { partDef } from '../src/editor/parts';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeChip } from '../src/editor/store';
import { microcodePart, microprogramOfPart } from '../src/editor/ucodepart';
import { MC_MICRO, microController, multicycleCpu } from '../src/lib';
import { bookProgram, iTypeInThree, sameProgram, setField, type Microprogram } from '../src/lib/ucode';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';

const words = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source).words;

function run(ws: Workspace, id: string): { cycles: number; mismatch: string | null; halted: boolean } {
  const es = new EditorSim({ debounceMs: 0 });
  es.update(new UserLibrary(ws).compiled(id)!, ws.chips[id].pins);
  const m = new CpuMonitor(es, () => ws.chips[id], () => ws.chips);
  expect(m.checking).toBe(true);
  while (!m.done && es.cycles < 5000) m.runToHalt(Infinity);
  return { cycles: es.cycles, mismatch: m.mismatch ? String(m.mismatch) : null, halted: !!m.iss?.halted };
}

describe('microcode in the sandbox', { timeout: 120000 }, () => {
  it('the remixed CPU has the book\'s controller as a library part; an edit swaps the reference', () => {
    const r = remixDef(emptyWorkspace(), multicycleCpu(words, { control: 'micro' }));
    if ('error' in r) throw new Error(r.error);
    const doc = r.ws.chips[r.id];
    const part = microcodePart(doc)!;
    expect(part.ref).toEqual({ lib: 'mc_micro' });
    expect(detectCpu(doc, r.ws.chips)).toBeTruthy();
    expect(microprogramOfPart(part)).toEqual(bookProgram());
    const book = run(r.ws, r.id);
    expect(book).toMatchObject({ mismatch: null, halted: true });

    const edited = setRef(doc, part.id, { ucode: iTypeInThree() });
    expect(edited.reason).toBeUndefined();
    const ws: Workspace = { ...r.ws, chips: { ...r.ws.chips, [r.id]: edited.doc } };
    // the store keeps the program (and turns the book's back into the library part)
    const saved = sanitizeChip(JSON.parse(JSON.stringify(ws.chips[r.id])))!;
    expect(sameProgram((microcodePart(saved)!.ref as { ucode: Microprogram }).ucode, iTypeInThree())).toBe(true);
    const again = setRef(doc, part.id, { ucode: bookProgram() });
    expect(microcodePart(sanitizeChip(JSON.parse(JSON.stringify(again.doc)))!)!.ref).toEqual({ lib: 'mc_micro' });

    expect(partDef({ ucode: iTypeInThree() }, () => undefined)).toBe(microController(iTypeInThree()));
    const fast = run(ws, r.id);
    expect(fast).toMatchObject({ mismatch: null, halted: true });
    expect(fast.cycles).toBeLessThan(book.cycles);
  });

  it('a broken edit is caught by the drawer\'s monitor', () => {
    const r = remixDef(emptyWorkspace(), multicycleCpu(words, { control: 'micro' }));
    if ('error' in r) throw new Error(r.error);
    const part = microcodePart(r.ws.chips[r.id])!;
    const broken = setRef(r.ws.chips[r.id], part.id, { ucode: setField(bookProgram(), 7, 'resultSrc', 1) });
    const res = run({ ...r.ws, chips: { ...r.ws.chips, [r.id]: broken.doc } }, r.id);
    expect(res.mismatch).not.toBeNull();
  });

  it('an edited CPU remixes to the same part', () => {
    const def = multicycleCpu(words, { control: 'micro', microcode: iTypeInThree() });
    const r = remixDef(emptyWorkspace(), def);
    if ('error' in r) throw new Error(r.error);
    expect(sameProgram((microcodePart(r.ws.chips[r.id])!.ref as { ucode: Microprogram }).ucode, iTypeInThree())).toBe(true);
    expect(MC_MICRO.id).toBe('mc_micro');
  });
});
