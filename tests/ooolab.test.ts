// The out-of-order lab (widgets/ooolab.ts, bench/ooprice.ts): chapter 26's "Your own core" quotes its numbers from
// the model, a shape survives its round trip through the knobs, own programs run, and only gate shapes are priced.

import { describe, expect, it } from 'vitest';
import { chOoo } from '../src/chapters/ch-ooo';
import { compilePy } from '../src/lang/compile';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { geoMean } from '../src/bench/summary';
import { gateShape, priceOf } from '../src/bench/ooprice';
import RESULTS from '../src/bench/results.json';
import { assemble } from '../src/riscv/asm';
import { OOO_CORE, SLOT_CAUSES, type OooConfig } from '../src/riscv/ooomodel';
import { OOO_PROGRAMS } from '../src/riscv/oooprograms';
import { fullShape, LAB_PRESETS, labRun } from '../src/widgets/ooolab';
import { GRID_PROGRAMS, oooProgram } from '../src/widgets/ooo';

const OPTS = { dmemWords: 64, imemWords: 128 };
const SET = GRID_PROGRAMS.map((id) => ({ id, name: id, words: oooProgram(id).words, opts: OPTS }));
const body = chOoo.steps.find((s) => s.title === 'Your own core')!.body.replace(/\s+/g, ' ');
const quoted = (v: string) => expect(body, v).toContain(v);

function onSet(cfg: Partial<OooConfig>) {
  const runs = SET.map((p) => labRun(p, cfg));
  const total = runs.reduce((a, r) => a + SLOT_CAUSES.reduce((b, c) => b + r.stats.slots[c], 0), 0);
  const share = (c: (typeof SLOT_CAUSES)[number]) => ((100 * runs.reduce((a, r) => a + r.stats.slots[c], 0)) / total).toFixed(1);
  return { cpi: geoMean(runs.map((r) => r.stats.cycles / r.stats.instructions)).toFixed(2), share };
}

describe('the out-of-order lab', () => {
  it('chapter 26 quotes its numbers from the model', () => {
    const core = onSet({});
    quoted(`${core.share('retired')} % commit`);
    quoted(`${core.share('mispredict')} % go to mispredictions`);
    quoted(`from ${core.cpi} to ${onSet({ predict: 'perfect' }).cpi}`);
    quoted(`gives ${onSet({ recover: 'resolve' }).cpi}`);
    quoted(`changes nothing (${onSet({ rob: 64, iq: 32, sq: 16 }).cpi})`);
    const wide = onSet({ width: 4, rob: 32, iq: 16, sq: 8 });
    quoted(`reaches ${wide.cpi}`);
    quoted(`take ${wide.share('mispredict')} % of the slots`);
    const slow = onSet({ lat: { alu: 1, load: 20, mul: 2, div: 19 } });
    quoted(`CPI is ${slow.cpi} with ${slow.share('memory')} %`);
    const lo = priceOf({ rob: 8, iq: 4, sq: 2 })!, hi = priceOf({ rob: 32, iq: 16, sq: 8 })!;
    quoted(`(${lo.nands.toLocaleString('en').replace(/,/g, ' ')} NANDs)`);
    quoted(`(${hi.nands.toLocaleString('en').replace(/,/g, ' ')})`);
    quoted(`from ${lo.period} to ${hi.period} NAND delays`);
    quoted(`only brings it to ${onSet({ lat: { alu: 1, load: 20, mul: 2, div: 19 }, rob: 64, iq: 32, sq: 16 }).cpi}`);
  });

  it('a shape keeps its timing written out in full, and every preset runs', () => {
    for (const [, c] of LAB_PRESETS) {
      const a = labRun(SET[0], c).stats, b = labRun(SET[0], fullShape(c)).stats;
      expect(b).toEqual(a);
      expect(fullShape(fullShape(c))).toEqual(fullShape(c));
    }
  });

  it('runs your assembly and your Python to their halt, with the timeline kept', () => {
    const a = assemble(OOO_PROGRAMS.find((p) => p.id === 'chains')!.source);
    const r = labRun({ id: 'asm', name: 'asm', words: a.words, opts: { dmemWords: 1024, imemWords: 128 } }, {}, true);
    expect(r.halted).toBe(true);
    expect(r.lost!.length).toBe(r.stats.cycles);
    const py = compilePy(PY_PROGRAMS.find((p) => p.id === 'primes')!.source, { dmemWords: 1024 });
    expect(py.error).toBeNull();
    const q = labRun({ id: 'py', name: 'py', words: py.words, opts: { dmemWords: 1024, imemWords: 1024 } }, {});
    expect(q.halted).toBe(true);
    expect(q.stats.instructions).toBeGreaterThan(100);
  });

  it('prices only shapes the gate-level core can take', () => {
    expect(priceOf({})).toMatchObject({ nands: RESULTS.cpus.find((c) => c.id === 'ooo')!.nands, period: RESULTS.cpus.find((c) => c.id === 'ooo')!.period });
    expect(priceOf(fullShape({}))).not.toBeNull();
    expect(gateShape({ rob: 8, iq: 4, sq: 2 })).toBe(true);
    for (const rob of [8, 16, 32]) for (const iq of [4, 8, 16]) for (const sq of [2, 4, 8]) expect(priceOf({ rob, iq, sq })).not.toBeNull();
    expect(priceOf({ rob: 64 })).toBeNull();
    for (const c of [{ width: 4 }, { inorder: true }, { predict: 'perfect' as const }, { commit: 1 }, { divider: 'pipelined' as const },
      { lat: { ...OOO_CORE.lat, load: 3 } }, { ports: [['alu', 'branch', 'mem'], ['alu', 'branch', 'mul', 'div'], ['alu']] as OooConfig['ports'] }]) {
      expect(gateShape(c), JSON.stringify(c)).toBe(false);
      expect(priceOf(c)).toBeNull();
    }
  });
});
