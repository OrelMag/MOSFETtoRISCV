// DOM-free models behind chapter 26-38's system analogy figures (merge H: kitchen, squad, movers, doorbell, fourway).
// Heavy models (the out-of-order core, the SIMT golden model, the ISS) are imported here only: this module loads with
// its figures, never from ui/analogyfigs.ts.

import { assemble } from '../../riscv/asm';
import { disasm } from '../../riscv/isa';
import { ISS } from '../../riscv/iss';
import { OooModel, oooRun, type OooConfig } from '../../riscv/ooomodel';
import { OOO_PROGRAMS } from '../../riscv/oooprograms';
import { SimtISS, popcount } from '../../riscv/simt';
import { SIMT_PROGRAMS } from '../../riscv/simtprograms';
import { SYSTEM_PROGRAMS } from '../../riscv/sysprograms';
import { FLASH_TIMES } from '../../flash/model';

// ---- kitchen: chapter "ooo", the reorder buffer ----

export const KITCHEN_PROGRAMS = [
  { id: 'chains', name: 'Divide chain', note: 'a divide every element' },
  { id: 'dot', name: 'Dot product', note: 'two loads and a multiply' },
] as const;
export const KITCHEN_WINDOWS = [4, 8, 16] as const;
const KITCHEN_OPTS = { dmemWords: 64, imemWords: 128 };

export type DishState = 'queued' | 'issued' | 'done';
export interface Ticket { seq: number; text: string; state: DishState; port: number; wrong: boolean }
export interface KitchenFrame {
  cycle: number;
  /** The pass (reorder buffer), oldest first. */
  rob: Ticket[];
  /** Tickets fetched and waiting for a free entry. */
  waiting: number;
  /** Committed so far. */
  served: number;
  /** Committed this cycle (sequence numbers). */
  out: number[];
  /** Dispatch stopped this cycle for lack of a pass entry (counted by the model). */
  full: boolean;
}
export interface KitchenRun { frames: KitchenFrame[]; cycles: number; instructions: number; robFull: number }

export const kitchenConfig = (rob: number): Partial<OooConfig> => ({ rob, iq: Math.min(8, rob) });
const kitchenWords = (program: string): number[] => assemble(OOO_PROGRAMS.find((p) => p.id === program)!.source).words;

const kitchenCache = new Map<string, KitchenRun>();

/** The program on OooModel with a `rob`-entry window, a frame per cycle (cached). */
export function kitchenRun(program: string, rob: number): KitchenRun {
  const key = `${program}/${rob}`;
  let r = kitchenCache.get(key);
  if (r) return r;
  const m = new OooModel(kitchenWords(program), kitchenConfig(rob), KITCHEN_OPTS);
  const frames: KitchenFrame[] = [];
  let served = 0;
  while (!m.halted && m.cycle < 4000) {
    const before = m.stats.robFull;
    const info = m.step();
    served += info.committed.length;
    frames.push({
      cycle: info.cycle,
      rob: m.robList.map((u) => ({ seq: u.seq, text: u.text, state: u.state === 'queued' ? 'queued' : u.state === 'issued' ? 'issued' : 'done', port: u.port, wrong: u.wrong })),
      waiting: m.fd.length,
      served,
      out: info.committed.map((u) => u.seq),
      full: m.stats.robFull > before,
    });
  }
  r = { frames, cycles: m.stats.cycles, instructions: m.stats.instructions, robFull: m.stats.robFull };
  kitchenCache.set(key, r);
  return r;
}

/** Cycles the whole program takes at a window size, and in order (the same core, one dish at a time through the pass). */
export const kitchenCycles = (program: string, rob: number): number => oooRun(kitchenWords(program), kitchenConfig(rob), KITCHEN_OPTS).cycles;

// ---- squad: chapter "simt", split and join ----

export type SquadCond = 'all' | 'half' | 'one';
export const SQUAD_LANES = 4;
export const SQUAD_CONDS: { id: SquadCond; label: string; who: string }[] = [
  { id: 'all', label: 'Everyone', who: 'all four lanes take the "odd" path' },
  { id: 'half', label: 'Odd lanes', who: 'lanes 1 and 3 take the "odd" path, 0 and 2 the other' },
  { id: 'one', label: 'Lane 0 only', who: 'lane 0 takes the "odd" path, 1 to 3 the other' },
];

