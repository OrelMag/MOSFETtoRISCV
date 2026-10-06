import { describe, expect, it } from 'vitest';
import { fpDiv, fpPrenorm, fpSqrt, iterControl, sqrtStep } from '../src/lib';
import { BitSim, LANES, evalMany } from '../src/sim/bitsim';
import { F32, FLAG, RM, fpDivX, fpSqrtX, type FpFormat } from '../src/sim/fpref';
import { flatten } from '../src/sim/flatten';
import { simulate } from '../src/sim/harness';
import { stats, logicDepth } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';

const MODES = [0, 1, 2, 3, 4, 7];

function checkComb(def: ComponentDef, vectors: number[][]): void {
  const got = evalMany(new BitSim(flatten(def)), vectors);
  vectors.forEach((v, i) => { const want = def.spec!(v); if (got[i].some((g, k) => g !== want[k])) expect(got[i], `${def.id}(${v})`).toEqual(want); });
}

/**
 * Run an iterative unit on many operand sets, 32 at a time in lock-step: start, n + 1 clock edges
 * until done, read the result, one more edge to go idle. `ins` gives the data inputs per vector.
 */
function runIter(def: ComponentDef, n: number, vectors: Record<string, number>[], ref: (v: Record<string, number>) => { y: number; fl: number }): void {
  const sim = new BitSim(flatten(def));
  sim.setInput('start', 1);
  for (let at = 0; at < vectors.length; at += LANES) {
    const batch = vectors.slice(at, at + LANES);
    for (const k of Object.keys(batch[0])) sim.setInput(k, batch.map((v) => v[k]));
    for (let c = 0; c <= n; c++) {
      expect(sim.get('done', batch.length).every((d) => d === 0), `done early, cycle ${c}`).toBe(true);
      sim.cycle();
    }
    const done = sim.get('done', batch.length), y = sim.get('y', batch.length), fl = sim.get('flags', batch.length);
    batch.forEach((v, l) => {
      const want = ref(v);
      if (done[l] !== 1 || y[l] !== want.y || fl[l] !== want.fl) expect({ done: done[l], y: y[l], fl: fl[l] }, `${def.id} ${JSON.stringify(v)}`).toEqual({ done: 1, ...want });
    });
    sim.cycle(); // the done edge: busy clears
  }
}

describe('building blocks of the iterative units', () => {
  it('square-root step, prenormalize', () => {
    const v: number[][] = [];
    for (let r = 0; r < 32; r++) for (let x = 0; x < 4; x++) for (let q = 0; q < 16; q++) v.push([r, x, q]);
    checkComb(sqrtStep(4), v);
    for (const f of [{ E: 4, M: 3 }, { E: 3, M: 2 }, { E: 4, M: 4 }]) {
      const w: number[][] = [];
      for (let m = 0; m < 2 ** (f.M + 1); m++) for (let e = 0; e < 2 ** f.E; e++) w.push([m, e]);
      checkComb(fpPrenorm(f), w);
    }
  });
  it('iteration control: load, n steps, done for one cycle', () => {
    const s = simulate(iterControl(5));
    const out = (p: string) => pack(s.getBits(s.design.root.ports[p]));
    const tick = () => { s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); };
    s.setInput('start', 1); s.settle();
    const trace: string[] = [];
    for (let c = 0; c < 9; c++) { trace.push(`${out('load')}${out('busy')}${out('done')}`); tick(); }
    // cycle 0 loads; busy for cycles 1-6; done in cycle 6 (5 steps); idle in 7 loads again
    expect(trace).toEqual(['100', '010', '010', '010', '010', '010', '011', '100', '010']);
  });
});

const small: FpFormat[] = [{ E: 4, M: 3 }, { E: 3, M: 2 }, { E: 5, M: 2 }];
describe('small-format division and square root, exhaustively in every rounding mode', () => {
  for (const f of small) {
    it(`E${f.E}M${f.M}`, () => {
      const N = 2 ** (1 + f.E + f.M);
      const dv: Record<string, number>[] = [], sq: Record<string, number>[] = [];
      for (const rm of MODES) for (let a = 0; a < N; a++) {
        sq.push({ a, rm });
        for (let b = 0; b < N; b++) dv.push({ a, b, rm });
      }
      runIter(fpDiv(f), f.M + 4, dv, (v) => fpDivX(v.a, v.b, f, v.rm));
      runIter(fpSqrt(f), f.M + 3, sq, (v) => fpSqrtX(v.a, f, v.rm));
    }, 120000);
  }
});

describe('float32 division and square root', () => {
  let seed = 9;
  const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  const special = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 1, 0x807fffff, 0x00800000, 0x7f7fffff, 0x3f800000, 0xbf800000, 0x40400000, 0x40000000];
  const pick = () => (r() % 5 === 0 ? special[r() % special.length] : ((r() >>> 8) | ((r() & 0xff) << 24)) >>> 0);
  it('random and special operands in every mode, against the exact reference', () => {
    const dv = Array.from({ length: 640 }, () => ({ a: pick(), b: pick(), rm: r() % 5 }));
    const sq = Array.from({ length: 640 }, (_, i) => ({ a: i % 2 ? pick() & 0x7fffffff : pick(), rm: r() % 5 }));
    runIter(fpDiv(F32), 27, dv, (v) => fpDivX(v.a, v.b, F32, v.rm));
    runIter(fpSqrt(F32), 26, sq, (v) => fpSqrtX(v.a, F32, v.rm));
  }, 120000);
  it('the event-driven simulator agrees: 1 / 3 and √2 in 29 and 28 cycles', () => {
    for (const [def, ins, n, want] of [
      [fpDiv(F32), { a: 0x3f800000, b: 0x40400000, rm: RM.RNE }, 27, { y: 0x3eaaaaab, fl: FLAG.NX }],
      [fpSqrt(F32), { a: 0x40000000, rm: RM.RTZ }, 26, { y: 0x3fb504f3, fl: FLAG.NX }],
    ] as const) {
      const s = simulate(def);
      const out = (p: string) => pack(s.getBits(s.design.root.ports[p]));
      for (const [k, v] of Object.entries(ins)) s.setInput(k, v);
      s.setInput('start', 1); s.settle();
      let c = 0;
      while (!out('done')) { s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); c++; }
      expect(c).toBe(n + 1);
      expect({ y: out('y'), fl: out('flags') }).toEqual(want);
    }
  });
  it('cost and depth', () => {
    for (const d of [fpDiv(F32), fpSqrt(F32), fpPrenorm(F32), iterControl(27)]) console.log(d.id, stats(d).nands, logicDepth(d));
  });
});
