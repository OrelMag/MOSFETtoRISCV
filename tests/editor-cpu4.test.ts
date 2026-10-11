// The sandbox's 4-bit CPU example: it resolves on a fresh page load, draws without lint warnings,
// and runs on EditorSim (cycle engine) to its halt with the result on the digits, every register
// equal to the golden model's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';
import { CPU4_STATE } from '../src/lib/cpu4';
import { assemble4 } from '../src/isa4/asm4';
import { Iss4 } from '../src/isa4/iss4';
import { BCD4 } from '../src/isa4/programs4';
import { findNode } from '../src/sim/flatten';

const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'cpu4')!;

function open() {
  const { ws, id } = addExample(emptyWorkspace(), EX);
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return { ws, id, lib, es };
}

/** A register's value through the example's hierarchy (a dotted path to a part with a q port). */
function reg(es: EditorSim, path: string): number {
  const n = findNode(es.sim!.design.root, path.split('.'));
  if (!n) throw new Error(`no ${path}`);
  return es.sim!.getBits(n.ports.q).reduce<number>((v, b, i) => v | ((b === 1 ? 1 : 0) << i), 0);
}

describe('the 4-bit CPU example', () => {
  it('places only parts a fresh page load resolves, and draws without lint warnings', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const lost = Object.values(ws.chips).flatMap((c) => c.parts).flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect(lost).toEqual([]);
    expect(Object.keys(ws.chips).filter((k) => k.startsWith(id)).sort()).toEqual([id, ...['acc', 'alu', 'dec', 'io', 'pcs', 'regs'].map((k) => `${id}_${k}`)].sort());
    for (const [cid, doc] of Object.entries(ws.chips)) {
      const c = lib.compiled(cid)!;
      expect(c.diags, cid).toEqual([]);
      const defOf = (p: { ref: PartRef }) => {
        const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
        return !d || 'error' in d ? undefined : d;
      };
      const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
      expect(lintChip(doc, c, polys).diags, cid).toEqual([]);
    }
    // The pins became parts: only the clock is left.
    expect(ws.chips[id].pins.map((p) => p.id)).toEqual(['clk']);
    expect(ws.chips[id].parts.find((p) => p.id === 'rom')!.ref).toMatchObject({ rom: { k: 8, w: 16, lang: 'cpu4' } });
  });

  it('runs the BCD sample to its halt on the cycle engine: 7110 on the digits, every register as the model has it', () => {
    const { es } = open();
    es.runCycles(200, () => es.halted, 1e9);
    expect(es.engine).toBe('cycle');
    expect(es.halted).toBe(true);
    const iss = new Iss4(assemble4(BCD4).words);
    iss.run();
    const S = CPU4_STATE;
    expect(S.ports.map((p) => reg(es, p))).toEqual([...iss.ports]);
    expect(S.regs.map((p) => reg(es, p))).toEqual([...iss.r]);
    expect([reg(es, S.pc), reg(es, S.a), reg(es, S.cy), reg(es, S.src)]).toEqual([iss.pc, iss.a, iss.cy, iss.src]);
    // Run stops once the halt part reads 1: the JUN to itself is fetched, not yet executed.
    expect(es.cycles).toBe(iss.steps - 1);
  });
});