/** simtprograms.ts's 'diverge' with the line that makes the condition (t1 = lane & 1) swapped for the chosen one. */
export function squadSource(cond: SquadCond): string {
  const src = SIMT_PROGRAMS.find((p) => p.id === 'diverge')!.source;
  const line = '        andi  t1, t0, 1\n';
  if (!src.includes(line)) throw new Error('diverge: the condition line moved');
  const swap = cond === 'half' ? line : cond === 'all' ? '        li    t1, 1\n' : '        seqz  t1, t0\n';
  return src.replace(line, swap);
}

export interface SquadStep { text: string; mask: number; cycles: number }
export interface SquadRun { steps: SquadStep[]; utilization: number; slots: number }

const squadCache = new Map<SquadCond, SquadRun>();
export function squadRun(cond: SquadCond): SquadRun {
  let r = squadCache.get(cond);
  if (r) return r;
  const w = new SimtISS(assemble(squadSource(cond)).words, { lanes: SQUAD_LANES });
  const steps: SquadStep[] = [];
  while (!w.halted && steps.length < 200) {
    const s = w.step();
    steps.push({ text: s.text, mask: s.mask, cycles: s.cycles });
  }
  r = { steps, utilization: w.utilization, slots: steps.length };
  squadCache.set(cond, r);
  return r;
}

export const laneOn = (mask: number, lane: number): boolean => ((mask >>> lane) & 1) === 1;
export { popcount };

// ---- movers: chapter "bus", the DMA engine ----
// Timing measured on the gate-level bus bench (lib/axi.ts busBench; tests/analogyfigs-h.test.ts runs it): a RAM
// transaction takes 2 cycles, a flash read FLASH_TIMES.read + 2 for the first word of a 16-word page and 3 after it.
// The arbiter serves the other master next when both ask.

export const DMA_PAGE_WORDS = 16;
export type MoveSource = 'ram' | 'flash';
export const MOVE_LENGTHS = [4, 16, 32] as const;
/** The CPU loop the figure runs: this many ALU instructions, then a load from RAM (an assumption of the figure). */
export const MOVE_GAP = 3;

const readCycles = (src: MoveSource, i: number): number => (src === 'ram' ? 2 : i % DMA_PAGE_WORDS === 0 ? FLASH_TIMES.read + 2 : 3);
const WRITE_CYCLES = 2;

export type Owner = 'cpu' | 'dma' | 'idle';
export interface MoveRun {
  /** Who holds the bus each cycle until the interrupt. */
  owner: Owner[];
  /** Instructions the CPU has finished after each cycle (index = cycles elapsed). */
  cpu: number[];
  /** Words the DMA has written after each cycle. */
  words: number[];
  /** Cycle the last word lands and irq rises. */
  irqAt: number;
  /** Cycles each CPU load took, from its request to its data. */
  loads: number[];
}

/** The copy from the go store, cycle by cycle: the CPU runs `gap` ALU instructions and a load from RAM, over and over
 *  (gap < 0: no CPU); the DMA reads and writes a word at a time; one transaction holds the bus, round robin on a conflict. */
export function moveRun(len: number, src: MoveSource, gap = MOVE_GAP, cpuFirst = true, limit = 0): MoveRun {
  const total = Array.from({ length: len }, (_, i) => [readCycles(src, i), WRITE_CYCLES]).flat();
  const owner: Owner[] = [], cpu: number[] = [0], words: number[] = [0], loads: number[] = [];
  let t = 0, busyUntil = 0, who: Owner = 'idle', next = 0, instr = 0, written = 0, alu = 0, reqAt = -1;
  let prio: 'cpu' | 'dma' = cpuFirst ? 'cpu' : 'dma';
  const cpuOn = gap >= 0;
  for (; len ? written < len : t < limit; t++) {
    if (who !== 'idle' && t >= busyUntil) {
      if (who === 'dma') { if (next % 2 === 0) written++; }
      else { instr++; loads.push(t - reqAt); reqAt = -1; }
      who = 'idle';
      if (len && written === len) break;
    }
    // the CPU's ALU instructions take a cycle each while it is not waiting on or using the bus
    if (cpuOn && who !== 'cpu' && reqAt < 0) {
      if (alu < gap) { alu++; instr++; } else { reqAt = t; alu = 0; }
    }
    if (who === 'idle') {
      const wantCpu = reqAt >= 0, wantDma = next < total.length;
      let g: Owner = 'idle';
      if (wantCpu && wantDma) { g = prio; prio = prio === 'cpu' ? 'dma' : 'cpu'; } else if (wantCpu) g = 'cpu'; else if (wantDma) g = 'dma';
      if (g === 'dma') { busyUntil = t + total[next]; next++; who = 'dma'; }
      else if (g === 'cpu') { busyUntil = t + 2; who = 'cpu'; }
    }
    owner.push(who);
    cpu.push(instr);
    words.push(written);
  }
  return { owner, cpu, words, irqAt: t, loads };
}

