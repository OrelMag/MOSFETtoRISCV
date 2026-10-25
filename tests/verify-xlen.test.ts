// Chapter 25's width-parametric single-cycle core (lib/cpu64.ts xlenCpu) on the official riscv-tests: rv64ui / rv64um
// (bare64) at 64 bits, rv32ui / rv32um (bare) at 32 bits, 32 images at a time on BitSim's lanes, each lane its own
// program ROM. Every image is loaded as tests/verify/images.ts loadable() makes it; the verdict is the test's own
// (tohost, data word 0), and the registers at the end are compared with the golden model's (ISS64 / ISS). Then the
// benchmark set at 64 bits (benchSource: sort and CRC-32 with their W shifts): the memory each program must leave,
// in exactly the instructions the RV32 single-cycle core runs.

import { describe, expect, it } from 'vitest';
import { xlenCpu, type Xlen } from '../src/lib/cpu64';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS, benchSource } from '../src/riscv/benchprograms';
import { wideState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { ISS64 } from '../src/riscv/iss64';
import { BitSim, LANES } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import type { Bit } from '../src/sim/types';
import { notApplicable } from './verify/cpus';
import { images, loadable, RV64_NOT_APPLICABLE, verdict, type Env } from './verify/images';
import { tick } from './yieldtick';

interface Case { name: string; words: number[]; m: boolean; imemK: number; dmemWords: number }
interface Outcome { tohost: number; regs: bigint[]; dmem: bigint[]; cycles: number }

/** The golden model's run: final registers (as unsigned XLEN-bit values), its data words, the instructions and divides. */
function goldenRun(xlen: Xlen, c: Case) {
  if (xlen === 64) {
    const g = new ISS64(c.words, { m: c.m, imemWords: 2 ** c.imemK, dmemWords: c.dmemWords });
    let divides = 0;
    while (!g.halted && g.steps < 300_000) if (/^(div|rem)/.test(g.step().text)) divides++;
    return { halted: g.halted, steps: g.steps, divides, regs: [...g.x], dmem: [...g.dmem] };
  }
  const g = new ISS(c.words, { m: c.m, imemWords: 2 ** c.imemK, dmemWords: c.dmemWords });
  let divides = 0;
  while (!g.halted && g.steps < 300_000) if (/^(div|rem)/.test(g.step().text)) divides++;
  return { halted: g.halted, steps: g.steps, divides, regs: [...g.x].map((v) => BigInt(v >>> 0)), dmem: [...g.dmem] };
}

/** Up to 32 cases on one build of the core, run for `cycles` cycles. */
async function runLanes(xlen: Xlen, cases: Case[], cycles: number): Promise<Outcome[]> {
  if (cases.length > LANES) throw new Error('at most 32 cases');
  const imemK = Math.max(...cases.map((c) => c.imemK));
  // the core's data memory counts words of its own width
  const dmemK = Math.max(5, ...cases.map((c) => Math.log2(c.dmemWords) - (xlen === 64 ? 1 : 0)));
  const m = cases.some((c) => c.m);
  const design = flatten(xlenCpu(cases[0].words, { xlen, m, imemK, dmemK }));
  const sim = new BitSim(design);
  const N = 2 ** imemK;
  design.leaves.forEach((leaf, i) => {
    if (leaf.kind !== 'behavior' || leaf.inputs.length === 0) return;
    sim.setLaneBehavior(i, ([a], lane) => [cases[lane % cases.length].words[Math.floor(a / 4) % N] ?? 0x13]);
  });
  sim.setInput('clk', 0);
  sim.settle();
  for (let c = 1; c <= cycles; c++) {
    if ((c & 63) === 0) await tick();
    sim.cycle();
  }
  return cases.map((_, l) => {
    const st = wideState({ design, getBits: (nets: readonly number[]) => nets.map((n) => ((sim.v[n] >>> l) & 1) as Bit) });
    return { tohost: Number((st.dmem[0] ?? 0n) & 0xffffffffn), regs: st.x, dmem: st.dmem, cycles };
  });
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function suite(xlen: Xlen, env: Env, suites: string[]) {
  const all = images(env).filter((i) => suites.includes(i.suite));
  const na = (name: string) => (xlen === 64 ? RV64_NOT_APPLICABLE[name] : notApplicable({ isa: { sub: true, m: true } }, name));
  const run = all.filter((i) => !na(i.name));
  it(`runs ${run.length} of ${all.length} (${all.filter((i) => na(i.name)).map((i) => i.name).join(', ')} not applicable)`, async () => {
    const failures: string[] = [];
    for (const batch of chunks(run, LANES)) {
      const cases: Case[] = batch.map((img) => {
        const l = loadable(img);
        return { name: img.name, words: l.words, m: img.suite.endsWith('um'), imemK: l.imemK, dmemWords: 2 ** l.dmemK };
      });
      const gold = cases.map((c) => goldenRun(xlen, c));
      gold.forEach((g, i) => { if (!g.halted) failures.push(`${cases[i].name}: the golden model did not halt`); });
      const cycles = Math.max(...gold.map((g) => g.steps + g.divides * (xlen + 1))) + 8;
      const out = await runLanes(xlen, cases, cycles);
      out.forEach((o, i) => {
        const v = verdict(o.tohost, env);
        if (!v.pass) failures.push(`${cases[i].name}: ${v.text}`);
        const r = o.regs.findIndex((x, k) => k > 0 && x !== gold[i].regs[k]);
        if (r > 0) failures.push(`${cases[i].name}: x${r} = ${o.regs[r].toString(16)}, model ${gold[i].regs[r].toString(16)}`);
      });
    }
    expect(failures).toEqual([]);
  }, 600_000);
}

describe('riscv-tests on xlenCpu(64), RV64IM', () => suite(64, 'bare64', ['rv64ui', 'rv64um']));
describe('riscv-tests on xlenCpu(32), RV32IM', () => suite(32, 'bare', ['rv32ui', 'rv32um']));

describe('the benchmark set on xlenCpu(64)', () => {
  it('leaves each program\'s memory, in the RV32 instruction count but for longer li', async () => {
    const progs = BENCHMARKS.filter((b) => !b.needs?.f);
    const cases: Case[] = progs.map((b) => ({ name: b.id, words: assemble(benchSource(b, 64), [], { xlen: 64 }).words, m: true, imemK: 7, dmemWords: 128 }));
    const gold = cases.map((c) => goldenRun(64, c));
    progs.forEach((b, i) => {
      const w32 = assemble(b.source).words;
      const r32 = new ISS(w32, { m: true, imemWords: 128, dmemWords: 64 });
      r32.run(300_000);
      // the only extra instructions: li of a constant above 2^31 (positive on RV64), each run once, outside the loops
      expect(gold[i].steps - r32.steps, `${b.id}: extra instructions on RV64`).toBe(cases[i].words.length - w32.length);
    });
    const out = await runLanes(64, cases, Math.max(...gold.map((g) => g.steps)) + 8);
    progs.forEach((b, i) => {
      for (const [w, v] of b.expect()) {
        const dw = out[i].dmem[w >> 1] ?? 0n;
        expect(Number((dw >> BigInt(32 * (w & 1))) & 0xffffffffn), `${b.id}: word ${w}`).toBe(v);
      }
    });
  }, 300_000);
});
