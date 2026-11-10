// The vector core in the sandbox (rv32iv_core: chapter vectors' CPU with its program on a port): Examples ▸ RVV runs on
// EditorSim with the CPU drawer's monitor in lock step against ISS({ v }), vector registers and vl compared too.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CpuMonitor, readMem } from '../src/editor/cpu';
import { RVV_SOURCE } from '../src/editor/exampleisa';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { deadParts, lintChip, openInputs } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { registry } from '../src/lib/define';
import { regenerable, resolveComponent } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { SAXPY_RESULT } from '../src/riscv/vecprograms';
import { breathe } from './setup';

const atLoad = new Set(registry.keys());

function open(): { ws: Workspace; id: string; es: EditorSim; lib: UserLibrary } {
  const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'rvv')!);
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return { ws, id, es, lib };
}
async function run(es: EditorSim, cap: number) {
  while (es.cycles < cap && !es.halted) {
    es.runCycles(Math.min(200, cap - es.cycles), () => es.halted, 1e9);
    await breathe();
  }
}

describe('Examples ▸ RVV', () => {
  it('rv32iv_core resolves by id, with its program on a port', () => {
    const d = resolveComponent('rv32iv_core')!;
    expect(d.id).toBe('rv32iv_core');
    expect(d.ports.map((p) => p.name)).toEqual(expect.arrayContaining(['clk', 'instr', 'pcOut', 'instrOut', 'retire']));
    expect(d.netlist!().instances.some((i) => i.name === 'imem')).toBe(false);
    expect(assemble(RVV_SOURCE).errors).toEqual([]);
  });

  it('places only parts a page load resolves and draws without lint warnings', () => {
    const { ws, id, lib } = open();
    const doc = ws.chips[id];
    expect(doc.parts.flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []))).toEqual([]);
    const c = lib.compiled(id)!;
    expect(c.diags).toEqual([]);
    const defOf = (p: { ref: PartRef }) => {
      const d = partDef(p.ref, (x) => lib.defOf(x));
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    expect(lintChip(doc, c, polys).diags).toEqual([]);
    expect(deadParts(doc, c)).toEqual([]);
    expect(openInputs(c)).toEqual([]);
  });

  it('runs on the hardware in lock step with ISS({ v }), vector registers included, to y = 3·x + y', async () => {
    const { ws, id, es } = open();
    const mon = new CpuMonitor(es, () => ws.chips[id]);
    expect(mon.desc?.iss.v).toEqual({ vlen: 128, gates: true });
    expect(mon.desc?.vcore).toBe('cpu');
    expect(mon.desc?.dmem).toBe('cpu.dm');
    expect(mon.problem).toBe(null);
    await run(es, 400);
    expect(es.halted).toBe(true);
    expect(mon.mismatch).toBeNull();
    expect(mon.retired).toBe(22); // the chapter's 23 counts the final `j .`, which the halt part stops Run on before it retires
    expect(readMem(es.sim!, 'cpu.dm')!.slice(16, 32)).toEqual(SAXPY_RESULT);
  }, 60_000);

  it('a vector register that differs from the model is reported', async () => {
    const { ws, id, es } = open();
    const mon = new CpuMonitor(es, () => ws.chips[id]);
    // run to the first vid.v's retirement, then corrupt the model's v8: the next compare must catch it
    await run(es, 8);
    expect(mon.mismatch).toBeNull();
    mon.iss!.vregs[16 * 8] ^= 1;
    await run(es, 20);
    expect(mon.mismatch?.what).toMatch(/^v\d+$/);
  }, 60_000);
});
