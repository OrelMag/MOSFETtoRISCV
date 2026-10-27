// The sandbox's SAP-1 example: it resolves on a fresh page load, draws without lint warnings, holds its program in the
// RAM chip's 189s across a Reset, runs on EditorSim to its halt with the sample's numbers on OUT and the digits, and the
// CPU drawer's monitor keeps the golden model in lock step every clock (registers, step, RAM, bus), through a program
// loaded into the RAM chip and through programming mode with the DIP switches and the WRITE key.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { SAP_EXAMPLE_PROGRAM, withSapProgram } from '../src/editor/examplesap';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { detectSap, SapMonitor, sapUse } from '../src/editor/sapmon';
import { registry } from '../src/lib/define';
import { regenerable, resolveComponent } from '../src/lib/resolve';
import { ls189With } from '../src/lib/ttl';
import { sapBytes } from '../src/sap/asm';
import { CTRL, displayDigits } from '../src/sap/isa';
import { SapISS } from '../src/sap/iss';
import { SAP_PROGRAMS } from '../src/sap/programs';
import { findNode } from '../src/sim/flatten';
import { pack } from '../src/sim/values';

const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'sap1')!;

/**
 * The example (with another program in its RAM, if given) on an EditorSim, the CPU drawer's monitor on it. `io`: the
 * switch, key and display parts moved before or after every module in the document (a learner who deletes and re-adds
 * one leaves it last).
 */
function open(bytes?: number[], io?: 'first' | 'last') {
  let { ws, id } = addExample(emptyWorkspace(), EX);
  if (io) {
    const top = ws.chips[id], mine = top.parts.filter((p) => p.id.startsWith('io_')), rest = top.parts.filter((p) => !p.id.startsWith('io_'));
    ws = { ...ws, chips: { ...ws.chips, [id]: { ...top, parts: io === 'first' ? [...mine, ...rest] : [...rest, ...mine] } } };
  }
  if (bytes) ws = { ...ws, chips: { ...ws.chips, [`${id}_ram`]: withSapProgram(ws.chips[`${id}_ram`], bytes) } };
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const mon = new SapMonitor(es, () => ws.chips[id], () => ws.chips);
  return { ws, id, lib, es, mon };
}

const rd = (es: EditorSim, path: string, port: string) => pack(es.sim!.getBits(findNode(es.sim!.design.root, path.split('.'))!.ports[port]));
const leaf = (es: EditorSim, path: string) => es.sim!.design.leaves.findIndex((l) => l.node.path.join('.') === path);

/** OUT's values, one per OUT instruction, as the gates show them: watched before each edge whose control word has OI. */
function outsOf(es: EditorSim): number[] {
  const outs: number[] = [];
  let oi = false;
  es.edgeHooks.add({ before: () => { oi = rd(es, 'ctl', 'oi') === 1; }, after: () => { if (oi) outs.push(rd(es, 'out', 'q')); } });
  return outs;
}

