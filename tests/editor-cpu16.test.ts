// The sandbox's RV16 lock-step (editor/cpu16.ts): a computer made of a core part and an RV16 ROM is
// found without any naming, its register writes and stores match the golden model in order, and a
// core missing hardware is caught at the first wrong write.

import { describe, expect, it } from 'vitest';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { detectRv16, Rv16Monitor } from '../src/editor/cpu16';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import '../src/lib';

function computer(edit?: (d: ChipDoc) => ChipDoc) {
  let doc = levelChallenge(nodeById('c_computer')!)!.answer().at(-1)!;
  if (edit) doc = edit(doc);
  const ws = { ...emptyWorkspace(), chips: { [doc.id]: doc } };
  const es = new EditorSim({ debounceMs: 0 });
  es.update(new UserLibrary(ws).compiled(doc.id)!, doc.pins);
  return { doc, es, ws };
}

describe('RV16 computers in the sandbox', { timeout: 60000 }, () => {
  it('finds the ROM and the core by their shape', () => {
    const { doc, ws } = computer();
    const d = detectRv16(doc, ws.chips)!;
    expect(d).not.toBeNull();
    expect(doc.parts.find((p) => p.id === d.rom)!.ref).toHaveProperty('rom');
    expect(doc.parts.find((p) => p.id === d.core)!.ref).toEqual({ lib: 'rv16_cpu' });
    expect(d.system).toBe(false);
    expect(detectRv16({ ...doc, parts: doc.parts.filter((p) => p.id !== d.core) }, ws.chips)).toBeNull();
  });

  it('the reference computer matches the golden model write for write', () => {
    const { doc, es } = computer();
    const m = new Rv16Monitor(es, () => doc);
    expect(m.checking).toBe(true);
    m.runToHalt(Infinity, 400);
    expect(m.mismatch).toBeNull();
    expect(m.retired).toBeGreaterThan(100);
    expect(m.log.at(-1)!.effect).toMatch(/←/);
    // The LEDs pin shows what the program last stored there.
    const lastLeds = [...m.log].reverse().find((e) => e.effect.startsWith('[0xfffb]'));
    expect(lastLeds).toBeDefined();
    expect(m.leds).toBe(Number.parseInt(lastLeds!.effect.split('← ')[1], 16));
    // Step: one checked write at a time.
    const n = m.retired;
    m.stepInstr();
    expect(m.retired).toBe(n + 1);
  });

  it('a core without branch hardware fails at its first wrong write, naming the instruction', () => {
    const { doc, es } = computer((d) => ({ ...d, parts: d.parts.map((p) => ('lib' in p.ref && p.ref.lib === 'rv16_cpu' ? { ...p, ref: { lib: 'rv16_cpu_nb' } } : p)) }));
    const m = new Rv16Monitor(es, () => doc);
    m.runToHalt(Infinity, 400);
    expect(m.mismatch).not.toBeNull();
    expect(m.mismatch!.detail).toMatch(/expected .* from “/);
    expect(m.done).toBe(true);
  });
});

describe('debug a failing core test in the sandbox', { timeout: 120000 }, () => {
  async function bench(level: string, coreFrom: string, test?: string) {
    const { addBench, failingTest } = await import('../src/campaign/bench');
    const { coreSpecOf, runCore } = await import('../src/campaign/corecheck');
    const ch = levelChallenge(nodeById(level)!)!;
    const spec = coreSpecOf(ch.check)!;
    const coreDoc = levelChallenge(nodeById(coreFrom)!)!.answer().at(-1)!;
    let ws = { ...emptyWorkspace(), chips: { [coreDoc.id]: coreDoc } };
    const core = new UserLibrary(ws).compiled(coreDoc.id)!.def;
    const run = runCore(core, 'gate', spec);
    const t = test ? spec.tests().find((x) => x.name === test)! : failingTest(spec, run.failures[0])!;
    const r = addBench(ws, core, coreDoc.id, t);
    if ('error' in r) throw new Error(r.error);
    ws = r.ws;
    const doc = ws.chips[r.id];
    expect(ws.open.at(-1)).toBe(r.id);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(new UserLibrary(ws).compiled(r.id)!, doc.pins);
    const m = new Rv16Monitor(es, () => doc, () => ws.chips);
    m.runToHalt(Infinity, 3000);
    return { m, run, t };
  }

  it('a passing core runs a test program to its halt with no mismatch, data and stack in the 64-word RAM', async () => {
    const { m } = await bench('c_core3', 'c_core3', 'calls');
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    expect(m.done).toBe(true);
    const { m: m2 } = await bench('c_core3', 'c_core3', 'table');
    expect(m2.mismatch).toBeNull();
    expect(m2.done).toBe(true);
  });

  it('the failing test of a core without branches stops at a wrong write', async () => {
    const { m, run, t } = await bench('c_core3', 'c_core1');
    expect(run.failures.length).toBeGreaterThan(0);
    expect(run.failures[0].startsWith(`${t.name}: `)).toBe(true);
    expect(m.mismatch).not.toBeNull();
  });

  it('a pipeline test given as words, and a core with an interrupt line', async () => {
    const { m } = await bench('pi_core0', 'pi_core0', 'memory');
    expect(m.mismatch).toBeNull();
    expect(m.done).toBe(true);
    const { m: m2 } = await bench('y_irq', 'y_irq', 'interrupt');
    expect(m2.mismatch).toBeNull();
    expect(m2.done).toBe(true);
  });
});
