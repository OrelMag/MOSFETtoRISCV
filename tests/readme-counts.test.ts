import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCounts, readmeCounts } from '../scripts/readme-counts';
import { gpu31 } from '../src/lib/gfxpipe';
import { XLEN_COSTS } from '../src/lib/xlencosts';
import { meshById } from '../src/riscv/gfxprograms';
import { stats } from '../src/sim/stats';
import results from '../src/bench/results.json';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fmt = (n: number) => n.toLocaleString('en-US');

describe('README.md quotes the code', () => {
  it('every counted number between <!--n:key--> markers is what the code computes (npx vite-node scripts/readme-counts.ts rewrites them)', () => {
    const r = applyCounts(README);
    expect(r.problems, 'unknown marker keys').toEqual([]);
    expect(r.stale).toEqual([]);
    expect(README.match(/<!--n:/g)!.length).toBeGreaterThan(40);
  });

  it('the level counts are the book\'s', () => {
    const c = readmeCounts();
    expect(c['dsp.count']).toBe(16);
    expect(c['dsp.levels']).toBeGreaterThan(0);
    expect(c['comm.last'] + 1).toBe(c['dsp.first']);
    expect(c.journey).toBe(c['dsp.last']);
  });

  it('the cost table\'s CPU rows are the Benchmarks tab\'s (src/bench/results.json) and chapter 25\'s (xlencosts.ts)', () => {
    const list = (results as unknown as { cpus: { id: string; nands: number; period: number }[] }).cpus;
    const cpus = Object.fromEntries(list.map((c) => [c.id, c]));
    const rows: [string, string][] = [
      ['| Single-cycle RV32I |', 'sc'], ['| Single-cycle RV32IC ', 'sc-c'], ['| Five-stage pipelined RV32I |', 'pipe'],
      ['| Pipelined RV32IM, balanced', 'pipe-m-bal-bp'], ['| Dual-issue pipelined RV32IM |', 'pipe-2w'], ['| Out-of-order RV32IM', 'ooo'],
      ['| Dual-core with shared memory', 'dual'],
    ];
    for (const [label, id] of rows) {
      const line = README.split('\n').find((l) => l.startsWith(label));
      expect(line, label).toBeTruthy();
      expect(line, id).toContain(fmt(cpus[id].nands));
      expect(line, id).toContain(`period ${cpus[id].period}`);
    }
    const rv64 = README.split('\n').find((l) => l.startsWith('| Single-cycle RV64IM'))!;
    expect(rv64).toContain(fmt(XLEN_COSTS.rv64im.nands));
    expect(rv64).toContain(`period ${XLEN_COSTS.rv64im.period}`);
    expect(rv64).toContain(`${fmt(XLEN_COSTS.rv32im.nands)}, period ${XLEN_COSTS.rv32im.period}`);
  });

  it('the graphics pipeline row is the gate-level count', () => {
    const s = stats(gpu31(meshById('cube')));
    const line = README.split('\n').find((l) => l.startsWith('| Graphics pipeline'))!;
    expect(line).toContain(fmt(s.nands));
    expect(line).toContain(fmt(s.transistors));
  }, 60_000);
});
