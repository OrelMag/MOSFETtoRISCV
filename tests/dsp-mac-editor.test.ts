// "Open in Sandbox" on the MAC core: the remixed circuit is detected as a MAC core, the CPU drawer's golden model (ISS with the MAC) follows it in
// lock step including the accumulator, and a broken accumulator is reported as a mismatch.
import { describe, expect, it } from 'vitest';
import { CpuMonitor, detectCpu, mismatchText } from '../src/editor/cpu';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type ChipDoc, type Workspace } from '../src/editor/model';
import { romImage } from '../src/editor/memory';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { singleCycleCpu } from '../src/lib';
import '../src/lib/macunit';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import type { ComponentDef } from '../src/sim/types';

const SRC = `
  li t0, 0x12345678
  li t1, 0x0003fffd
  clracc
  mac2 t0, t1
  mac  t0, t1
  li t2, 4
  racc a0, t2
  mac2 t1, t1
  racc a1, zero
  j .
`;

function open(def: ComponentDef): { doc: () => ChipDoc; chips: () => Workspace['chips']; es: EditorSim } {
  const r = remixDef(emptyWorkspace(), def);
  if ('error' in r) throw new Error(r.error);
  const ws = r.ws;
  const es = new EditorSim({ debounceMs: 0 });
  es.update(new UserLibrary(ws).compiled(r.id)!, ws.chips[r.id].pins);
  return { es, doc: () => ws.chips[r.id], chips: () => ws.chips };
}

describe('the sandbox\'s CPU drawer on the MAC core', () => {
  it('is detected, keeps the MAC in the golden model, and follows the accumulator to halt', () => {
    const w = assemble(SRC, [], { mac: true }).words;
    const c = open(singleCycleCpu(w, { mac: true }));
    const d = detectCpu(c.doc(), c.chips())!;
    expect(d.iss.mac).toBe(true);
    expect(d.acc).toBe('macu');
    // the ROM kept the four names: its listing reads mac2, not .word
    const rom = c.doc().parts.find((p) => p.id === 'imem')!.ref as { rom: Parameters<typeof romImage>[0] };
    expect(romImage(rom.rom).lines.some((l) => /^mac2 /.test(l.text))).toBe(true);
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    expect(m.checking).toBe(true);
    while (!m.done && c.es.cycles < 2000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    const g = new ISS(w, { mac: true });
    g.run(1000);
    expect(m.iss!.acc).toBe(g.acc);
    expect(m.read()!.acc).toBe(g.acc);
    expect(m.read()!.x).toEqual([...g.x].map((v) => v >>> 0));
  }, 120000);
  it('a disagreeing accumulator is reported as a mismatch', () => {
    const w = assemble(SRC, [], { mac: true }).words;
    const c = open(singleCycleCpu(w, { mac: true }));
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    m.iss!.acc = 12345n; // the model's accumulator disagrees with the gates from the start
    c.es.runCycles(8);
    expect(m.mismatch).not.toBeNull();
    expect(m.mismatch!.what).toBe('acc');
    expect(mismatchText(m.mismatch!)).toMatch(/acc/);
  }, 120000);
  it('a core without the MAC is detected as before', () => {
    const c = open(singleCycleCpu(assemble('li a0, 1\nj .').words));
    const d = detectCpu(c.doc(), c.chips())!;
    expect(d.iss.mac).toBeUndefined();
    expect(d.acc).toBeUndefined();
  }, 60000);
});
