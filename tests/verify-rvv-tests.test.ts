// chipsalliance/riscv-vector-tests (tests/verify/rvvtests.ts, built by scripts/rvv-tests/build.mjs) for our Zve32x
// subset at VLEN 128: every test as generated on the golden model; the copy narrowed for the gate-level unit on the
// golden model (full and gate subset, where no vector instruction may be an illegal no-op) and, one test per
// instruction, on the gate-level single-cycle CPU with the vector unit (sc-v) on BitSim lanes. What the gates cannot
// run is listed in v128-gates.json's notApplicable with the reason.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadable } from '../src/riscv/rvimage';
import { tick } from './yieldtick';
import { CPUS, EXTRA_CPUS } from './verify/cpus';
import { cpuJobs, runLanes } from './verify/run';
import { instrOf, runRvv, RVV_SUBSET, rvvSuite, type RvvImage } from './verify/rvvtests';

const full = rvvSuite('v128'), gates = rvvSuite('v128-gates');
const byInstr = (names: string[]) => {
  const m = new Map<string, string[]>();
  for (const n of names) m.set(instrOf(n), [...(m.get(instrOf(n)) ?? []), n]);
  return m;
};

describe('riscv-vector-tests: the suite', () => {
  it('is the generator revision the workflow pins', () => {
    const yml = readFileSync(new URL('../.github/workflows/rvv-tests.yml', import.meta.url), 'utf8');
    for (const f of [full, gates]) {
      expect(f.index.revision['riscv-vector-tests']).toBe(/RVT_REV: (\w+)/.exec(yml)![1]);
      expect(f.index.revision.spike).toBe(/SPIKE_REV: (\w+)/.exec(yml)![1]);
    }
  });
  it('has tests of every instruction in our subset, and of no other', () => {
    expect([...byInstr(full.names).keys()].sort()).toEqual([...RVV_SUBSET].sort());
  });
  it('every test checks something', () => {
    for (const f of [full, gates]) for (const [n, t] of Object.entries(f.index.tests)) expect(t.cases, n).toBeGreaterThan(0);
  });
  it('every test has a gate copy or a reason it has none', () => {
    const na = gates.index.notApplicable ?? {};
    for (const n of full.names) expect(n in gates.index.tests !== n in na, n).toBe(true);
    expect(gates.names.every((n) => full.names.includes(n))).toBe(true);
    for (const [n, why] of Object.entries(na)) expect(why.length, n).toBeGreaterThan(10);
  });
});

describe('riscv-vector-tests on the golden model, as generated', () => {
  for (const [instr, names] of byInstr(full.names)) {
    it(`${instr}: ${names.length} tests`, async () => {
      const failed: string[] = [];
      for (const n of names) {
        const r = runRvv(full.image(n), false);
        if (!r.pass) failed.push(`${n}: ${r.text}`);
        await tick();
      }
      expect(failed).toEqual([]);
    }, 120_000);
  }
});

describe('riscv-vector-tests, the gate copies on the golden model', () => {
  for (const [instr, names] of byInstr(gates.names)) {
    it(`${instr}: ${names.length} tests, full and gate subset`, async () => {
      const failed: string[] = [];
      for (const n of names) {
        const img = gates.image(n);
        for (const g of [false, true]) {
          const r = runRvv(img, g);
          if (!r.pass) failed.push(`${n} (${g ? 'gate subset' : 'full'}): ${r.text}`);
          if (g && r.illegal) failed.push(`${n}: ${r.illegal} vector instructions were illegal no-ops`);
        }
        await tick();
      }
      expect(failed).toEqual([]);
    }, 120_000);
  }
});

// A word an unmasked vadd.vv check reads (the destination's old value, which vl = 0 leaves in place): flipped, test 38
// must fail on the golden model and on the gates, so a harness that passes everything is caught.
const FAULT = { test: 'vadd_vv-3', word: 516, fails: 'fails test 38' };
const faulty = (img: RvvImage): RvvImage => ({ ...img, name: `${img.name} (word ${FAULT.word} flipped)`, data: img.data.map((w, i) => (i === FAULT.word ? (w ^ 1) >>> 0 : w)) });

describe('riscv-vector-tests at gate level (sc-v)', () => {
  const cfg = [...CPUS, ...EXTRA_CPUS].find((c) => c.id === 'sc-v')!;
  // one gate copy per instruction: the smallest data memory (a larger one is a larger circuit), then the shortest
  const pick = new Map<string, { n: string; k: number; size: number }>();
  for (const n of gates.names) {
    const l = loadable(gates.image(n), cfg.imemK, cfg.dmemK);
    const p = pick.get(instrOf(n)), c = { n, k: l.dmemK, size: l.words.length };
    if (!p || c.k < p.k || (c.k === p.k && c.size < p.size)) pick.set(instrOf(n), c);
  }
  const k = Math.min(...[...pick.values()].map((p) => p.k));
  const chosen = [...pick.values()].filter((p) => p.k === k).sort((a, b) => a.size - b.size);
  const left = [...pick.entries()].filter(([, p]) => p.k !== k).map(([i]) => i);

  it('runs one test of every instruction with a gate copy, but the unit-stride vle32 / vse32 (in every test\'s setup)', () => {
    expect(left.sort()).toEqual(['vle32.v', 'vse32.v']);
    expect(chosen.length).toBe(pick.size - 2);
  });
  it('the planted fault fails on the golden model', () => {
    expect(runRvv(gates.image(FAULT.test), true).pass).toBe(true);
    expect(runRvv(faulty(gates.image(FAULT.test)), true).text).toBe(FAULT.fails);
  });
  const imgs = [...chosen.map((p) => gates.image(p.n)), faulty(gates.image(FAULT.test))];
  for (const batch of cpuJobs(cfg, imgs)) {
    const names = batch.jobs.map((j) => j.img.name);
    it(`${names.length} programs on 2^${batch.dmemK} data words, ${names[0]} … ${names[names.length - 1]}`, async () => {
      const failed: string[] = [];
      (await runLanes(cfg, batch.jobs, batch.imemK, batch.dmemK)).forEach((r, i) => {
        const fault = names[i].includes('flipped');
        if (fault ? r.text !== FAULT.fails : !r.pass) failed.push(`${names[i]}: ${r.text}`);
        if (!fault && !batch.jobs[i].golden.pass) failed.push(`${names[i]} on the golden model: ${batch.jobs[i].golden.text}`);
      });
      expect(failed).toEqual([]);
    }, 600_000);
  }
});
