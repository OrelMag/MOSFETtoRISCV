// The chapter "How do you know it works?": every number it quotes is measured again here, and the browser runners it uses
// are held to the CI harness they stand in for (tests/verify).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BIST_PATTERNS, bistPatterns, bistSignature, pipelinedCpu, rca, signatureOf } from '../src/lib';
import { scanCost } from '../src/lib/dft';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { allVectors, coverageCurve, detect, exactCover, faultModel, greedyCover, randomVectors, responses, type FaultModel } from '../src/sim/faultsim';
import { stats } from '../src/sim/stats';
import { VERIFY_FACTS as F } from '../src/chapters/ch-verify';
import { coverProgram, coverRandom, reached } from '../src/verify/coverage';
import { FOUND } from '../src/verify/data';
import { caseOf, firstDivergence, fuzzBatch, fuzzCase, shrink } from '../src/verify/fuzz';
import { FP_PIPE_WITH_BUG, FWD_FAULT, LOCKSTEP_SOURCE, SLT_FAULT, withFault } from '../src/verify/planted';
import { runRv32ui } from '../src/verify/rvtests';
import { CPUS } from './verify/cpus';
import { fuzzCase as ciCase, fuzzLanes } from './verify/fuzz';
import { plantedDef } from '../src/sim/faults';
import { stuckAt, PC_BUG } from '../src/verify/planted';

const model = (m: FaultModel | string): FaultModel => { if (typeof m === 'string') throw new Error(m); return m; };
const noTick = async () => {};

describe('the chapter\'s numbers', () => {
  it('the pipelined CPU: NANDs and flip-flops', () => {
    const cpu = pipelinedCpu(assemble('j .').words);
    expect(stats(cpu).nands).toBe(F.pipeNands);
    expect(scanCost(cpu).flipFlops).toBe(F.pipeFlipFlops);
  });

  it('the 4-bit ripple adder\'s faults, random coverage, greedy and smallest test sets', () => {
    const m = model(faultModel(rca(4))), d = detect(m, allVectors(m));
    expect([m.faults.length, allVectors(m).length]).toEqual([F.rcaFaults, F.rcaVectors]);
    expect(coverageCurve(m, randomVectors(m, 32, 7), [1, 2, 4, 8, 16])).toEqual(F.rcaRandom);
    expect(greedyCover(d, m.faults.length)).toHaveLength(F.rcaGreedy);
    expect(exactCover(d, m.faults.length)).toHaveLength(F.rcaSmallest);
  });

  it('the self-test: the escapes', () => {
    const m = model(faultModel(rca(4))), pats = bistPatterns(4, BIST_PATTERNS), good = bistSignature(4, BIST_PATTERNS), gr = responses(m, pats);
    const esc = m.faults.filter((f) => { const r = responses(m, pats, f); return r.some((x, i) => x !== gr[i]) && signatureOf(r, 5) === good; });
    expect(esc).toHaveLength(F.bistEscapes);
  });

  it('coverage: the Primer sample and 32 random programs', async () => {
    const p = await coverProgram(PROGRAMS.find((q) => q.id === 'primer')!.source);
    expect(reached(p)).toEqual({ instrs: F.primerInstrs, events: F.primerEvents });
    expect(reached(await coverRandom(32))).toEqual({ instrs: F.randomInstrs, events: F.events });
  }, 60000);

  it('the riscv-tests with alu.slt stuck at 0: only slt and slti fail, at their first case whose answer is 1', async () => {
    const r = await runRv32ui((w, i, d) => withFault(pipelinedCpu(w, { imemK: i, dmemK: d }), SLT_FAULT));
    expect(r).toHaveLength(F.rvTests);
    const bad = r.filter((t) => !t.pass);
    expect(bad.map((t) => t.name)).toEqual(F.sltFails);
    expect(bad.every((t) => t.failCase === F.sltCase)).toBe(true);
  }, 120000);

  it('lock step: forwarding from M lost shows at the add, 7 against 14', async () => {
    const cpu = { cpi: 4, build: (w: number[], i: number, d: number) => withFault(pipelinedCpu(w, { imemK: i, dmemK: d }), FWD_FAULT) };
    const d = await firstDivergence(cpu, caseOf(cpu, 0, LOCKSTEP_SOURCE)!, noTick);
    expect(d?.text).toContain('add t1, t0, t0: t1 = 0x00000007, golden 0x0000000e');
  });

  it('random programs on the FP pipeline with its old bug: the failing seeds of the first 64, and seed 3 shrunk', async () => {
    const fails: number[] = [];
    for (const s0 of [1, 33]) fails.push(...(await fuzzBatch(FP_PIPE_WITH_BUG, Array.from({ length: 32 }, (_, i) => s0 + i), noTick)).filter((v) => !v.ok).map((v) => v.seed));
    expect(fails).toEqual(F.fuzzFails64);
    const r = await shrink(FP_PIPE_WITH_BUG, fuzzCase(FP_PIPE_WITH_BUG, 3), noTick);
    expect([r.before, r.after]).toEqual([F.shrinkFrom, F.shrinkTo]);
  }, 180000);
});

describe('the browser runners against CI\'s', () => {
  it('the same verdicts as tests/verify/fuzz.ts on the same seeds', async () => {
    const base = CPUS.find((c) => c.id === 'fppipe')!;
    const ci = { ...base, build: (w: number[], i: number, d: number) => plantedDef(base.build(w, i, d), stuckAt(PC_BUG.path, PC_BUG.port, PC_BUG.bit, PC_BUG.v), 'pcbug_ci') };
    const seeds = Array.from({ length: 32 }, (_, i) => i + 1);
    const want = (await fuzzLanes(ci, seeds.map((s) => ciCase(ci, s)))).map((r) => r.ok);
    const got = (await fuzzBatch(FP_PIPE_WITH_BUG, seeds, noTick)).map((r) => r.ok);
    expect(got).toEqual(want);
    // and the programs are the same programs
    expect(fuzzCase(FP_PIPE_WITH_BUG, 15).source).toBe(ciCase(ci, 15).source);
  }, 120000);

  it('FOUND is docs/VERIFICATION.md\'s "What this found" table', () => {
    const doc = readFileSync('docs/VERIFICATION.md', 'utf8');
    const table = doc.slice(doc.indexOf('## What this found'), doc.indexOf('## What this does not prove'));
    const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Where') && !l.startsWith('|---'));
    expect(rows).toHaveLength(FOUND.length);
    rows.forEach((row, i) => {
      const cells = row.split(' | ').map((c) => c.replace(/^\| |\|$/g, '').replace(/`/g, '').trim());
      expect(cells[0]).toBe(FOUND[i].where);
      expect(cells[2]).toBe(FOUND[i].foundBy);
    });
  });
});
