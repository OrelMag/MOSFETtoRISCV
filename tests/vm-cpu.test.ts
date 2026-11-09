// The virtual-memory system CPU (systemCpu(program, { vm: true })) against the golden model (ISS with system and vm) in lock
// step: directed programs (tests/vm-programs.ts) for the walk, every fault cause, sfence.vma and satp, interrupts across
// modes, sret, satp / sstatus written from S and the CSR privilege matrix; random programs are in vm-cpu-fuzz.test.ts.
// Each program also has to reach what it is about (the coverage below), or the test would pass on a program that went astray.
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { tick } from './yieldtick';
import { PROGS } from './vm-programs';
import { lockstep, type VmLockResult } from './verify/vmlock';

/** The entries of `what` that the run did not reach: cause:n, irq:level, walks:, or mnemonic@level (retired without trapping). */
const missing = (r: VmLockResult, what: string[]): string[] => what.filter((w) => {
  const [k, v] = w.split(':');
  if (k === 'cause') return !r.causes[Number(v)];
  if (k === 'irq') return !r.irqs[Number(v)];
  if (k === 'walks') return !r.walks;
  const [op, lvl] = w.split('@');
  return !r.ops[op]?.[Number(lvl)];
});

/** What each program must have done (found by its name). */
const COVER: Record<string, string[]> = {
  basic: ['cause:8', 'cause:9', 'cause:11', 'cause:13', 'cause:15', 'walks:', 'lw@0', 'lw@1', 'sw@1', 'csrrs@1'],
  faults: ['cause:1', 'cause:2', 'cause:4', 'cause:5', 'cause:6', 'cause:7', 'cause:12', 'cause:13', 'cause:15', 'walks:'],
  remap: ['walks:', 'lw@0', 'sw@0', 'sfence.vma@3', 'csrrw@3'],
  interrupts: ['irq:0', 'irq:1', 'irq:3', 'cause:8', 'cause:9'],
  sret: ['sret@1', 'sret@3', 'cause:2', 'cause:9', 'cause:8'],
  satp: ['csrrw@1', 'sfence.vma@1', 'lw@1', 'cause:13'],
  CSRs: ['cause:2', 'cause:8', 'cause:9', 'csrrw@1', 'csrrw@3', 'csrrs@1'],
};

describe('vm CPU on the event-driven (gate delay) simulator', () => {
  it.each(PROGS.filter((p) => /basic|interrupts|satp and/.test(p.name)).map((p) => [p.name, p] as const))('%s', async (_, p) => {
    const a = assemble(p.source);
    const imemK = Math.max(8, Math.ceil(Math.log2(a.words.length)));
    const r = await lockstep(a.words, { imemK, dmemK: p.dmemK ?? 12, maxCycles: p.max, engine: 'gate', pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
  }, 300_000);
});

describe('vm CPU in lock step with the golden model', () => {
  it.each(PROGS.map((p) => [p.name, p] as const))('%s', async (_, p) => {
    const a = assemble(p.source);
    expect(a.errors.map((e) => `line ${e.line}: ${e.message}`)).toEqual([]);
    const imemK = Math.max(8, Math.ceil(Math.log2(a.words.length)));
    const r = await lockstep(a.words, { imemK, dmemK: p.dmemK ?? 12, maxCycles: p.max, pause: tick });
    expect(r.why).toBe('');
    expect(r.ok).toBe(true);
    expect(r.halted).toBe(true);
    const key = Object.keys(COVER).find((k) => p.name.includes(k))!;
    expect(missing(r, COVER[key]), `${p.name}: not reached (${JSON.stringify({ causes: r.causes, irqs: r.irqs, byPriv: r.byPriv })})`).toEqual([]);
  }, 300_000);
});
