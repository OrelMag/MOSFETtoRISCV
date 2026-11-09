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

// ---- the context switch, step by step (chapter 'os' step 4)

export interface SwitchFrame {
  /** Instruction number within the excursion (0 = the trap being taken). */
  i: number;
  pc: number;
  text: string;
  phase: 'save' | 'choose' | 'restore' | 'user';
  /** Cycles since the trap, this instruction's walk stalls included. */
  cycles: number;
  /** The CPU's registers x0..x31 after this instruction, and the first 32 words of each PCB (word 0 the saved PC, then x1..x31). */
  regs: number[];
  pcb: [number[], number[]];
  /** The register this instruction wrote (0: none) and the PCB word it stored to (-1: none). */
  wrote: number;
  stored: [number, number] | null;
  /** The process the CPU was taken from and the one it was given to (the same on every frame). */
  from: number;
  to: number;
}

const pcbWords = (iss: ISS, p: number) => Array.from({ length: 32 }, (_, i) => iss.dmem[(PCB0 + p * PCB_SIZE) / 4 + i] >>> 0);

/** The first timer interrupt after which the kernel gives the CPU to the other process, from the trap to the other process's first instruction. */
export function captureSwitch(img: OsImage, maxSteps = 100000): SwitchFrame[] {
  const iss = new ISS(img.words, { system: true, vm: true, imemWords: 2 ** OS_IMEM_K, dmemWords: 2 ** OS_DMEM_K });
  const it = new TlbModel(4), dt = new TlbModel(4);
  const L = img.labels, trap = L.get('trap')!, saved = L.get('trap_saved')!, sw = L.get('go_switch')!;
  let frames: SwitchFrame[] = [], cyc = 0, inTrip = false, mretSeen = false, from = -1;
  while (iss.steps < maxSteps && !iss.halted) {
    const cur = iss.dmem[0] >>> 0;
    const before = it.misses + dt.misses, xs = [...iss.x];
    const pre = [pcbWords(iss, 0), pcbWords(iss, 1)];
    const info = iss.step();
    for (const w of info.walks ?? []) {
      const t = w.access === 'fetch' ? it : dt, vpn = w.va >>> 12;
      if (w.fault !== undefined) { if (fills(w)) t.access(vpn); else if (!t.has(vpn)) t.misses++; } else t.access(vpn);
    }
    if (info.text.startsWith('sfence.vma') || /^csrr?w?i? satp/.test(info.text)) { it.flush(); dt.flush(); }
    const c = 1 + WALK_CYCLES * (it.misses + dt.misses - before);
    if (info.priv === 0 && info.trap && info.trap.cause === 0x80000007) { inTrip = true; frames = []; cyc = 0; mretSeen = false; from = cur; }
    if (!inTrip) continue;
    cyc += c;
    const pc = info.pc >>> 0;
    const user = info.priv === 0 && !info.trap;
    const phase: SwitchFrame['phase'] = user ? 'user' : pc >= sw && info.text !== 'ebreak' ? 'restore' : pc >= saved ? 'choose' : 'save';
    // the trapping step itself is in the user process, taken to mtvec; call it the first of the save
    const first = frames.length === 0;
    const post = [pcbWords(iss, 0), pcbWords(iss, 1)];
    const wrote = xs.findIndex((v, i) => i > 0 && (v | 0) !== (iss.x[i] | 0));
    let stored: [number, number] | null = null;
    for (let p = 0; p < 2; p++) for (let i = 0; i < 32; i++) if (post[p][i] !== pre[p][i]) stored = [p, i];
    frames.push({ i: frames.length, pc, text: first ? 'timer interrupt: MTIP and a user instruction fetched' : info.text, phase: first ? 'save' : phase, cycles: cyc, regs: [...iss.x].map((v) => v >>> 0), pcb: post as [number[], number[]], wrote: wrote < 0 ? 0 : wrote, stored, from: procOf(from), to: -1 });
    if (info.text.startsWith('mret')) mretSeen = true;
    if (mretSeen && user) {
      const next = iss.dmem[0] >>> 0;
      if (next !== from) { for (const f of frames) f.to = procOf(next); return frames; }
      inTrip = false; // the kernel gave the CPU back to the same process: look at the next interrupt
    }
    void trap;
  }
  return frames;
}

