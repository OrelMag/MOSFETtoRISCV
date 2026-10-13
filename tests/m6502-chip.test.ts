// The transistor-level 6502 (Appendix A) against the ISS: every bus cycle from reset on the sample
// programs (with and without interrupts), and SingleStepTests cases set up by a loader program.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { m6502 } from '../src/lib/m6502/chip';
import { assemble, toImage } from '../src/m6502/asm';
import { Chip6502 } from '../src/m6502/chip';
import { OPCODES } from '../src/m6502/isa';
import { Ram64 } from '../src/m6502/iss';
import { PROGRAMS } from '../src/m6502/programs';
import { lockstep, type StepCase, StepRunner } from '../src/m6502/verify';
import { stats } from '../src/sim/stats';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function randomLines(seed: number, irqRate: number, nmiRate: number) {
  let x = seed, irq = false, nmi = false;
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  return () => {
    if (rnd() < irqRate) irq = !irq;
    if (rnd() < nmiRate) nmi = !nmi;
    return { irq, nmi };
  };
}

describe('transistor-level 6502', () => {
  const chip = new Chip6502(new Ram64());
  it('is about the size of the real one', () => {
    const st = stats(m6502());
    expect(st.transistors).toBeGreaterThan(3500);
    expect(st.transistors).toBeLessThan(6000);
    expect(st.depletion).toBeGreaterThan(800);
  });
  for (const p of PROGRAMS) {
    it(`${p.name}: every bus cycle from reset`, () => {
      expect(lockstep(chip, toImage(assemble(p.source)), 3000)).toBeNull();
    });
    it(`${p.name}: with random IRQ / NMI`, () => {
      for (let seed = 1; seed <= 3; seed++) expect(lockstep(chip, toImage(assemble(p.source)), 1500, randomLines(seed, 0.02, 0.01)), `seed ${seed}`).toBeNull();
    });
  }
});

describe('transistor-level 6502: SingleStepTests sample', () => {
  const sample = JSON.parse(readFileSync(here('./m6502/singlestep-sample.json'), 'utf8')) as Record<string, StepCase[]>;
  const runner = new StepRunner();
  for (const o of OPCODES) {
    if (!o) continue;
    const key = o.op.toString(16).padStart(2, '0');
    it(`${key} ${o.mnemonic} ${o.mode}`, () => {
      const bad = sample[key].slice(0, 6).map((c, i) => [i, runner.run(c)] as const).filter(([, e]) => e);
      expect(bad.slice(0, 3).map(([i, e]) => `#${i}: ${e}`)).toEqual([]);
    });
  }
});
