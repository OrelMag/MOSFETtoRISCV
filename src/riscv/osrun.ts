// An OS image (riscv/osprograms.ts) run on the golden model's vm mode with the TLB models of riscv/vmrun.ts (DOM-free). Every cycle count is
// the model's steps plus WALK_CYCLES for every TLB miss, which tests/os-kernel.test.ts holds equal, run by run, to the cycles the gate-level
// CPU takes. Each step is classed by who ran it (a process, or the kernel in machine mode); the trips into the kernel are recorded:
// the cause, the system call's number, what the kernel ran and what the walks after the return cost.

import { ISS } from './iss';
import { OS_DMEM_K, OS_IMEM_K, PCB, PCB0, PCB_SIZE, SYS, type OsImage } from './osprograms';
import { fills } from './vmrun';
import { WALK_CYCLES } from './vmprograms';
import { TlbModel } from '../sim/tlbmodel';

/** One trip into the kernel: from the trap being taken to the mret that ends it, and the run in user mode that follows. */
export interface Trip {
  /** mcause (bit 31: an interrupt). */
  cause: number;
  /** a7 when the cause is an ecall. */
  call: number;
  /** The process that trapped, and the one the kernel returned to (0 = A, 1 = B). */
  from: number;
  to: number;
  /** Step index (0-based) of the trapping step. */
  at: number;
  /** Instructions the kernel ran (the trapping step and the mret included) and the cycles they took. */
  kernelSteps: number;
  kernelCycles: number;
  /** Walk stall cycles caused by TLB misses before the next trap, and the user instructions run in that time. */
  userSteps: number;
  userWalks: number;
  /** Cycles from the trap to the first user instruction retired in the process returned to (the mret, and the walk that fetches its first instruction). */
  toFirst: number;
}

export interface OsRun {
  steps: number;
  cycles: number;
  halted: boolean;
  /** Everything the console showed, and the part of it each process wrote (the one running when the byte was written, unless it was already gone: the kernel's own "all done"). */
  output: string;
  byProc: string[];
  trips: Trip[];
  /** One entry per step: who ran it (0 / 1 a process, 2 the kernel) and the cycles it took (walk stalls included). */
  who: Uint8Array;
  cost: Uint8Array;
  walks: number;
  iss: ISS;
}

const procOf = (cur: number) => Math.min(1, Math.max(0, Math.floor((cur - PCB0) / PCB_SIZE)));

export function runOs(img: OsImage, maxSteps = 100000): OsRun {
  const iss = new ISS(img.words, { system: true, vm: true, imemWords: 2 ** OS_IMEM_K, dmemWords: 2 ** OS_DMEM_K });
  const it = new TlbModel(4), dt = new TlbModel(4);
  const who: number[] = [], cost: number[] = [];
  const byProc = ['', ''];
  const trips: Trip[] = [];
  let cycles = 0, walks = 0, open: Trip | null = null, last: Trip | null = null, firstSeen = false, sinceTrap = 0;
  while (iss.steps < maxSteps && !iss.halted) {
    const cur = iss.dmem[0] >>> 0, a7 = iss.x[17] >>> 0;
    const before = it.misses + dt.misses;
    const conLen = iss.console.length;
    const info = iss.step();
    for (const w of info.walks ?? []) {
      const t = w.access === 'fetch' ? it : dt, vpn = w.va >>> 12;
      if (w.fault !== undefined) { if (fills(w)) t.access(vpn); else if (!t.has(vpn)) t.misses++; } else t.access(vpn);
    }
    if (info.text.startsWith('sfence.vma') || /^csrr?w?i? satp/.test(info.text)) { it.flush(); dt.flush(); }
    const miss = it.misses + dt.misses - before;
    walks += miss;
    const c = 1 + WALK_CYCLES * miss;
    cycles += c;
    const user = info.priv === 0;
    who.push(user ? procOf(cur) : 2);
    cost.push(c);
    if (iss.console.length > conLen) { const pcb = iss.dmem[0] >>> 0; if (iss.dmem[(pcb + PCB.state) / 4] !== 2) byProc[procOf(pcb)] += iss.console.slice(conLen); }
    if (user && info.trap) {
      last = open = { cause: info.trap.cause >>> 0, call: info.trap.cause === 8 ? a7 : -1, from: procOf(cur), to: procOf(cur), at: iss.steps - 1, kernelSteps: 1, kernelCycles: c, userSteps: 0, userWalks: 0, toFirst: c };
      trips.push(open);
      firstSeen = false;
      sinceTrap = c;
    } else if (open && !user) {
      open.kernelSteps++; open.kernelCycles += c; sinceTrap += c;
      if (info.text.startsWith('mret')) { open.to = procOf(iss.dmem[0] >>> 0); open = null; }
    } else if (last && user) {
      last.userSteps++; last.userWalks += miss;
      if (!firstSeen) { firstSeen = true; last.toFirst = sinceTrap + c; }
    }
  }
  return { steps: iss.steps, cycles, halted: iss.halted, output: iss.console, byProc, trips, who: Uint8Array.from(who), cost: Uint8Array.from(cost), walks, iss };
}

/** The trips of one kind (a system call number, or 'timer'). */
export const tripsOf = (run: OsRun, kind: number | 'timer' | 'fault'): Trip[] =>
  run.trips.filter((t) => (kind === 'timer' ? t.cause === 0x80000007 : kind === 'fault' ? t.cause !== 8 && t.cause < 0x80000000 : t.cause === 8 && t.call === kind));

export { SYS };