/** Instructions the figure's CPU finishes in n cycles with the bus to itself (the count the copy takes away from). */
export const cpuAlone = (cycles: number): number[] => moveRun(0, 'ram', MOVE_GAP, true, cycles).cpu;

// ---- doorbell: chapter "traps", the timer interrupt ----
// Both timelines are the golden model's own: the chapter's timer program (sysprograms.ts) with its interrupt, and the
// same program polling mtime against mtimecmp instead.

export type Slice = 'work' | 'check' | 'service' | 'trap';
export interface DoorRun {
  /** What the CPU did each cycle after the set-up. */
  slices: Slice[];
  /** Cycle each visitor arrived (mtime reaches mtimecmp), relative to the same origin. */
  arrivals: number[];
  /** Cycles from each arrival to the first cycle of its service (the handler, or the polling code). */
  delays: number[];
  /** Cycles not spent working, as a share. */
  idle: number;
}

const TIMER_SRC = SYSTEM_PROGRAMS.find((p) => p.id === 'timer')!.source;
const doorCache = new Map<string, DoorRun>();

/** Interrupt-driven: the chapter's program with a visitor every `every` cycles (it uses 40). */
export function interruptSource(every: number): string {
  if (!TIMER_SRC.includes('addi t1, t1, 40')) throw new Error('timer: the period moved');
  return TIMER_SRC.replaceAll('addi t1, t1, 40', `addi t1, t1, ${every}`);
}

/** The same visitors polled: `work` instructions, then mtime against mtimecmp; the service is the handler's body. */
export function pollSource(every: number, work: number): string {
  return `        li   a0, 0x80000000
        lw   t1, 16(a0)        # mtime
        addi t1, t1, ${every}
        sw   t1, 20(a0)        # mtimecmp = now + ${every}
loop:   ${'addi s0, s0, 1\n        '.repeat(work).trimEnd()}
check:  lw   t1, 16(a0)        # mtime
        lw   t3, 20(a0)        # mtimecmp
        bltu t1, t3, loop      # not yet
serve:  li   t2, '.'
        sb   t2, 0(a0)
        lw   t1, 20(a0)
        addi t1, t1, ${every}
        sw   t1, 20(a0)
        addi s1, s1, 1
        j    loop`;
}

/** `cycles` cycles of the program, classified by where the golden model's PC is; the origin is the loop's first cycle. */
function doorTrace(src: string, cycles: number, polling: boolean): DoorRun {
  const a = assemble(src);
  if (a.errors?.length) throw new Error(String(a.errors[0]));
  const L = a.labels as Map<string, number>;
  const iss = new ISS(a.words, { system: true, mmio: true } as never);
  const loop = L.get('loop')!, check = L.get('check') ?? -1, serve = L.get('serve') ?? -1, handler = L.get('handler') ?? -1;
  let started = -1, origin = 0, cmp0 = -1;
  const slices: Slice[] = [];
  const total = cycles + 400;
  for (let i = 0; i < total && slices.length < cycles; i++) {
    const pc = iss.pc, t = iss.mtime;
    if (started < 0 && pc === loop) { started = t; origin = t; cmp0 = iss.mtimecmp; }
    const s = iss.step();
    if (started < 0) continue;
    if (s.text === 'interrupt') slices.push('trap');
    else if (polling) slices.push(pc >= serve ? 'service' : pc >= check ? 'check' : 'work');
    else slices.push(pc >= handler ? 'service' : 'work');
  }
  // arrivals: mtimecmp's first value and every period after, from the program's own increment
  const period = Number(/addi t1, t1, (\d+)/.exec(src)![1]);
  const arrivals: number[] = [];
  for (let c = cmp0 - origin; c < slices.length; c += period) arrivals.push(c);
  const delays: number[] = [];
  for (const arr of arrivals) {
    for (let c = arr; c < slices.length; c++) {
      // the first cycle at or after the arrival that is part of its service: polling code or the trap entry
      const k = slices[c];
      if (c >= arr && (polling ? k === 'service' : k === 'trap')) { delays.push(c - arr); break; }
    }
  }
  return { slices, arrivals, delays, idle: slices.filter((x) => x !== 'work').length / slices.length };
}