/** Time slice against what the kernel and the walks take: two spinners run for `total` retired instructions on a slice of `slice` instructions. */
export interface Overhead { slice: number; switches: number; kernel: number; walk: number; user: number; cycles: number; overhead: number }
export function overheadAt(slice: number, total: number, mk: (slice: number) => OsImage): Overhead {
  const r = runOs(mk(slice), total);
  let k = 0, u = 0, wk = 0, cycles = 0;
  const first = r.who.findIndex((w) => w < 2); // the boot is not the price of sharing
  for (let i = Math.max(0, first); i < r.who.length; i++) {
    cycles += r.cost[i];
    const walk = (r.cost[i] - 1);
    wk += walk;
    if (r.who[i] === 2) k++; else u++;
  }
  const switches = r.trips.filter((t) => t.from !== t.to).length;
  return { slice, switches, kernel: k, walk: wk, user: u, cycles, overhead: (k + wk) / cycles };
}

// ---- the plan of memory (chapter 'os' step 1): read from the page tables the kernel itself built

/** The golden model stopped at the kernel's first mret: tables built, the first process about to run. */
export function booted(img: OsImage): ISS {
  const iss = new ISS(img.words, { system: true, vm: true, imemWords: 2 ** OS_IMEM_K, dmemWords: 2 ** OS_DMEM_K });
  while (iss.priv !== 0 && iss.steps < 5000) iss.step();
  return iss;
}

export interface MapRow { va: number; pte: number; flags: string; pa: number; what: string }
export interface Plan {
  /** Sixteen data frames: who owns each (the kernel's frame, a process's root table, second table, page 0 / page 1, or none). */
  dataFrames: { owner: number; role: string }[];
  /** The ROM's four frames. */
  romFrames: { owner: number; role: string }[];
  maps: MapRow[][];
  satp: number[];
}

const FLAG_NAMES = 'VRWXUGAD';
export const flagsOf = (pte: number) => [...FLAG_NAMES].map((c, i) => ((pte >>> i) & 1 ? c : '·')).join('');

export function planOf(img: OsImage): Plan {
  const iss = booted(img);
  const dataFrames = Array.from({ length: 2 ** OS_DMEM_K / 1024 }, () => ({ owner: -1, role: 'free' }));
  dataFrames[0] = { owner: 2, role: 'kernel: variables, process control blocks' };
  const maps: MapRow[][] = [], satps: number[] = [];
  const what: Record<number, string> = { 0: 'data page 0', 1: 'data page 1', 2: 'the kernel\'s frame (U = 0)', 4: 'code' };
  for (let p = 0; p < 2; p++) {
    const satp = iss.dmem[(PCB0 + p * PCB_SIZE + 128) / 4] >>> 0;
    satps.push(satp);
    const root = (satp & 0x3fffff) * 4096;
    const rootPte = iss.dmem[root / 4] >>> 0, leaf = (rootPte >>> 10) * 4096;
    dataFrames[root >>> 12] = { owner: p, role: 'root table' };
    dataFrames[leaf >>> 12] = { owner: p, role: 'second table' };
    const rows: MapRow[] = [];
    for (let i = 0; i < 8; i++) {
      const pte = iss.dmem[leaf / 4 + i] >>> 0;
      if (!(pte & 1)) continue;
      const pa = (pte >>> 10) * 4096, va = i * 4096;
      rows.push({ va, pte, flags: flagsOf(pte), pa, what: what[i] ?? 'mapped' });
      if (i === 0 || i === 1) dataFrames[pa >>> 12] = { owner: p, role: `data page ${i}` };
    }
    maps.push(rows);
  }
  const romFrames = [{ owner: 2, role: 'kernel code' }, { owner: 0, role: 'process A code' }, { owner: 1, role: 'process B code' }, { owner: -1, role: 'free' }];
  return { dataFrames, romFrames, maps, satp: satps };
}
