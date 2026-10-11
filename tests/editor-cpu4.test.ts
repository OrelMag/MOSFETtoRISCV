// The sandbox's 4-bit CPU example: it resolves on a fresh page load, draws without lint warnings,
// runs on EditorSim (cycle engine) to its halt with the result on the digits, and the CPU drawer's
// monitor checks every register against the golden model, following the switches and the TEST key.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { Cpu4Monitor, cpu4Use, detectCpu4 } from '../src/editor/cpu4mon';
import { cpu4Chip } from '../src/editor/example4';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { assemble4 } from '../src/isa4/asm4';
import { Iss4 } from '../src/isa4/iss4';
import { BCD4, SWITCHES4, TEST4 } from '../src/isa4/programs4';
import { CPU4_STATE } from '../src/lib/cpu4';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';
import { findNode } from '../src/sim/flatten';

const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'cpu4')!;

/** The example (with another program, if given) on an EditorSim, the CPU drawer's monitor on it. */
function open(src?: string) {
  let { ws, id } = addExample(emptyWorkspace(), EX);
  if (src) {
    const sub = Object.fromEntries(['pcs', 'dec', 'regs', 'alu', 'acc', 'io'].map((k) => [k, `${id}_${k}`]));
    ws = { ...ws, chips: { ...ws.chips, [id]: cpu4Chip(id, ws.chips[id].name, sub, src) } };
  }
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const mon = new Cpu4Monitor(es, () => ws.chips[id], () => ws.chips);
  return { ws, id, lib, es, mon };
}

const leaf = (es: EditorSim, path: string) => es.sim!.design.leaves.findIndex((l) => l.node.path.join('.') === path);

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

  it('the CPU drawer\'s monitor: detected, checking, every register equal to the model through Run to halt', () => {
    const { ws, id, es, mon } = open();
    expect(detectCpu4(ws.chips[id])).toEqual({ rom: 'rom' });
    expect(mon.checking).toBe(true);
    // As the drawer's Run to halt: frame after frame (the halt part stops each run one step at a time).
    for (let i = 0; i < 10 && !mon.done; i++) mon.runToHalt(1e9);
    expect(mon.mismatch).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(mon.retired).toBe(38);
    expect(es.cycles).toBe(38);
    expect(mon.read()!.ports.slice(0, 4)).toEqual([7, 1, 1, 0]);
    expect(mon.log.at(-1)).toMatchObject({ text: 'JUN  0x25', effect: 'PC → 25' });
    expect(mon.log.find((l) => l.text === 'DAA')!.effect).toBe('A ← 0, CY ← 1');
  });

  it('follows the switches and the TEST key the hardware reads', () => {
    let o = open(SWITCHES4);
    o.es.pokeLeaf(leaf(o.es, 'io_sw'), { v: 6 });
    o.es.runCycles(40);
    expect(o.mon.mismatch).toBeNull();
    expect(o.mon.read()!.ports[4]).toBe(7);
    o = open(TEST4);
    o.es.runCycles(10);
    o.es.setKey(' ', true);
    o.es.runCycles(10);
    o.es.setKey(' ', false);
    o.es.runCycles(10);
    expect(o.mon.mismatch).toBeNull();
    expect(o.mon.read()!.ports[3]).toBe(1);
  });

  it('a hardware state the model disagrees with is a mismatch, named', () => {
    const { es, mon } = open();
    es.runCycles(6);
    mon.iss!.a = 9; // the model now believes A = 9 before ADD R11
    es.runCycles(1);
    expect(mon.mismatch).toMatchObject({ what: 'a', name: 'A', after: 'ADD  R11' });
    expect(mon.done).toBe(true);
  });

  it('marks the blocks an instruction uses', () => {
    expect(cpu4Use(0x8b00).units).toEqual(['rom', 'dec', 'pcs', 'regs', 'alu', 'acc']);
    expect(cpu4Use(0xe200).units).toContain('io');
    expect(cpu4Use(0xea00).units).toContain('io_sw');
  });
});