export function doorbellRun(mode: 'poll' | 'irq', every: number, work: number, cycles: number): DoorRun {
  const key = `${mode}/${every}/${mode === 'poll' ? work : 0}/${cycles}`;
  let r = doorCache.get(key);
  if (!r) {
    r = mode === 'irq' ? doorTrace(interruptSource(every), cycles, false) : doorTrace(pollSource(every, work), cycles, true);
    doorCache.set(key, r);
  }
  return r;
}

/** Cycles of one visit: the trap entry and handler, one poll that finds nothing, one poll that finds the visitor and
 *  its service. Read from the traces above. */
export function doorCosts(): { trap: number; handler: number; check: number; serve: number } {
  const irq = doorbellRun('irq', 40, 0, 200), poll = doorbellRun('poll', 40, 3, 200);
  const first = (s: Slice[], k: Slice) => s.indexOf(k);
  const run = (s: Slice[], from: number, k: Slice) => { let n = 0; for (let i = from; s[i] === k; i++) n++; return n; };
  return {
    trap: run(irq.slices, first(irq.slices, 'trap'), 'trap'),
    handler: run(irq.slices, first(irq.slices, 'service'), 'service'),
    check: run(poll.slices, first(poll.slices, 'check'), 'check'),
    serve: run(poll.slices, first(poll.slices, 'service'), 'service'),
  };
}

// ---- fourway: chapter "multicore", the arbiter ----

export type Policy = 'first' | 'rr';
export const ARB_MAX = 4;

export interface ArbState { want: number[]; ptr: number; grants: number[]; waited: number[]; n: number }
export const arbStart = (want: number[]): ArbState => ({ want: [...want], ptr: 0, grants: [], waited: want.map(() => 0), n: want.length });

/** One cycle: the cores with `want` > 0 request. First come: the lowest core that asks (the arbiter sees only the
 *  request wires, so "first" can only be a fixed order). Round robin: arbiterN's policy (the first request at or after
 *  the pointer; on a conflict the pointer moves past the winner). Returns the winner (-1: none). */
export function arbStep(st: ArbState, policy: Policy): ArbState & { grant: number } {
  const r = st.want.map((w) => w > 0);
  let g = -1;
  if (policy === 'first') g = r.indexOf(true);
  else for (let k = 0; k < st.n; k++) { const i = (st.ptr + k) % st.n; if (r[i]) { g = i; break; } }
  const conflict = r.filter(Boolean).length > 1;
  const want = st.want.map((w, i) => (i === g ? w - 1 : w));
  const waited = st.waited.map((w, i) => (r[i] && i !== g ? w + 1 : w));
  return { want, ptr: policy === 'rr' && conflict ? (g + 1) % st.n : st.ptr, grants: g < 0 ? st.grants : [...st.grants, g], waited, n: st.n, grant: g };
}

/** Grants until every request is served (capped). */
export function arbRun(want: number[], policy: Policy): number[] {
  let s = arbStart(want);
  for (let i = 0; i < 64 && s.want.some((w) => w > 0); i++) s = arbStep(s, policy);
  return s.grants;
}

/** Longest stretch a core with requests left waited between two grants (or from the start). */
export function arbMaxWait(grants: number[], want: number[], core: number): number {
  let wait = 0, best = 0, left = want[core];
  for (const g of grants) {
    if (left === 0) break;
    if (g === core) { best = Math.max(best, wait); wait = 0; left--; } else wait++;
  }
  return best;
}
export { disasm };
