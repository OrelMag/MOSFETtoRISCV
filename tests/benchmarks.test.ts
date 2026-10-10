// The benchmark set: each program's result on the golden model against the one computed in TypeScript, the
// saved results (src/bench/results.json, from scripts/benchmarks.ts --write) fresh and complete, and one CPU
// measured again against its saved row.

import { describe, expect, it } from 'vitest';
import results from '../src/bench/results.json';
import { BENCHMARKS, crc32, xorshift32 } from '../src/riscv/benchprograms';
import { BENCH_DMEM_K, BENCH_IMEM_K, benchCase, benchCases, benchLanes, measureCpu, programsHash, runsOn } from './verify/bench';
import { CPUS } from './verify/cpus';

describe('benchmark programs', () => {
  it('compute what TypeScript computes, on the golden model', () => {
    const full = CPUS.find((c) => c.id === 'sc-f')!, m = CPUS.find((c) => c.id === 'pipe-m')!;
    for (const b of BENCHMARKS) {
      const c = benchCase(b, b.needs?.m ? m : full);
      for (const [i, v] of b.expect()) expect(c.golden.dmem[i] >>> 0, `${b.id}: word ${i}`).toBe(v >>> 0);
      expect(c.instructions, b.id).toBeGreaterThan(500);
    }
  });

  it('have independent reference helpers', () => {
    // zlib.crc32('12345678'), as little-endian words
    const bytes = [...'12345678'].map((ch) => ch.charCodeAt(0));
    expect(crc32([0, 4].map((i) => bytes.slice(i, i + 4).reduce((a, b, k) => a + b * 2 ** (8 * k), 0)))).toBe(0x9ae0daaf);
    // Marsaglia's xorshift32 from 1: 1 ^ 1 << 13 = 8193, ^ 8193 >> 17 = 8193, ^ 8193 << 5 = 270369
    expect(xorshift32(1, 1)[0]).toBe(270369);
  });

  it('park every hart but hart 0 on the multi-core', () => {
    const dual = CPUS.find((c) => c.isa.mp)!;
    const c = benchCase(BENCHMARKS[0], dual);
    expect(c.golden.x).toHaveLength(2);
    expect(c.golden.dmem[0]).toBe(144);
  });
});

describe('saved benchmark results', () => {
  it('match the programs and cover every CPU and every program it can run', () => {
    expect(results.programs, 'a program changed: run scripts/benchmarks.ts --write').toBe(programsHash());
    expect(results.imemWords).toBe(2 ** BENCH_IMEM_K);
    expect(results.dmemWords).toBe(2 ** BENCH_DMEM_K);
    expect(results.cpus.map((c) => c.id)).toEqual(CPUS.map((c) => c.id));
    for (const cfg of CPUS) {
      const row = results.cpus.find((c) => c.id === cfg.id)!;
      expect(row.runs.map((r) => r.bench), cfg.id).toEqual(BENCHMARKS.filter((b) => runsOn(b, cfg)).map((b) => b.id));
    }
  });

  it('are what the single-cycle CPU measures today', async () => {
    const cfg = CPUS.find((c) => c.id === 'sc')!;
    const cases = benchCases(cfg);
    const row = results.cpus.find((c) => c.id === 'sc')!;
    expect(measureCpu(cfg.build(cases[0].words, BENCH_IMEM_K, BENCH_DMEM_K))).toEqual({ nands: row.nands, period: row.period });
    const runs = await benchLanes(cfg, cases);
    for (const r of runs) expect(r.diff, r.bench).toBe('');
    expect(runs.map(({ diff: _, ...r }) => r)).toEqual(row.runs);
  }, 120_000);
});
