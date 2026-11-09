// The virtual-memory chapter's programs (riscv/vmprograms.ts) on the gate-level CPU in lock step with the golden model, and the
// model-side numbers the chapter quotes (riscv/vmrun.ts) held to the gates' stall cycles.
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { VM_PROGRAMS, VM_IMEM_K, VM_DMEM_K, WALK_CYCLES, SUPER_CYCLES } from '../src/riscv/vmprograms';
import { runVmModel } from '../src/riscv/vmrun';
import { lockstep } from './verify/vmlock';
import { PROGS } from './vm-programs';
import { tick } from './yieldtick';

const WANT_OUTPUT: Record<string, string> = { walk: 'OK', pager: 'OK', guard: 'WROK' };

describe('the chapter programs on the gates, in lock step with the golden model', () => {
  it.each(VM_PROGRAMS.map((p) => [p.id, p] as const))('%s', async (_, p) => {
    const a = assemble(p.source);
    expect(a.errors.map((e) => `line ${e.line}: ${e.message}`)).toEqual([]);
    const r = await lockstep(a.words, { imemK: VM_IMEM_K, dmemK: VM_DMEM_K, maxCycles: 3000, pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
    const m = runVmModel(p.source);
    expect(m.halted).toBe(true);
    expect(m.output).toBe(WANT_OUTPUT[p.id]);
    // every miss is one walk of WALK_CYCLES stall cycles, a fault included; an instruction missing on both sides stalls for two walks in a row
    expect(r.stalls).toBe(WALK_CYCLES * (m.imiss + m.dmiss));
    // and the gates retire (or trap) once a step: the cycles to the halt are the model's steps plus the stalls
    expect(r.cycles).toBeGreaterThanOrEqual(m.cycles);
  }, 300_000);

  it('a walk to a 4 KiB leaf stalls WALK_CYCLES cycles, to a 4 MiB superpage SUPER_CYCLES', async () => {
    const faults = PROGS.find((p) => p.name.startsWith('faults'))!;
    const a = assemble(faults.source);
    const r = await lockstep(a.words, { imemK: 8, dmemK: faults.dmemK ?? 12, maxCycles: faults.max, pause: tick });
    expect(r.why).toBe('');
    expect(Object.keys(r.stallRuns).map(Number)).toContain(SUPER_CYCLES);
    expect(Object.keys(r.stallRuns).map(Number)).toContain(WALK_CYCLES);
    const basic = PROGS.find((p) => p.name.startsWith('basic'))!;
    const b = await lockstep(assemble(basic.source).words, { imemK: 8, dmemK: 12, maxCycles: basic.max, pause: tick });
    expect(Math.min(...Object.keys(b.stallRuns).map(Number))).toBe(WALK_CYCLES);
  }, 300_000);
});
