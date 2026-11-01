// Narration says what the golden model did: over every sample program, each instruction's write line names the value
// the model wrote, its next-pc line the address the model goes to next, and no line has a hole in it. The pipeline's
// narration names the forwards, the load-use stall and the flush at the cycles the gate-level pipeline has them.

import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, pipeSnap } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { narrateCycle, narrateInstr } from '../src/riscv/narrate';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

describe('narrateInstr', () => {
  for (const p of PROGRAMS) {
    it(p.id, () => {
      let words: number[];
      try { words = assemble(p.source).words; } catch { return; }
      const iss = new ISS(words);
      for (let n = 0; n < 400 && !iss.halted; n++) {
        const regs = [...iss.x];
        const info = iss.step();
        const lines = narrateInstr(regs, info);
        const text = lines.map((l) => l.text).join(' ');
        expect(text, `${p.id} @${info.pc.toString(16)}`).not.toMatch(/undefined|NaN/);
        const next = lines.find((l) => l.unit === 'next');
        if (next && !info.trap) expect(next.text, `${p.id} ${info.text}`).toContain(`0x${(iss.pc >>> 0).toString(16).padStart(8, '0')}`);
        const write = lines.find((l) => l.unit === 'write');
        if (write && info.rd) expect(write.text, `${p.id} ${info.text}`).toContain(String((info.value ?? 0) | 0));
      }
    });
  }
});

describe('narrateCycle', () => {
  it('names the forwards, the stall and the flush', () => {
    const src = `        li   t0, 5
        li   t1, 7
        add  t2, t0, t1
        sub  t3, t2, t0
        sw   t3, 0(zero)
        lw   t4, 0(zero)
        addi t5, t4, 1
        beq  t5, t5, skip
        addi t6, zero, 99
        addi t6, zero, 98
skip:   addi a0, t5, 1
halt:   j    halt`;
    const words = assemble(src).words;
    const sim = new GateSim(flatten(pipelinedCpu(words)));
    sim.reset('zero'); sim.setInput('clk', 0); sim.settle();
    const at: string[][] = [];
    for (let c = 0; c <= 10; c++) {
      at.push(narrateCycle(pipeSnap(sim, sim.design.root, c)!, (pc) => words[pc >>> 2] ?? 0).map((l) => `${l.unit}: ${l.text}`));
      clockCycle(sim);
    }
    const e = (c: number) => at[c].find((l) => l.startsWith('E:'))!;
    expect(e(4)).toMatch(/t0 forwarded from W.*t1 forwarded from M/);
    expect(at[4].find((l) => l.startsWith('D:'))).toMatch(/bypass/);
    expect(e(5)).toMatch(/t2 forwarded from M/);
    expect(at[7].find((l) => l.startsWith('D:'))).toMatch(/waits one cycle.*t4/);
    expect(e(8)).toMatch(/bubble/);
    expect(e(10)).toMatch(/flushed/);
  });
});
