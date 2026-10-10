// The CPU verification suites as Vitest cases, for the CPUs a test file names (the files split the CPUs
// between workers):
//  - the official riscv-tests: every applicable test must pass at gate level, and on the golden model
//    configured like the CPU; one case per lane batch (up to 32 programs);
//  - random programs (seeds 1–32): each CPU's final state must equal the golden model's. A failure names the
//    seed, the first differing state (lock-step replay) and the program. scripts/fuzz32.ts runs more seeds;
//  - coverage of the two: every instruction the CPU claims executed, every hardware event it has seen
//    (scripts/coverage.ts prints the counts). A gap means a suite lost its reach: add a directed test.

import { describe, expect, it } from 'vitest';
import type { FlatDesign } from '../../src/sim/flatten';
import { HwCoverage, IsaCoverage, isaInstrs } from './coverage';
import { CPUS, notApplicable } from './cpus';
import { firstDivergence, fuzzCase, fuzzLanes } from './fuzz';
import { images } from './images';
import { cpuJobs, runLanes } from './run';

export function verifyCpus(ids: string[]): void {
  for (const id of ids) {
    const cfg = CPUS.find((c) => c.id === id)!;
    describe(`${cfg.name} (${cfg.id})`, () => {
      const isa = new IsaCoverage(), hw: HwCoverage[] = [];
      const probe = (d: FlatDesign) => { const p = new HwCoverage(d); hw.push(p); return p; };
      let runs = 0;
      const batches = cpuJobs(cfg, images(cfg.env).filter((i) => !notApplicable(cfg, i.name, i.data.length)), isa);
      it('has at least 32 applicable riscv-tests', () => expect(batches.flatMap((b) => b.jobs).length).toBeGreaterThanOrEqual(32));
      for (const batch of batches) {
        const names = batch.jobs.map((j) => j.img.name);
        it(`riscv-tests at gate level: ${names.length} programs, ${names[0]} … ${names[names.length - 1]}`, async () => {
          const failed = batch.jobs.filter((j) => !j.golden.pass).map((j) => `${j.img.name} on the golden model: ${j.golden.text}`);
          (await runLanes(cfg, batch.jobs, batch.imemK, batch.dmemK, probe)).forEach((r, i) => { if (!r.pass) failed.push(`${names[i]}: ${r.text}`); });
          runs++;
          expect(failed).toEqual([]);
        }, 300_000);
      }
      it('32 random programs end in the golden model\'s state', async () => {
        const cases = Array.from({ length: 32 }, (_, i) => fuzzCase(cfg, i + 1, 60, isa));
        const failed: string[] = [];
        for (const r of (await fuzzLanes(cfg, cases, probe)).filter((x) => !x.ok)) {
          const c = cases.find((x) => x.seed === r.seed)!;
          failed.push(`seed ${r.seed}: ${r.diff}\nfirst difference: ${await firstDivergence(cfg, c)}\n${c.source}`);
        }
        runs++;
        expect(failed).toEqual([]);
      }, 300_000);
      it('the suites execute every instruction and cause every hardware event', (ctx) => {
        if (runs < batches.length + 1) ctx.skip(); // a filtered run: the coverage is partial
        expect(isaInstrs(cfg.isa).filter((n) => !isa.instrs.has(n)), 'instructions never executed').toEqual([]);
        const total = new Map<string, number>();
        for (const p of hw) for (const [k, v] of p.counts) total.set(k, (total.get(k) ?? 0) + v);
        expect([...total].filter(([, v]) => v === 0).map(([k]) => k), 'hardware events never seen').toEqual([]);
      });
    });
  }
}