describe('the SAP-1 example', () => {
  it('places only parts a fresh page load resolves, and draws without lint warnings', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const lost = Object.values(ws.chips).flatMap((c) => c.parts).flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect(lost).toEqual([]);
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
    // Every pin but the clock became a part; the RAM's 189s hold the sample.
    expect(ws.chips[id].pins.map((p) => p.id)).toEqual(['clk']);
    // the digits side by side, hundreds on the left: they read as a number
    const dig = (k: number) => ws.chips[id].parts.find((p) => p.id === `io_d${k}`)!.at;
    expect([dig(2)[1], dig(1)[1]]).toEqual([dig(0)[1], dig(0)[1]]);
    expect(dig(2)[0] < dig(1)[0] && dig(1)[0] < dig(0)[0]).toBe(true);
    const bytes = sapBytes(SAP_EXAMPLE_PROGRAM.src);
    const ram = ws.chips[`${id}_ram`].parts;
    expect(ram.find((p) => p.id === 'lo')!.ref).toEqual({ lib: ls189With(bytes.map((b) => b & 15)).id });
    expect(ram.find((p) => p.id === 'hi')!.ref).toEqual({ lib: ls189With(bytes.map((b) => b >> 4)).id });
    expect(detectSap(ws.chips[id])).toEqual({ prefix: '' });
    // the library's computer placed whole is one too, its modules a level down
    expect(detectSap({ ...ws.chips[id], parts: [{ id: 'sap', ref: { lib: 'sap1' }, at: [0, 0] }] })).toEqual({ prefix: 'sap.' });
  });

  it('a loaded 74LS189 is rebuilt from its id alone', () => {
    const d = ls189With([1, 2, 3, 15]);
    expect(d.id).toBe('ls189_i123f000000000000');
    expect(resolveComponent(d.id)).toBe(d);
    expect(ls189With([])).toBe(registry.get('ls189'));
  });

  it('runs Fibonacci to its halt: the numbers on OUT and the digits, the cycles of the golden model', () => {
    const { es } = open();
    const outs = outsOf(es);
    es.runCycles(2000, () => es.halted, 1e9);
    expect(es.halted).toBe(true);
    const m = new SapISS(sapBytes(SAP_EXAMPLE_PROGRAM.src));
    expect(m.run()).toEqual(SAP_EXAMPLE_PROGRAM.outs);
    expect(outs).toEqual(SAP_EXAMPLE_PROGRAM.outs);
    expect(es.cycles).toBe(m.cycles);
    const last = SAP_EXAMPLE_PROGRAM.outs.at(-1)!;
    expect(rd(es, 'out', 'q')).toBe(last);
    expect([0, 1, 2].map((k) => rd(es, 'disp', `d${k}`))).toEqual(displayDigits(last));
    // Reset is a power cycle: the program is still there.
    es.reset();
    expect(rd(es, 'ram.lo.mem.w0', 'q')).toBe(sapBytes(SAP_EXAMPLE_PROGRAM.src)[0] & 15);
  });

  it.each(SAP_PROGRAMS.map((p) => [p.id, p] as const))('the CPU drawer\'s monitor on %s: no mismatch to the halt', (_, p) => {
    const { es, mon } = open(sapBytes(p.src));
    const outs = outsOf(es);
    for (let i = 0; i < 10 && !mon.done; i++) es.runCycles(4000, () => mon.done, 1e9);
    expect(mon.mismatch).toBeNull();
    expect(mon.checking).toBe(true);
    expect(mon.iss!.halted).toBe(true);
    expect(outs).toEqual(p.outs);
    expect(mon.retired).toBe(Math.floor(mon.iss!.cycles / 5));
    // the last step logged is HLT's fetch: its T2 is the gated clock
    expect(mon.log.at(-1)!.text).toBe('fetch  T1');
    expect(mon.iss!.ir >> 4).toBe(0xf);
    expect(mon.read()!.ram).toEqual(Array.from(mon.iss!.ram));
  });

  it('steps an instruction at a time, and names the modules a control word uses', () => {
    const { mon } = open();
    expect(mon.stepInstr()).toBe(5);
    expect(mon.read()!.step).toBe(0);
    expect(mon.retired).toBe(1);
    expect(mon.log.map((l) => l.text)).toEqual(['fetch  T0', 'fetch  T1', 'LDA 12  T2', 'LDA 12  T3', 'LDA 12  T4']);
    expect(mon.log[1].effect).toBe('RO II CE: IR ← 1C, PC → 1');
    expect(sapUse(CTRL.co | CTRL.mi).sort()).toEqual(['bus', 'ctl', 'mar', 'pc']);
  });

  it('a hardware state the model disagrees with is a mismatch, named', () => {
    const { es, mon } = open();
    es.runCycles(4);
    mon.iss!.a = 9; // the model now believes A = 9 after LDA's T3
    es.runCycles(1);
    expect(mon.mismatch).toMatchObject({ what: 'a', name: 'A' });
    expect(mon.done).toBe(true);
  });

  it('programming mode: PROG, the DIP switches and W write a program; the model takes over from the hardware', () => {
    const p = SAP_PROGRAMS.find((q) => q.id === 'add')!;
    const bytes = sapBytes(p.src);
    const { es, mon } = open();
    es.pokeLeaf(leaf(es, 'io_prog'), { v: 1 });
    for (let i = 0; i < 16; i++) {
      es.pokeLeaf(leaf(es, 'io_addrSw'), { v: i });
      es.pokeLeaf(leaf(es, 'io_dataSw'), { v: bytes[i] ?? 0 });
      es.setKey('w', true);
      es.setKey('w', false);
    }
    es.runCycles(1);
    expect(mon.programming).toBe(true);
    expect(mon.checking).toBe(false);
    es.pokeLeaf(leaf(es, 'io_prog'), { v: 0 });
    expect(mon.read()!.ram).toEqual([...bytes, ...Array(16 - bytes.length).fill(0)]);
    const outs = outsOf(es);
    es.runCycles(2000, () => mon.done, 1e9);
    expect(mon.mismatch).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(outs).toEqual(p.outs);
  });

  it('RESET: a running program rekeyed by the switches mid-way, RESET, and the new one runs in step to its halt', () => {
    const p = SAP_PROGRAMS.find((q) => q.id === 'mul')!;
    const bytes = sapBytes(p.src);
    const { es, mon } = open();
    es.runCycles(61);
    expect(mon.mismatch).toBeNull();
    expect(mon.checking).toBe(true);
    es.pokeLeaf(leaf(es, 'io_prog'), { v: 1 });
    es.runCycles(3); // the clock keeps running while PROG is on
    expect(mon.programming).toBe(true);
    for (let i = 0; i < 16; i++) {
      es.pokeLeaf(leaf(es, 'io_addrSw'), { v: i });
      es.pokeLeaf(leaf(es, 'io_dataSw'), { v: bytes[i] ?? 0 });
      es.setKey('w', true);
      es.setKey('w', false);
    }
    es.pokeLeaf(leaf(es, 'io_prog'), { v: 0 });
    es.runCycles(2); // PROG off: the model takes the machine as it is, mid-instruction
    expect(mon.checking).toBe(true);
    expect(mon.mismatch).toBeNull();
    es.setKey('e', true);
    expect([rd(es, 'pc.cnt', 'q'), rd(es, 'ctl.step', 'q'), rd(es, 'a.lo', 'q'), rd(es, 'ir.hi', 'q')]).toEqual([0, 0, 0, 0]);
    es.setKey('e', false);
    const outs = outsOf(es);
    es.runCycles(4000, () => mon.done, 1e9);
    expect(mon.mismatch).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(outs).toEqual(p.outs);
    expect(mon.read()!.ram).toEqual(Array.from(mon.iss!.ram));
  });

  it.each(['first', 'last'] as const)('powers on with its program whatever the order of the parts (the switches %s)', (io) => {
    const bytes = sapBytes(SAP_EXAMPLE_PROGRAM.src);
    const { es, mon, ws, id } = open(undefined, io);
    expect(ws.chips[id].parts.at(io === 'first' ? 0 : -1)!.id.startsWith('io_')).toBe(true);
    expect(mon.read()!.ram).toEqual([...bytes, ...Array(16 - bytes.length).fill(0)]);
    es.reset();
    expect(mon.read()!.ram).toEqual([...bytes, ...Array(16 - bytes.length).fill(0)]);
    const outs = outsOf(es);
    es.runCycles(2000, () => mon.done, 1e9);
    expect(mon.mismatch).toBeNull();
    expect(outs).toEqual(SAP_EXAMPLE_PROGRAM.outs);
  });
});
