// Numbers the codex's Check yourself questions and the campaign lessons quote, measured: an edit to either the
// text or the part fails here.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { resolveComponent } from '../src/lib/resolve';
import { busMux2 } from '../src/lib/combinational';
import { stats, logicDepth } from '../src/sim/stats';
import { CHECKS } from '../src/campaign/codexcheck';
import { LESSONS } from '../src/campaign/lessons';
import { simtTests } from '../src/campaign/lanetests';
import { TIMING } from '../src/dram/timing';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { encU, immU } from '../src/riscv/rv16/isa16';
import { Simt16 } from '../src/riscv/rv16/simt16';

const nands = (id: string) => {
  const d = resolveComponent(id);
  if (!d) throw new Error(id);
  return stats(d).nands;
};
/** A question's whole text: stem, options, explanation, whys. */
const text = (entry: string, i: number) => {
  const q = CHECKS[entry][i];
  return [q.question, ...q.options, q.explain ?? '', ...(q.why ?? [])].join(' ');
};
const thin = (n: number) => n.toLocaleString('en').replace(/,/g, ' ');

describe('codex checks: quoted costs', () => {
  it('register: 13 NANDs a bit unshared, 1 + 12 a bit with ¬en shared', () => {
    const bit = nands('rv16_dffe');
    expect([nands('rv16_dff'), bit, nands('rv16_reg4')]).toEqual([9, 13, 4 * 13]);
    const t = text('register', 0);
    expect(t).toContain(`× 12 = ${12 * bit}`);
    expect(t).toContain(`1 + 12 × ${bit - 1} = ${1 + 12 * (bit - 1)}`);
  });

  it('bus: busMux2(8) repeats the 4-NAND mux; 25 with a shared ¬s', () => {
    const d = busMux2(8);
    expect([stats(d).nands, logicDepth(d)]).toEqual([32, 3]);
    expect(text('bus', 0)).toContain('32 NANDs, depth 3');
    expect(text('bus', 0)).toContain('make it 25');
    expect(text('not', 0)).toContain('25 and 32 NANDs');
  });

  it('alu: the result mux is the largest part, a third of the ALU, 7 deep', () => {
    const alu = resolveComponent('rv16_alu16')!;
    const parts = alu.netlist!().instances.map((i) => (typeof i.def === 'string' ? resolveComponent(i.def)! : i.def));
    const mux = parts.find((p) => p.id.startsWith('rv16_mux8x16'))!;
    expect(Math.max(...parts.map((p) => stats(p).nands))).toBe(stats(mux).nands);
    const share = stats(mux).nands / stats(alu).nands;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.37);
    const t = text('alu', 1);
    expect(t).toContain(`${thin(stats(alu).nands)} NANDs, ${logicDepth(alu)} delays`);
    expect(t).toContain(`${stats(mux).nands} NANDs, a third of the ALU) but only ${logicDepth(mux)} levels`);
  });

  it('refresh: tRFC / tREFI in our cycles', () => {
    const t = text('refresh', 0);
    expect(t).toContain(`tREFI = ${thin(TIMING.tREFI)} cycles`);
    expect(t).toContain(`tRFC = ${TIMING.tRFC} cycles`);
    expect((100 * TIMING.tRFC / TIMING.tREFI).toFixed(1)).toBe('4.5');
    expect(t).toContain('4.5%');
  });

  it('utilization: the if / else and nested-if tests, on the golden model', () => {
    const run = (name: string) => {
      const a = assemble16(simtTests().find((t) => t.name === name)!.src!);
      expect(a.errors).toEqual([]);
      const w = new Simt16(a.words, {}, a.data);
      w.run(5000);
      expect(w.halted).toBe(true);
      return { steps: w.steps, util: Math.round(100 * w.utilization) };
    };
    const flat = run('split: if / else'), nest = run('split: nested');
    expect([flat.steps, flat.util, nest.steps, nest.util]).toEqual([14, 71, 19, 59]);
    const t = text('utilization', 1);
    expect(t).toContain(`${flat.util}% lane utilization`);
    expect(t).toContain(`at ${nest.util}%`);
    expect(t).toContain(`over ${nest.steps} × 4 = ${nest.steps * 4}`);
  });
});

describe('campaign lessons', () => {
  it('mem: the register file the learner built', () => {
    const rf = nands('rv16_rf');
    const m = LESSONS.mem;
    expect(m).toContain(`${nands('rv16_dffe')} NANDs per bit (a ${nands('rv16_dff')}-NAND flip-flop`);
    // the reference is re-authored now and then: the text rounds, the test checks the rounding still holds
    expect(m).toContain(`about ${thin(Math.round(rf / 100) * 100)} NANDs\nfor ${7 * 16} bits of state: some 20 NANDs, 80 transistors, a bit`);
    expect(Math.abs(rf / 112 - 20)).toBeLessThan(1);
  });

  it('isa: the U row is where encU puts the immediate', () => {
    const w = encU(0, 0b1010000001);
    expect(w & 0xf).toBe(0b1111);
    expect((w >> 7) & 0x1ff).toBe(0b101000000);
    expect(immU(w)).toBe(0b1010000001 << 6);
    expect(LESSONS.isa).toContain('<tr><th>U</th><td colspan="3">imm[9:1]</td><td>rd</td><td>imm[0] · 111</td></tr>');
  });

  it('intro: exhaustive up to 16 input bits, 4 096 random vectors above', () => {
    const src = readFileSync(new URL('../src/editor/challenges.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const MAX_EXHAUSTIVE = 16;/);
    expect(src).toMatch(/const RANDOM_VECTORS = 4096;/);
    expect(LESSONS.intro).toContain('combination up to 16 input bits, 4 096 random ones');
  });
});
