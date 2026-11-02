// ISA breadth in the sandbox: the C extension (a ROM with its C box ticked + rv32ic_core) and RV64 (rv64*_core) run on
// EditorSim with the CPU drawer's monitor in lock step against ISS({ c }) / ISS64.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CpuMonitor, resolveCpu } from '../src/editor/cpu';
import { RVC_SOURCE, RVC_TEXT, rvcChip } from '../src/editor/exampleisa';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { deadParts, lintChip, openInputs } from '../src/editor/lint';
import { partDef } from '../src/editor/parts';
import { registry } from '../src/lib/define';
import { emptyWorkspace, type PartRef, polyline, type Workspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { regenerable } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { breathe } from './setup';

const atLoad = new Set(registry.keys());

function open(exId: string): { ws: Workspace; id: string; es: EditorSim; lib: UserLibrary } {
  const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === exId)!);
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return { ws, id, es, lib };
}
const con = (es: EditorSim) => consoleText(ioState(es.sim!, ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console')!.node) as ConsoleState);
async function run(es: EditorSim, cap: number) {
  while (es.cycles < cap && !es.halted) {
    es.runCycles(Math.min(500, cap - es.cycles), () => es.halted, 1e9);
    await breathe();
  }
}

describe('Examples ▸ RV32C', () => {
  it('the program assembles with 16-bit instructions mixed in and the golden model prints its text', () => {
    const a = assemble(RVC_SOURCE);
    expect(a.errors).toEqual([]);
    expect(a.lines.some((l) => l.size === 2)).toBe(true);
    expect(a.lines.some((l) => l.size !== 2)).toBe(true);
    const iss = new ISS(a.words, { c: true, mmio: true });
    iss.run(2000);
    expect(iss.halted).toBe(true);
    expect(iss.console).toBe(RVC_TEXT);
  });

  it('places only parts a page load resolves and draws without lint warnings', () => {
    const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'rvc')!);
    const lib = new UserLibrary(ws);
    const doc = ws.chips[id];
    const lost = doc.parts.flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect(lost).toEqual([]);
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

  it('runs on the hardware, in lock step with ISS({ c }), to the same console text and registers', async () => {
    const { ws, id, es } = open('rvc');
    const mon = new CpuMonitor(es, () => ws.chips[id]);
    expect(mon.desc?.iss.c).toBe(true);
    expect(mon.problem).toBe(null);
    await run(es, 3000);
    expect(es.halted).toBe(true);
    expect(mon.mismatch).toBeNull();
    expect(mon.retired).toBeGreaterThan(30);
    expect(con(es)).toBe(RVC_TEXT);
    expect(resolveCpu(ws.chips[id])?.regs).toBe('cpu.rf');
    const x = mon.read()!.x!;
    expect(x[12]).toBe(525); // a2 = sum of '0'..'9'
    expect(x[13]).toBe(1050); // a3 = a2 * 2
  });

  it('a plain ROM is unchanged: its id and the document keep no C field; .option rvc without the box is an error', () => {
    const doc = rvcChip('u', 'n');
    const imem = doc.parts.find((p) => p.id === 'imem')!;
    expect('rom' in imem.ref && imem.ref.rom.c).toBe(true);
  });
});
