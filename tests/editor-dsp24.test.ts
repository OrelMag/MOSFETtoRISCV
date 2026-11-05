// The sandbox's DSP core example: it resolves on a fresh page load, draws without lint warnings, runs on EditorSim (cycle
// engine) to its halt, and the CPU drawer's monitor checks every register against the golden model through the whole
// FIR 16 run, with the 32 output words equal to the oracle's.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BENCH24 } from '../src/dsp/programs24';
import { assemble24 } from '../src/dsp/asm24';
import { detectDsp24, Dsp24Monitor, dsp24Program, dsp24Use } from '../src/editor/dsp24mon';
import { dspChip } from '../src/editor/exampledsp';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';

const VEC = JSON.parse(readFileSync(new URL('./dsp/vectors/dspcore.json', import.meta.url), 'utf8'));
const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'dsp-core')!;

/** The example on an EditorSim, the CPU drawer's monitor on it. */
function open(id0 = 'dsp-core', src?: string) {
  const ex = EXAMPLES.find((e) => e.id === id0)!;
  let { ws, id } = addExample(emptyWorkspace(), ex);
  if (src !== undefined) {
    const doc = ws.chips[id];
    ws = { ...ws, chips: { ...ws.chips, [id]: { ...doc, parts: doc.parts.map((p) => ('rom' in p.ref ? { ...p, ref: { rom: { ...p.ref.rom, src } } } : p)) } } };
  }
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const mon = new Dsp24Monitor(es, () => ws.chips[id], () => ws.chips);
  return { ws, id, lib, es, mon };
}

describe('the DSP core example', () => {
  it('places only parts a fresh page load resolves, and draws without lint warnings', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const lost = Object.values(ws.chips).flatMap((c) => c.parts).flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect(lost).toEqual([]);
    const c = lib.compiled(id)!;
    expect(c.diags).toEqual([]);
    const doc = ws.chips[id];
    const defOf = (p: { ref: PartRef }) => {
      const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    expect(lintChip(doc, c, polys).diags).toEqual([]);
    expect(doc.pins.map((p) => p.id)).toEqual(['clk']);
    expect(doc.parts.find((p) => p.id === 'rom')!.ref).toMatchObject({ rom: { k: 8, w: 24, lang: 'dsp24', addr: 'word' } });
    // the memories start with the benchmark's images
    expect(doc.parts.find((p) => p.id === 'xram')!.ref).toMatchObject({ ram: { k: 8, w: 16, init: BENCH24[0].x } });
  });

  it('is found by the CPU drawer, which follows its ROM and its memories', () => {
    const { ws, id, mon } = open();
    expect(detectDsp24(ws.chips[id])).toEqual({ rom: 'rom', core: 'core', rams: ['xram', 'yram'] });
    expect(mon.checking).toBe(true);
    expect(mon.xram).toBe('xram');
    expect(mon.yram).toBe('yram');
    expect(dsp24Program(ws.chips[id], 'rom')).toEqual(Array.from({ length: 256 }, (_, i) => assemble24(BENCH24[0].src).words[i] ?? 0));
    expect(mon.problem).toBeNull();
    expect(mon.mem(0)).toEqual(BENCH24[0].x);
  });

  it('the monitor in lock step through the whole FIR 16 run: no mismatch, the 32 outputs as the oracle has them', () => {
    const { es, mon } = open();
    for (let i = 0; i < 400 && !mon.done; i++) mon.runToHalt(1e9);
    expect(mon.mismatch).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(es.engine).toBe('cycle');
    expect(mon.retired).toBe(mon.iss!.steps);
    expect(es.cycles).toBeGreaterThanOrEqual(742); // src/bench/dspcore.json: 742 cycles to the halt
    expect(mon.outs.map((v) => (v ^ 0x8000) - 0x8000)).toEqual(VEC.fir16.y);
    expect(mon.outs).toEqual(mon.iss!.out);
    expect(mon.memoryMismatch()).toBeNull();
    // after the halt the PC holds, and the last word sent shows in the register
    expect(es.halted).toBe(true);
    expect(mon.read()!.la).toBe(0);
  });

  it('runs on a clock of its own: the hex display holds the last word out sent', () => {
    const { es, mon } = open();
    es.runCycles(3000, () => es.halted, 1e9);
    expect(es.halted).toBe(true);
    expect(mon.mismatch).toBeNull();
    const last = es.sim!.design.root.children!.get('last')!;
    expect(es.sim!.getBits(last.ports.q).reduce<number>((v, b, i) => v | ((b === 1 ? 1 : 0) << i), 0)).toBe(VEC.fir16.y.at(-1) & 0xffff);
  });

  it('a state the model disagrees with is a mismatch, named', () => {
    const { es, mon } = open();
    es.runCycles(8);
    mon.iss!.r[1] = 0x1234; // the model now believes r1 holds something else
    es.runCycles(1);
    expect(mon.mismatch).toMatchObject({ what: 'r1', name: 'r1', expected: 0x1234 });
    expect(mon.done).toBe(true);
  });

  it('a store lands in the X memory, and the memory check names a word that differs', () => {
    const src = 'ldi r1, 77\nldi p0, 5\nst x(p0), r1\nhalt\n';
    const { es, mon } = open('dsp-core', src);
    es.runCycles(3);
    expect(mon.mismatch).toBeNull();
    expect(mon.mem(0)![5]).toBe(77);
    expect(mon.memoryMismatch()).toBeNull();
    mon.iss!.x[5] = 99; // the model now disagrees with the memory
    expect(mon.memoryMismatch()).toBe('X[5] is 004D, expected 0063');
  });

  it('marks the units an instruction goes through', () => {
    const w = (s: string) => assemble24(s).words[0];
    expect(dsp24Use(w('mac x(p0)+, y(p4)+')).units).toEqual(['dec', 'seq', 'aguX', 'aguY', 'mac']);
    expect(dsp24Use(w('mac x(p0)+, y(p4)+')).mems).toEqual(['x', 'y']);
    expect(dsp24Use(w('add r1, r2, r3')).units).toEqual(['dec', 'seq', 'regs', 'alu']);
    expect(dsp24Use(w('halt')).units).toEqual(['dec', 'seq']);
  });

  it('every benchmark example builds and runs to its halt with the monitor satisfied', () => {
    for (const b of BENCH24.filter((x) => x.id === 'dot' || x.id === 'biquad')) {
      const { es, mon } = open(`dsp-core-${b.id}`);
      for (let i = 0; i < 400 && !mon.done; i++) mon.runToHalt(1e9);
      expect(mon.mismatch, b.id).toBeNull();
      expect(mon.iss!.halted, b.id).toBe(true);
      expect(mon.outs.length, b.id).toBe(b.outs);
      expect(mon.memoryMismatch(), b.id).toBeNull();
      void es;
    }
    expect(dspChip('x', 'y').parts.length).toBe(7);
  });
});
