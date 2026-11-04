// Examples ▸ Two computers: two RV32I bus cores with a UART each, joined by two line parts. Compiled from its
// document it draws without lint warnings, resolves from names alone, runs on the cycle engine and the consoles
// say what the programs do; noise on the wire corrupts a byte; the CPU drawer stands aside; the FPGA export names
// the line honestly.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { resolveCpu } from '../src/editor/cpu';
import { PING_SOURCE, PONG_SOURCE, TWO_ROUNDS } from '../src/editor/examplecomms';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { fpgaExport } from '../src/editor/fpga';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { deadParts, lintChip, openInputs } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import type { DualSim } from '../src/sim/dualsim';
import { breathe } from './setup';

const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'twocomputers')!;

function open() {
  const { ws, id } = addExample(emptyWorkspace(), EX);
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return { ws, id, lib, es };
}

/** Both consoles' text, A first, found by instance name. */
const cons = (es: EditorSim): [string, string] => {
  const root = es.sim!.design.root;
  const text = (name: string) => {
    const n = ioNodes(root).find((x) => x.info.kind === 'console' && x.node.path[x.node.path.length - 1] === name)!;
    return consoleText(ioState(es.sim!, n.node) as ConsoleState);
  };
  return [text('conA'), text('conB')];
};

async function run(es: EditorSim, cycles: number, stop = () => false) {
  const end = es.cycles + cycles;
  while (es.cycles < end && !stop()) { es.runCycles(Math.min(500, end - es.cycles), () => false, 1e9); await breathe(); }
}

describe('Examples ▸ Two computers', () => {
  it('assembles both programs into the boot ROMs', () => {
    for (const src of [PING_SOURCE, PONG_SOURCE]) {
      const a = assemble(src);
      expect(a.errors).toEqual([]);
      expect(a.words.length).toBeLessThanOrEqual(128);
    }
  });

  it('places only parts a fresh page load resolves, and draws without lint warnings', () => {
    const { ws, id, lib } = open();
    for (const doc of Object.values(ws.chips)) {
      const lost = doc.parts.flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
      expect(lost).toEqual([]);
      const c = lib.compiled(doc.id)!;
      expect(c.diags).toEqual([]);
      const defOf = (p: { ref: PartRef }) => {
        const d = partDef(p.ref, (x) => lib.defOf(x));
        return !d || 'error' in d ? undefined : d;
      };
      const polys = new Map(doc.wires.flatMap((w) => { const q = polyline(doc, w, defOf); return q ? [[w.id, q] as const] : []; }));
      expect(lintChip(doc, c, polys).diags).toEqual([]);
      expect(deadParts(doc, c)).toEqual([]);
      expect(openInputs(c)).toEqual([]);
    }
    expect(ws.chips[id].parts.filter((p) => 'lib' in p.ref && /^line\d+$/.test(p.ref.lib)).length).toBe(2);
  });

  it('is not taken for a CPU the drawer can follow (the cores\' memory is behind a bus)', () => {
    const { ws, id } = open();
    expect(resolveCpu(ws.chips[id], ws.chips)).toBeNull();
  });

  it('A pings, B answers pong, three times, on the cycle engine', async () => {
    const { es } = open();
    expect(es.sim).toBeTruthy();
    const pongs = 'pong\n'.repeat(TWO_ROUNDS);
    await run(es, 12000, () => cons(es)[0] === pongs);
    expect(cons(es)).toEqual([pongs, 'ping\n'.repeat(TWO_ROUNDS)]);
    expect((es.sim as DualSim).engine).toBe('cycle');
  }, 60000);

  it('noise on the wire while a byte is in flight corrupts it', async () => {
    const { es, ws, id } = open();
    const pin = ws.chips[id].pins.find((p) => p.name === 'noiseAB')!;
    // hold NOISE A→B over A's first bytes: a held noise input flips every bit at every edge, so B hears garbage or nothing
    es.setInput(pin, 1);
    await run(es, 600);
    es.setInput(pin, 0);
    await run(es, 8000);
    expect(cons(es)[1]).not.toBe('ping\n'.repeat(TWO_ROUNDS));
    expect(cons(es)[1]).not.toMatch(/^ping/);
  }, 60000);

  it('the FPGA export turns each line into ports and says the line is a model', () => {
    const { lib, id } = open();
    const x = fpgaExport(lib.compiled(id)!.def, 'two');
    expect(x.ok).toBe(true);
    const lineIssue = x.issues.find((i) => /line/i.test(i.text) && /model/i.test(i.text));
    expect(lineIssue?.text).toMatch(/not transistors|not hardware/);
    expect(x.plan && x.files.find((f) => f.name === 'two.v')!.text).toMatch(/x_ab_d|x_ba_d/);
  });
});
