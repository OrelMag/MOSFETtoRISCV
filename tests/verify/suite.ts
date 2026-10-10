// The official riscv-tests as Vitest cases: every applicable test on each CPU must pass at gate level, and
// on the golden model configured like it. One case per lane batch (up to 32 programs); the files that call
// this split the CPUs between workers.

import { describe, expect, it } from 'vitest';
import { CPUS, notApplicable } from './cpus';
import { images } from './images';
import { cpuJobs, runLanes } from './run';

export function riscvTests(ids: string[]): void {
  describe('official riscv-tests at gate level, 32 programs per run (one per lane)', () => {
    for (const id of ids) {
      const cfg = CPUS.find((c) => c.id === id)!;
      const batches = cpuJobs(cfg, images(cfg.env).filter((i) => !notApplicable(cfg, i.name, i.data.length)));
      batches.forEach((batch, k) => {
        const names = batch.jobs.map((j) => j.img.name);
        it(`${cfg.name} (${cfg.id}): ${names.length} tests, ${names[0]} … ${names[names.length - 1]}`, () => {
          const failed = batch.jobs.filter((j) => !j.golden.pass).map((j) => `${j.img.name} on the golden model: ${j.golden.text}`);
          runLanes(cfg, batch.jobs, batch.imemK, batch.dmemK).forEach((r, i) => { if (!r.pass) failed.push(`${names[i]}: ${r.text}`); });
          expect(failed).toEqual([]);
        }, 300_000);
        if (k === 0) it(`${cfg.name} (${cfg.id}) has at least 32 applicable tests`, () => expect(batches.flatMap((b) => b.jobs).length).toBeGreaterThanOrEqual(32));
      });
    }
  });
}
