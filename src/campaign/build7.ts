// Act 7's build levels: the CSR file (a long random sequence against a model), and the cores with
// traps, then interrupts, then the finale: the pipeline with precise traps and interrupts. No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { CORE_PORTS } from '../lib/rv16/cpu';
import { rv16Pipe } from '../lib/rv16/pipe';
import { CSR16F, CsrModel, rv16SysCore } from '../lib/rv16/system';
import { CAUSE, CSR16 } from '../riscv/rv16/isa16';
import type { ComponentDef } from '../sim/types';
import { coreCheck } from './corecheck';
import { pipeTests, sysTests } from './coretests';
import { rng } from './drills';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (!a) {
    const doc = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
    if ('error' in doc) throw new Error(`reference ${id}: ${doc.error}`);
    answers.set(id, (a = [{ ...doc, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  }
  return a;
};

function csrSeq(): SeqStep[] {
  const r = rng(77);
  const m = new CsrModel();
  const st: SeqStep[] = [];
  const step = (i: { sel: number; wdata: number; we: number; trap: number; cause: number; pc: number; mret: number; irq: number }) => {
    m.edge(i);
    st.push({ set: { ...i }, tick: true, expect: { rdata: m.read(i.sel, i.irq), mtvec: m.csr[CSR16.mtvec], mepc: m.csr[CSR16.mepc], intr: m.intr(i.irq) } });
  };
  const base = { wdata: 0, we: 0, trap: 0, cause: 0, pc: 0, mret: 0, irq: 0 };
  // Write every CSR, read each back; enable interrupts; a trap and an mret.
  for (let k = 0; k < 8; k++) step({ ...base, sel: k, wdata: 0x1111 * (k + 1), we: 1 });
  step({ ...base, sel: CSR16.mstatus, wdata: 0x0008, we: 1 });
  step({ ...base, sel: CSR16.mie, wdata: 0x0800, we: 1, irq: 1 });
  step({ ...base, sel: CSR16.mip, irq: 1 });
  step({ ...base, sel: CSR16.mepc, trap: 1, cause: CAUSE.external, pc: 0x0123, irq: 1 });
  step({ ...base, sel: CSR16.mstatus, irq: 1 });
  step({ ...base, sel: CSR16.mcause, mret: 1, we: 1, wdata: 0xdead });
  step({ ...base, sel: CSR16.mstatus, irq: 1 });
  for (let i = 0; i < 60; i++) {
    const u = r();
    step({
      sel: Math.floor(r() * 8), wdata: Math.floor(r() * 0x10000), we: u < 0.5 ? 1 : 0, trap: u > 0.85 ? 1 : 0, cause: Math.floor(r() * 0x10000),
      pc: Math.floor(r() * 0x10000), mret: u > 0.7 && u <= 0.85 ? 1 : 0, irq: r() < 0.5 ? 1 : 0,
    });
  }
  return st;
}

const SYS_PINS: PinSpec[] = [...CORE_PORTS.slice(0, 4), { name: 'irq', width: 1, dir: 'in' as const }, ...CORE_PORTS.slice(4)]
  .map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.name === 'clk' ? { clock: true } : {}) }));

export const BUILD7: Record<string, () => BuildChallenge> = {
  y_csr: () => ({
    id: 'y_csr', title: 'CSR file', level: 'cpu', allowed: 'nand',
    brief: 'mstatus, mie, mtvec, mepc, mcause, mscratch: 16-bit registers read by number (<code>sel</code>: 0 mstatus, 1 mie, 2 mip, 3 mtvec, 4 mepc, 5 mcause, 6 mscratch, 7 mcycle). At the clock edge: if <code>trap</code>, mepc ← pc, mcause ← cause, MPIE ← MIE, MIE ← 0; else if <code>mret</code>, MIE ← MPIE, MPIE ← 1; else if <code>we</code>, csr[sel] ← wdata (mip and mcycle ignore writes). mip reads the interrupt line at bit 11 (MEIP); mcycle reads 0. <b>intr</b> = MIE · mie bit 11 · irq.',
    ports: pins([['sel', 3], ['wdata', 16], ['we'], ['trap'], ['cause', 16], ['pc', 16], ['mret'], ['irq'], ['clk']], [['rdata', 16], ['mtvec', 16], ['mepc', 16], ['intr']], 'clk'),
    check: { kind: 'sequence', steps: csrSeq() },
    answer: refOf('y_csr', () => CSR16F, 'CSR file'),
  }),
  y_trap: () => ({
    id: 'y_trap', title: 'Exceptions', level: 'cpu', allowed: 'nand',
    brief: 'Your single-cycle core, plus a CSR file and the instructions that use it: <code>csrrw</code> / <code>csrrs</code> / <code>csrrc</code> (rd ← old value), <code>ecall</code>, <code>ebreak</code> and illegal words (any SYSTEM, OPX or shift variant the ISA does not define, and every MD instruction) trap: the instruction does not run, mepc ← pc, mcause ← 11, 3 or 2, pc ← mtvec. <code>mret</code> returns to mepc. A new input pin <code>irq</code> is ignored here. Given: the illegal-instruction detector and the system decoder.',
    ports: SYS_PINS,
    check: coreCheck({ tests: () => sysTests(false), budget: { cpi: 1, extra: 2 }, system: true }, `${sysTests(false).length} programs (traps, CSR instructions, and the core's own tests) against the golden model with traps.`),
    answer: refOf('y_trap', () => rv16SysCore(false), 'Core with traps'),
  }),
  y_irq: () => ({
    id: 'y_irq', title: 'Interrupts', level: 'cpu', allowed: 'nand',
    brief: 'Take the external interrupt: when <code>intr</code> (MIE · MEIE · irq) is 1, the instruction at pc does not run; instead mepc ← pc, mcause ← 0x800B, pc ← mtvec, exactly like an exception. The bench raises <code>irq</code> after a program stores 1 to IRQ (0xFFF9) and lowers it after a store of 0.',
    ports: SYS_PINS,
    check: coreCheck({ tests: () => sysTests(true), budget: { cpi: 1, extra: 2 }, system: true }, `${sysTests(true).length} programs, one of them interrupt-driven.`),
    answer: refOf('y_irq', () => rv16SysCore(true), 'Core with interrupts'),
  }),
  y_final: () => ({
    id: 'y_final', title: 'Finale: the complete RV16', level: 'cpu', allowed: 'nand',
    brief: 'Everything at once: your pipeline (forwarding, load-use stall, branch flush) with the CSR file, exceptions and the external interrupt. Traps must be <b>precise</b>: take them in one stage (E is natural: the instruction there has not changed anything yet), let older instructions finish, flush the younger ones, and never trap on a bubble (carry a valid bit down the pipeline). Same pins as Interrupts.',
    ports: SYS_PINS,
    check: coreCheck({ tests: () => [...sysTests(true), ...pipeTests(3)], budget: { cpi: 2.5, extra: 10 }, system: true },
      `${sysTests(true).length + pipeTests(3).length} programs: traps, CSRs, an interrupt, loops, calls and random code, within 2.5 cycles per instruction.`),
    answer: refOf('y_final', () => rv16Pipe({ fwd: true, stall: true, flush: true, sys: true }), 'Complete RV16'),
  }),
};
