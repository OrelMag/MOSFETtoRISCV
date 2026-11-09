// A chapter program run to its halt on the golden model's vm mode, with the walks counted the way the gates' TLBs count them (DOM-free).
// The cycles are the model's steps plus WALK_CYCLES for every TLB miss, which tests/vm-chapter.test.ts holds equal to the cycles the
// gate-level CPU takes (every stall cycle is part of a walk, a faulting walk included).

import { assemble } from './asm';
import { ISS } from './iss';
import { VM_DMEM_K, VM_IMEM_K, WALK_CYCLES } from './vmprograms';
import { TlbModel } from '../sim/tlbmodel';

export interface TrapRecord { cause: number; tval: number; /** Instructions the handler ran before its mret. */ handlerSteps: number; /** Instruction number (1-based) of the trap. */ at: number }
export interface VmRun {
  steps: number;
  /** Clock cycles on the gates: one a step, three more for every walk. */
  cycles: number;
  /** TLB misses (= walks started): instruction side, data side. */
  imiss: number;
  dmiss: number;
  /** Translated accesses (fetches, loads, stores in S and U with Sv32 on). */
  accesses: number;
  /** Page faults seen (a fetch, load or store the walker or the permission check refused). */
  faults: number;
  traps: TrapRecord[];
  output: string;
  halted: boolean;
}

/** The two TLB models, filled and flushed as lib/vm.ts does: a fill on a good walk, a flush on sfence.vma and on a write to satp. */
export function runVmModel(source: string, maxSteps = 4000): VmRun {
  const a = assemble(source);
  const iss = new ISS(a.words, { system: true, vm: true, imemWords: 2 ** VM_IMEM_K, dmemWords: 2 ** VM_DMEM_K });
  const it = new TlbModel(4), dt = new TlbModel(4);
  const traps: TrapRecord[] = [];
  let accesses = 0, faults = 0, open: TrapRecord | null = null;
  while (iss.steps < maxSteps && !iss.halted) {
    const info = iss.step();
    for (const w of info.walks ?? []) {
      accesses++;
      const t = w.access === 'fetch' ? it : dt, vpn = w.va >>> 12;
      if (w.fault !== undefined) { faults++; if (!t.has(vpn)) t.misses++; } else t.access(vpn);
    }
    if (info.text.startsWith('sfence.vma') || /^csrr?w?i? satp/.test(info.text)) { it.flush(); dt.flush(); }
    if (info.trap && !info.trap.interrupt && info.trap.cause !== 8) traps.push((open = { cause: info.trap.cause, tval: info.trap.tval ?? 0, handlerSteps: 0, at: iss.steps }));
    else if (open) { open.handlerSteps++; if (info.text.startsWith('mret')) open = null; }
  }
  return { steps: iss.steps, cycles: iss.steps + WALK_CYCLES * (it.misses + dt.misses), imiss: it.misses, dmiss: dt.misses, accesses, faults, traps, output: iss.console, halted: iss.halted };
}
