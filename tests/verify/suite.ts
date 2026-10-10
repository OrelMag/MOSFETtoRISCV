// The CPU verification suites as Vitest cases, for the CPUs a test file names (the files split the CPUs
// between workers):
//  - the official riscv-tests: every applicable test must pass at gate level, and on the golden model
//    configured like the CPU; one case per lane batch (up to 32 programs);
//  - random programs (seeds 1–32): each CPU's final state must equal the golden model's. A failure names the
//    seed, the first differing state (lock-step replay) and the program. scripts/fuzz32.ts runs more seeds.

import { describe, expect, it } from 'vitest';
import { CPUS, notApplicable } from './cpus';
import { firstDivergence, fuzzCase, fuzzLanes } from './fuzz';
import { images } from './images';
import { cpuJobs, runLanes } from './run';

export function verifyCpus(ids: string[]): void {
  for (const id of ids) {
    const cfg = CPUS.find((c) => c.id === id)!;
    describe(`${cfg.name} (${cfg.id})`, () => {
      const batches = cpuJobs(cfg, images(cfg.env).filter((i) => !notApplicable(cfg, i.name, i.data.length)));
      it('has at least 32 applicable riscv-tests', () => expect(batches.flatMap((b) => b.jobs).length).toBeGreaterThanOrEqual(32));
      for (const batch of batches) {
        const names = batch.jobs.map((j) => j.img.name);
        it(`riscv-tests at gate level: ${names.length} programs, ${names[0]} … ${names[names.length - 1]}`, () => {
          const failed = batch.jobs.filter((j) => !j.golden.pass).map((j) => `${j.img.name} on the golden model: ${j.golden.text}`);
          runLanes(cfg, batch.jobs, batch.imemK, batch.dmemK).forEach((r, i) => { if (!r.pass) failed.push(`${names[i]}: ${r.text}`); });
          expect(failed).toEqual([]);
        }, 300_000);
      }
      it('32 random programs end in the golden model\'s state', () => {
        const cases = Array.from({ length: 32 }, (_, i) => fuzzCase(cfg, i + 1));
        const failed = fuzzLanes(cfg, cases).filter((r) => !r.ok).map((r) => {
          const c = cases.find((x) => x.seed === r.seed)!;
          return `seed ${r.seed}: ${r.diff}\nfirst difference: ${firstDivergence(cfg, c)}\n${c.source}`;
        });
        expect(failed).toEqual([]);
      }, 300_000);
    });
  }
}
