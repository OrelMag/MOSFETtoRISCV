import { describe, expect, it } from 'vitest';
import { systemCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

/** Run the RV32IM system CPU and the ISS in lock-step: the ISS steps whenever the hardware retires. */
function cosim(source: string, cycles: number, irqAt: number[] = []) {
  const asm = assemble(source);
  expect(asm.errors).toEqual([]);
  const words = asm.words;
  const design = flatten(systemCpu(words, { m: true }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words, { system: true, imemWords: 128, m: true });
  let out = '', stalls = 0;
  const root = design.root;
  for (let c = 0; c < cycles && !iss.halted; c++) {
    const irq = irqAt.includes(c) ? 1 : 0;
    sim.setInput('irq', irq);
    sim.settle();
    if (sim.getBits(root.ports.consoleValid)[0] === 1) out += String.fromCharCode(pack(sim.getBits(root.ports.consoleData)));
    let info = { text: '(stalled)' };
    if (retiring(sim)) { iss.irq = !!irq; info = iss.step(); } else stalls++;
    clockCycle(sim);
    const st = cpuState(sim);
    expect(st.pc, `cycle ${c}: pc after ${info.text}`).toBe(iss.pc);
    expect(st.x, `cycle ${c}: registers after ${info.text}`).toEqual([...iss.x]);
  }
  expect(out).toBe(iss.console);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { iss, out, stalls, leaves: design.leaves.length };
}

describe('RV32IM system CPU (gate level) vs golden model', () => {
  it('corner cases', () => {
    const r = cosim(M_PROGRAMS.find((p) => p.id === 'mcorner')!.source, 600);
    expect(r.iss.halted).toBe(true);
    expect(r.iss.x[29] >>> 0).toBe(0xfffffffe); // t4 = -7 / 3
    console.log(`mcorner: ${r.leaves} leaves, ${r.stalls} stall cycles`);
  }, 300000);
  it('factorials (first numbers)', () => {
    const r = cosim(M_PROGRAMS.find((p) => p.id === 'factorial')!.source, 700);
    console.log(`factorial: console ${JSON.stringify(r.out)}`);
    expect(r.out.startsWith('1\n2\n6\n24\n')).toBe(true);
  }, 300000);
  it('a timer interrupt during a divide waits for it to finish', () => {
    const src = `        la   t0, handler
        csrw mtvec, t0
        li   t0, 0x80000014
        li   t1, 30
        sw   t1, 0(t0)         # mtimecmp = 30: fires in the middle of the divide
        li   t0, 128
        csrw mie, t0
        csrsi mstatus, 8
        li   a0, 1000
        li   a1, 7
        div  a2, a0, a1
        addi a3, a2, 1
halt:   j    halt
handler: csrr s0, mepc
        li   t0, 0x80000014
        li   t1, -1
        sw   t1, 0(t0)
        mret`;
    const r = cosim(src, 200, [20, 21]);
    expect(r.iss.x[12]).toBe(142);
    expect(r.iss.x[13]).toBe(143);
    expect(r.iss.x[8]).toBe(0x34); // mepc: the instruction after the divide, which completed first
  }, 300000);
  it('still runs the plain system programs', () => {
    cosim(SYSTEM_PROGRAMS.find((p) => p.id === 'faults')!.source, 140);
  }, 300000);
});
