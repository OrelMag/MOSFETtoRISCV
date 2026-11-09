import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { VM_PROGRAMS, VM_IMEM_K, VM_DMEM_K, WALK_CYCLES } from '../src/riscv/vmprograms';
import { lockstep } from './verify/vmlock';
import { tick } from './yieldtick';

describe('the chapter programs on the gates, in lock step with the golden model', () => {
  it.each(VM_PROGRAMS.map((p) => [p.id, p] as const))('%s', async (_, p) => {
    const a = assemble(p.source);
    expect(a.errors.map((e) => `line ${e.line}: ${e.message}`)).toEqual([]);
    const r = await lockstep(a.words, { imemK: VM_IMEM_K, dmemK: VM_DMEM_K, maxCycles: 3000, pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
  }, 300_000);
});

import { ISS } from '../src/riscv/iss';
import { TlbModel } from '../src/sim/tlbmodel';

/** The golden model's accesses through two TLB models (as lib/vm.ts fills and flushes them): how many walks the gates must start. */
export function modelWalks(words: number[]) {
  const iss = new ISS(words, { system: true, vm: true, imemWords: 2 ** VM_IMEM_K, dmemWords: 2 ** VM_DMEM_K });
  const it = new TlbModel(4), dt = new TlbModel(4);
  let access = 0, faults = 0;
  for (let i = 0; i < 3000 && !iss.halted; i++) {
    const info = iss.step();
    for (const w of info.walks ?? []) {
      access++;
      const t = w.access === 'fetch' ? it : dt, vpn = w.va >>> 12;
      if (w.fault !== undefined) { if (!t.has(vpn)) t.misses++; faults++; } else t.access(vpn);
    }
    if (info.text.startsWith('sfence.vma') || /^csrr?w?.* satp/.test(info.text)) { it.flush(); dt.flush(); }
  }
  return { access, faults, imiss: it.misses, dmiss: dt.misses, steps: iss.steps };
}

describe('the TLB model against the gates', () => {
  it.each(VM_PROGRAMS.map((p) => [p.id, p] as const))('%s', async (_, p) => {
    const a = assemble(p.source);
    const r = await lockstep(a.words, { imemK: VM_IMEM_K, dmemK: VM_DMEM_K, maxCycles: 3000, pause: tick });
    const m = modelWalks(a.words);
    expect(r.why).toBe('');
    // every miss is one walk of WALK_CYCLES stall cycles, a fault included; an instruction missing on both sides stalls for two walks in a row
    expect(r.stalls).toBe(WALK_CYCLES * (m.imiss + m.dmiss));
  });
});
