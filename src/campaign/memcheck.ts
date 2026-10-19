// The benches of act 10's clocked levels (roadmap Phase 16e). The device a level drives sits on the bench as a
// JS model that knows its rules and names the first one broken: the cell array of m_bank (rows that leak unless
// they are opened in time), the DRAM chip of m_ctrl (timings, refresh), the memory behind m_dma's bus port (wait states),
// the flash chip of m_flash (a page programs once, a block erases whole). Each lane of a BitSim runs one request
// trace or program of copies with its own device; a request is held until the chip completes it. No DOM.

import type { CustomRun } from '../editor/challenges';
import { BitSim } from '../sim/bitsim';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';

const hex = (v: number, d = 4) => `0x${(v >>> 0).toString(16).padStart(d, '0')}`;

/** A request of a trace: read or write a word, then wait `gap` idle cycles before the next. */
export interface MemReq { addr: number; we: boolean; wd: number; gap: number }
export interface MemTrace { name: string; reqs: MemReq[]; /** Idle cycles before the first request. */ lead?: number }

/** What the lanes found: each failing trace's first problem, and the cycles of every trace summed. */
interface LaneRun { failures: string[]; failed: number[]; cycles: number }

function simOf(def: ComponentDef, pins: string[]): BitSim | string {
  const have = new Set(def.ports.map((p) => p.name));
  const missing = pins.filter((p) => !have.has(p));
  if (missing.length) return `missing pins: ${missing.join(', ')}`;
  try {
    return new BitSim(flatten(def, { mode: 'gate' }));
  } catch (e) {
    return `cannot simulate: ${(e as Error).message}`;
  }
}

function periodOf(def: ComponentDef): number | undefined {
  try { return analyzeTiming(flatten(def, { mode: 'gate' }))?.period ?? undefined; } catch { return undefined; }
}

/** The period only for a chip that passes (static timing of a large one takes a moment). */
function report(r: LaneRun, tested: number, def: ComponentDef): CustomRun {
  const f = r.failures;
  return {
    failures: f.slice(0, 6).concat(f.length > 6 ? [`… and ${f.length - 6} more traces fail`] : []), tested, cycles: r.cycles, failed: r.failed,
    ...(f.length ? {} : (() => { const p = periodOf(def); return p ? { period: p } : {}; })()),
  };
}

/** The request side of a lane: presents its trace's requests, one at a time, until each completes. */
class Requester {
  i = 0;
  wait: number;
  done = -1;
  constructor(readonly t: MemTrace) { this.wait = t.lead ?? 0; }
  get cur(): MemReq | undefined { return this.wait > 0 ? undefined : this.t.reqs[this.i]; }
  /** End of a cycle: the current request completed (or not). */
  advance(completed: boolean, cycle: number): void {
    if (this.wait > 0) { this.wait--; return; }
    if (!completed) return;
    this.wait = this.t.reqs[this.i].gap;
    if (++this.i === this.t.reqs.length) this.done = cycle + 1;
  }
}

// ---- m_bank: a bank of cells with refresh ------------------------------------------------------------------

/** The array of m_bank: 16 rows of 16 words; a row leaks unless it is opened at least every RET cycles. */
export const BANK = { rows: 16, cols: 16, RET: 288 } as const;
/** Array commands (cmd). */
export const ACMD = { NOP: 0, ACT: 1, PRE: 2, RW: 3 } as const;
const ACMD_NAMES = ['NOP', 'ACT', 'PRE', 'RW'];

export class ArrayModel {
  readonly mem: Uint16Array;
  open = -1;
  /** Per row: the cycle its cells were last at full level (opened, or held open). */
  readonly restored: number[];
  why = '';
  constructor(seed: number) {
    const r = rng(seed);
    this.mem = Uint16Array.from({ length: BANK.rows * BANK.cols }, () => Math.floor(r() * 0x10000));
    this.restored = new Array<number>(BANK.rows).fill(0);
  }
  /** What the array drives on aq during a cycle: the word of a read, junk otherwise. */
  aq(cmd: number, ca: number, aw: number, cycle: number): number {
    if (cmd === ACMD.RW && !aw && this.open >= 0) return this.mem[this.open * BANK.cols + ca];
    return (0x5a5a ^ (cycle * 0x9e37)) & 0xffff;
  }
  /** The rising edge at the end of `cycle`. */
  edge(cmd: number, ra: number, ca: number, aw: number, ad: number, cycle: number): void {
    const fail = (w: string) => { if (!this.why) this.why = `cycle ${cycle}: ${w}`; };
    if (this.open >= 0) this.restored[this.open] = cycle;
    switch (cmd) {
      case ACMD.ACT:
        if (this.open >= 0) fail(`ACT row ${ra} with row ${this.open} open: precharge it first (PRE)`);
        else { this.open = ra; this.restored[ra] = cycle; }
        break;
      case ACMD.PRE: this.open = -1; break;
      case ACMD.RW:
        if (this.open < 0) fail(`RW (${aw ? 'write' : 'read'} word ${ca}) with no row open: activate one first (ACT)`);
        else if (aw) this.mem[this.open * BANK.cols + ca] = ad;
        break;
    }
    for (let row = 0; row < BANK.rows; row++) {
      if (cycle - this.restored[row] > BANK.RET) fail(`row ${row} was last opened at cycle ${this.restored[row]}: its cells leaked away (each row must be opened at least every ${BANK.RET} cycles)`);
    }
  }
}

export const BANK_PINS = ['addr', 'wd', 're', 'we', 'clk', 'rst', 'rd', 'busy', 'cmd', 'ra', 'ca', 'aw', 'ad', 'aq'];

/** m_bank's traces: runs along a row, random words, rows taking turns, long idle stretches, no idle at all. */
export function bankTraces(): MemTrace[] {
  const r = rng(101);
  const rnd = (n: number) => Math.floor(r() * n);
  const req = (addr: number, we: boolean, gap: number): MemReq => ({ addr: addr & 0xff, we, wd: rnd(0x10000), gap });
  const mk = (name: string, n: number, f: (i: number) => MemReq, lead = 0): MemTrace => ({ name, lead, reqs: Array.from({ length: n }, (_, i) => f(i)) });
  return [
    mk('a run along the rows', 160, (i) => req(i, i % 3 === 0, rnd(2))),
    mk('random words', 140, () => req(rnd(256), r() < 0.4, rnd(3))),
    mk('two rows taking turns', 120, (i) => req((i & 1 ? 0x30 : 0xc0) + (i >> 1) % 16, r() < 0.5, rnd(2))),
    mk('written, then read back', 128, (i) => req((i % 64) * 4 + (i >> 6), i < 64, 0)),
    mk('long pauses', 40, () => req(rnd(256), r() < 0.5, 20 + rnd(60)), 350),
    mk('no pause at all', 300, (i) => req(i * 7 + (i >> 4), r() < 0.3, 0)),
    mk('one row, over and over', 200, (i) => req(0x50 + (i % 16), i % 5 === 0, rnd(4))),
    mk('reads only, scattered', 150, () => req(rnd(256), false, rnd(2))),
  ];
}

export function runBank(def: ComponentDef, mode: 'gate' | 'switch', traces = bankTraces()): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the bank must simulate at gate level'], tested: 0 };
  const sim = simOf(def, BANK_PINS);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const n = traces.length, lanes = traces.map((t) => new Requester(t));
  const dev = traces.map((_, l) => new ArrayModel(200 + l));
  const ref = dev.map((d) => Uint16Array.from(d.mem));
  const why: string[] = new Array<string>(n).fill('');
  const limit = Math.max(...traces.map((t) => (t.lead ?? 0) + t.reqs.reduce((s, q) => s + q.gap + 8, 0))) * 2 + 200;
  const per = (f: (l: number) => number) => Array.from({ length: n }, (_, l) => f(l));
  // cycle 0: reset
  sim.setInput('rst', 1); sim.setInput('re', 0); sim.setInput('we', 0); sim.setInput('aq', 0); sim.cycle(); sim.setInput('rst', 0);
  for (let c = 1; c < limit && lanes.some((q, l) => q.done < 0 && !why[l]); c++) {
    const cur = lanes.map((q) => q.cur);
    sim.setInput('addr', per((l) => cur[l]?.addr ?? 0));
    sim.setInput('wd', per((l) => cur[l]?.wd ?? 0));
    sim.setInput('re', per((l) => (cur[l] && !cur[l]!.we ? 1 : 0)));
    sim.setInput('we', per((l) => (cur[l]?.we ? 1 : 0)));
    sim.settle();
    const cmd = sim.get('cmd', n), ca = sim.get('ca', n), aw = sim.get('aw', n), ra = sim.get('ra', n), ad = sim.get('ad', n);
    sim.setInput('aq', per((l) => dev[l].aq(cmd[l], ca[l], aw[l], c)));
    sim.settle();
    const busy = sim.get('busy', n), rd = sim.get('rd', n);
    for (let l = 0; l < n; l++) {
      if (why[l] || lanes[l].done >= 0) continue;
      const q = cur[l], d = dev[l];
      const completed = !!q && !busy[l];
      if (completed) {
        const row = q.addr >> 4, col = q.addr & 15;
        const what = `${q.we ? 'write' : 'read'} of ${hex(q.addr, 2)} (row ${row}, word ${col})`;
        if (cmd[l] !== ACMD.RW || d.open !== row || ca[l] !== col || aw[l] !== (q.we ? 1 : 0)) {
          why[l] = `cycle ${c}: the ${what} completed (busy = 0), but the array got ${ACMD_NAMES[cmd[l]]}${cmd[l] === ACMD.RW ? ` ${aw[l] ? 'write' : 'read'} word ${ca[l]}` : ''}${d.open >= 0 ? ` with row ${d.open} open` : ' with no row open'}`;
        } else if (q.we && ad[l] !== q.wd) why[l] = `cycle ${c}: the ${what} wrote ${hex(ad[l])} instead of ${hex(q.wd)}`;
        else if (!q.we && rd[l] !== ref[l][q.addr]) why[l] = `cycle ${c}: the ${what} gave rd = ${hex(rd[l])}; the word is ${hex(ref[l][q.addr])}`;
        if (q.we) ref[l][q.addr] = q.wd;
      } else if (cmd[l] === ACMD.RW && aw[l]) why[l] = `cycle ${c}: a write to word ${ca[l]} of the open row that no request asked for`;
      d.edge(cmd[l], ra[l], ca[l], aw[l], ad[l], c);
      if (!why[l] && d.why) why[l] = d.why;
      lanes[l].advance(completed, c);
    }
    sim.cycle();
  }
  return finish(lanes, why, limit, def);
}

/** Every lane's verdict: its first failure, or stuck, else the cycles its trace took (summed). */
function finish(lanes: Requester[], why: string[], limit: number, def: ComponentDef): CustomRun {
  const out: LaneRun = { failures: [], failed: [], cycles: 0 };
  lanes.forEach((q, l) => {
    const w = why[l] || (q.done < 0 ? `stuck: request ${q.i + 1} of ${q.t.reqs.length} never completed in ${limit} cycles` : '');
    if (w) { out.failures.push(`trace ${l + 1} (${q.t.name}): ${w}`); out.failed.push(l); }
    out.cycles += Math.max(0, q.done);
  });
  return report(out, lanes.length, def);
}

// ---- m_ctrl: a DRAM chip with timings --------------------------------------------------------------------

/** m_ctrl's chip: two banks of 64 rows of 16 words; chapter 35's timings (DDR4-3200 at our clock), one word per command. */
export const DRAM16 = { banks: 2, rows: 64, cols: 16, tRCD: 4, tCAS: 4, tRP: 4, tRAS: 9, tRFC: 12, tREFI: 256 } as const;
/** Chip commands (cmd), chapter 35's encoding. */
export const DCMD = { NOP: 0, ACT: 1, RD: 2, WR: 3, PRE: 4, PREA: 5, REF: 6 } as const;
export const DCMD_NAMES = ['NOP', 'ACT', 'RD', 'WR', 'PRE', 'PREA', 'REF', '7'];

/** addr = row (6 bits) · bank · column (4 bits). */
export const splitAddr16 = (a: number) => ({ col: a & 15, bank: (a >> 4) & 1, row: (a >> 5) & 63 });

export class Dram16Model {
  readonly mem: Uint16Array;
  readonly open: number[] = [-1, -1];
  readonly lastAct = [-1e9, -1e9];
  readonly lastPre = [-1e9, -1e9];
  lastRef = 0;
  /** The cycle the last REF was issued (none yet: power-on starts the refresh interval, not tRFC). */
  refAt = -1e9;
  /** Reads in flight: the word is on dq during cycle `at`. */
  private reads: { at: number; addr: number }[] = [];
  why = '';
  constructor(seed: number) {
    const r = rng(seed);
    this.mem = Uint16Array.from({ length: DRAM16.banks * DRAM16.rows * DRAM16.cols }, () => Math.floor(r() * 0x10000));
  }
  /** The word address of (bank, row, col): the controller's address, as it splits it. */
  static addr(bank: number, row: number, col: number): number { return (row << 5) | (bank << 4) | col; }
  /** What dq holds during `cycle`: a read's word tCAS cycles after its RD, junk otherwise. */
  dq(cycle: number): { v: number; addr: number } {
    const q = this.reads.find((x) => x.at === cycle);
    return q ? { v: this.mem[q.addr], addr: q.addr } : { v: (0xa5a5 ^ (cycle * 0x61c9)) & 0xffff, addr: -1 };
  }
  /** The rising edge at the end of `cycle`. */
  edge(cmd: number, ba: number, ra: number, ca: number, dd: number, cycle: number): void {
    const t = DRAM16, now = cycle;
    const fail = (w: string) => { if (!this.why) this.why = `cycle ${now}: ${w}`; };
    this.reads = this.reads.filter((x) => x.at > now);
    if (cmd !== DCMD.NOP && now - this.refAt < t.tRFC) fail(`${DCMD_NAMES[cmd]} ${now - this.refAt} cycles after REF: the chip is refreshing for tRFC = ${t.tRFC} cycles`);
    switch (cmd) {
      case DCMD.NOP: break;
      case DCMD.ACT:
        if (this.open[ba] >= 0) fail(`ACT bank ${ba} row ${ra} with row ${this.open[ba]} open: precharge it first (PRE)`);
        else if (now - this.lastPre[ba] < t.tRP) fail(`ACT bank ${ba} ${now - this.lastPre[ba]} cycles after its PRE (tRP = ${t.tRP}: the bit lines are not back at VDD/2)`);
        this.open[ba] = ra;
        this.lastAct[ba] = now;
        break;
      case DCMD.RD: case DCMD.WR: {
        const name = DCMD_NAMES[cmd];
        if (this.open[ba] < 0) { fail(`${name} bank ${ba} with no row open: activate one first (ACT)`); break; }
        if (now - this.lastAct[ba] < t.tRCD) fail(`${name} bank ${ba} ${now - this.lastAct[ba]} cycles after its ACT (tRCD = ${t.tRCD}: the sense amplifiers have not settled)`);
        const a = Dram16Model.addr(ba, this.open[ba], ca);
        if (cmd === DCMD.WR) this.mem[a] = dd;
        else this.reads.push({ at: now + t.tCAS, addr: a });
        break;
      }
      case DCMD.PRE: case DCMD.PREA:
        for (let b = 0; b < t.banks; b++) {
          if (cmd === DCMD.PRE && b !== ba) continue;
          if (this.open[b] >= 0 && now - this.lastAct[b] < t.tRAS) fail(`${DCMD_NAMES[cmd]} closes bank ${b} ${now - this.lastAct[b]} cycles after its ACT (tRAS = ${t.tRAS}: the row is still being restored)`);
          if (this.open[b] >= 0) this.lastPre[b] = now;
          this.open[b] = -1;
        }
        break;
      case DCMD.REF:
        if (this.open.some((r) => r >= 0)) fail('REF with a bank open: close every bank first (PREA)');
        else if (this.lastPre.some((p) => now - p < t.tRP)) fail(`REF ${Math.min(...this.lastPre.map((p) => now - p))} cycles after a PRE (tRP = ${t.tRP})`);
        this.lastRef = this.refAt = now;
        break;
      default: fail(`unknown command ${cmd}`);
    }
    if (now - this.lastRef > t.tREFI) fail(`no REF for ${now - this.lastRef} cycles: the chip needs one at least every ${t.tREFI} cycles, or its rows leak away`);
  }
}

export const CTRL_PINS = ['req', 'addr', 'wd', 'we', 'clk', 'rst', 'dq', 'ready', 'rd', 'cmd', 'ba', 'ra', 'ca', 'dd'];

/** m_ctrl's traces: runs along a row, both banks taking turns, row conflicts, random, idle stretches, writes then reads. */
export function ctrlTraces(): MemTrace[] {
  const r = rng(111);
  const rnd = (n: number) => Math.floor(r() * n);
  const req = (addr: number, we: boolean, gap: number): MemReq => ({ addr: addr & 0x7ff, we, wd: rnd(0x10000), gap });
  const A = Dram16Model.addr;
  const mk = (name: string, n: number, f: (i: number) => MemReq, lead = 0): MemTrace => ({ name, lead, reqs: Array.from({ length: n }, (_, i) => f(i)) });
  return [
    mk('a run along the rows', 120, (i) => req(i, i % 4 === 0, rnd(2))),
    mk('two streams, one per bank', 120, (i) => req(A(i & 1, 7 + (i & 1), (i >> 1) & 15), i % 3 === 0, rnd(2))),
    mk('row conflicts in one bank', 60, (i) => req(A(0, (i % 3) * 9, rnd(16)), r() < 0.5, rnd(3))),
    mk('random words', 100, () => req(rnd(2048), r() < 0.4, rnd(3))),
    mk('written, then read back', 96, (i) => req(A((i >> 3) & 1, 40 + (i % 3), i % 16), i < 48, 0)),
    mk('long pauses', 30, () => req(rnd(2048), r() < 0.5, 30 + rnd(60)), 300),
    mk('no pause at all', 200, (i) => req(i * 13 + (i >> 3), r() < 0.3, 0)),
    mk('one row, over and over', 150, (i) => req(A(1, 33, i % 16), i % 5 === 0, rnd(3))),
  ];
}

export function runCtrl(def: ComponentDef, mode: 'gate' | 'switch', traces = ctrlTraces()): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the controller must simulate at gate level'], tested: 0 };
  const sim = simOf(def, CTRL_PINS);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const n = traces.length, lanes = traces.map((t) => new Requester(t));
  const dev = traces.map((_, l) => new Dram16Model(300 + l));
  const ref = dev.map((d) => Uint16Array.from(d.mem));
  const why: string[] = new Array<string>(n).fill('');
  const limit = Math.max(...traces.map((t) => (t.lead ?? 0) + t.reqs.reduce((s, q) => s + q.gap + 40, 0))) * 2 + 400;
  const per = (f: (l: number) => number) => Array.from({ length: n }, (_, l) => f(l));
  sim.setInput('rst', 1); sim.setInput('req', 0); sim.setInput('dq', 0); sim.cycle(); sim.setInput('rst', 0);
  for (let c = 1; c < limit && lanes.some((q, l) => q.done < 0 && !why[l]); c++) {
    const cur = lanes.map((q) => q.cur), dq = dev.map((d) => d.dq(c));
    sim.setInput('req', per((l) => (cur[l] ? 1 : 0)));
    sim.setInput('addr', per((l) => cur[l]?.addr ?? 0));
    sim.setInput('wd', per((l) => cur[l]?.wd ?? 0));
    sim.setInput('we', per((l) => (cur[l]?.we ? 1 : 0)));
    sim.setInput('dq', per((l) => dq[l].v));
    sim.settle();
    const ready = sim.get('ready', n), rd = sim.get('rd', n), cmd = sim.get('cmd', n), ba = sim.get('ba', n), ra = sim.get('ra', n), ca = sim.get('ca', n), dd = sim.get('dd', n);
    for (let l = 0; l < n; l++) {
      if (why[l] || lanes[l].done >= 0) continue;
      const q = cur[l], d = dev[l];
      const completed = !!q && !!ready[l];
      if (completed) {
        const { bank, row, col } = splitAddr16(q.addr);
        const what = `${q.we ? 'write' : 'read'} of ${hex(q.addr, 3)} (bank ${bank}, row ${row}, word ${col})`;
        if (q.we) {
          if (cmd[l] !== DCMD.WR || ba[l] !== bank || d.open[bank] !== row || ca[l] !== col) why[l] = `cycle ${c}: the ${what} is ready, but the chip got ${DCMD_NAMES[cmd[l]]}${cmd[l] === DCMD.WR ? ` bank ${ba[l]} word ${ca[l]} (row ${d.open[ba[l]]} open)` : ''}`;
          else if (dd[l] !== q.wd) why[l] = `cycle ${c}: the ${what} sent dd = ${hex(dd[l])} instead of ${hex(q.wd)}`;
          ref[l][q.addr] = q.wd;
        } else if (dq[l].addr !== q.addr) {
          why[l] = `cycle ${c}: the ${what} is ready, but ${dq[l].addr < 0 ? `no read data is on dq this cycle (it comes tCAS = ${DRAM16.tCAS} cycles after RD)` : `dq holds word ${hex(dq[l].addr, 3)}`}`;
        } else if (rd[l] !== ref[l][q.addr]) why[l] = `cycle ${c}: the ${what} gave rd = ${hex(rd[l])}; the word is ${hex(ref[l][q.addr])}`;
      } else if (cmd[l] === DCMD.WR) why[l] = `cycle ${c}: a WR that no ready write request matches (a write is ready in the cycle of its WR)`;
      d.edge(cmd[l], ba[l], ra[l], ca[l], dd[l], c);
      if (!why[l] && d.why) why[l] = d.why;
      lanes[l].advance(completed, c);
    }
    sim.cycle();
  }
  return finish(lanes, why, limit, def);
}

// ---- m_dma: a DMA engine on the bus ------------------------------------------------------------------------

/** A copy the bench programs: len words from src to dst (the ranges never overlap). */
export interface DmaJob { src: number; dst: number; len: number }
/** A lane of m_dma's bench: its copies and its memory's wait states (per transfer, before ready). */
export interface DmaTrace { name: string; jobs: DmaJob[]; waits: () => number }

export const DMA_PINS = ['cw', 'ca', 'cd', 'clk', 'rst', 'mr', 'mq', 'mv', 'ma', 'md', 'mw', 'irq', 'busy'];

export function dmaTraces(): DmaTrace[] {
  const r = rng(131);
  const rnd = (n: number) => Math.floor(r() * n);
  const jobs = (): DmaJob[] => [
    { src: 0x0100, dst: 0x0200, len: 1 },
    { src: 0x0300, dst: 0x0310, len: 16 },
    { src: 0x8000 + rnd(0x100), dst: 0x4000 + rnd(0x100), len: 37 },
    { src: 0x1000, dst: 0x2000, len: 0 },
    { src: 0xfff0, dst: 0x0040, len: 12 },
  ];
  const fixed = (w: number) => () => w;
  const rand = (seed: number, max: number) => { const q = rng(seed); return () => Math.floor(q() * (max + 1)); };
  return [
    { name: 'memory ready at once', jobs: jobs(), waits: fixed(0) },
    { name: 'one wait state', jobs: jobs(), waits: fixed(1) },
    { name: 'three wait states', jobs: jobs(), waits: fixed(3) },
    { name: 'random wait states', jobs: jobs(), waits: rand(1, 3) },
    { name: 'random, up to 6', jobs: jobs(), waits: rand(2, 6) },
    { name: 'mostly fast, now and then slow', jobs: jobs(), waits: ((q) => () => (q() < 0.15 ? 5 : 0))(rng(3)) },
  ];
}

/** One lane: the program (src, dst, len, wait for irq and check, clear irq) and the memory behind the bus. */
class DmaLane {
  readonly mem = new Map<number, number>();
  job = 0;
  /** Where the current job is: 0–2 its configuration writes, 3 copying, 4 clearing irq, 5 irq must be down. */
  step = 0;
  start = 0;
  cycles = 0;
  why = '';
  /** The transfer waiting for ready: its request, and the wait states left. */
  pending: { a: number; w: boolean; d: number; left: number } | null = null;
  transfers = 0;
  done = false;
  constructor(readonly t: DmaTrace) {}
  word(a: number): number { return this.mem.get(a) ?? (Math.imul(a, 2654435761) >>> 16) & 0xffff; }
  /** The configuration write of this cycle, if any. */
  cfg(): { cw: number; ca: number; cd: number } {
    const j = this.t.jobs[this.job];
    if (this.done || this.why) return { cw: 0, ca: 0, cd: 0 };
    if (this.step < 3) return { cw: 1, ca: this.step, cd: [j.src, j.dst, j.len][this.step] };
    if (this.step === 4) return { cw: 1, ca: 3, cd: 0 };
    return { cw: 0, ca: 0, cd: 0 };
  }
  /** The memory this cycle, for the request the DMA shows: ready after its wait states, the word at its address. */
  ready(mv: number, ma: number, mw: number, md: number): { mr: number; mq: number } {
    if (!mv || this.done || this.why) return { mr: 0, mq: 0 };
    if (!this.pending) this.pending = { a: ma, w: !!mw, d: md, left: this.t.waits() };
    return { mr: this.pending.left === 0 ? 1 : 0, mq: this.word(ma) };
  }
  /** End of a cycle, with what the chip showed in it. */
  check(c: number, cfgWrite: boolean, mv: number, ma: number, mw: number, md: number, mr: number, irq: number, busy: number): void {
    const j = this.t.jobs[this.job], step = this.step, p = this.pending;
    const at = `cycle ${c}, copy ${this.job + 1} (${j.len} word${j.len === 1 ? '' : 's'} from ${hex(j.src)} to ${hex(j.dst)})`;
    if (p && !mv) return void (this.why = `${at}: valid fell before the memory was ready (${p.w ? 'write' : 'read'} ${hex(p.a)})`);
    if (p && (ma !== p.a || !!mw !== p.w || (p.w && md !== p.d))) return void (this.why = `${at}: the request changed while the memory was not ready (${p.w ? 'write' : 'read'} ${hex(p.a)} became ${mw ? 'write' : 'read'} ${hex(ma)}): hold the address and data until ready`);
    if (mv && step !== 3) return void (this.why = `${at}: a bus request (${mw ? 'write' : 'read'} ${hex(ma)}) while no copy runs`);
    if (p && mr) {
      this.transfers++;
      if (p.w) {
        if (((p.a - j.dst) & 0xffff) >= j.len) return void (this.why = `${at}: a write to ${hex(p.a)}, outside the destination`);
        this.mem.set(p.a, p.d);
      }
      this.pending = null;
    } else if (p) p.left--;
    if (step < 3) {
      if (cfgWrite && step === 2) this.start = c;
      this.step++;
    } else if (step === 3) {
      if (irq) {
        this.cycles += c - this.start;
        for (let k = 0; k < j.len; k++) {
          const s = this.word((j.src + k) & 0xffff), t = this.word((j.dst + k) & 0xffff);
          if (s !== t) return void (this.why = `${at}: irq is up, but word ${k} at ${hex(j.dst + k)} is ${hex(t)}, not ${hex(s)} (from ${hex(j.src + k)})`);
        }
        if (busy) return void (this.why = `${at}: irq is up while busy is still 1`);
        if (this.transfers !== 2 * j.len) return void (this.why = `${at}: ${this.transfers} bus transfers for ${j.len} words (a read and a write each: ${2 * j.len})`);
        this.step = 4;
      } else if (!busy && c > this.start + 1) this.why = `${at}: busy is 0 but irq has not risen`;
    } else if (step === 4) this.step = 5;
    else if (irq) this.why = `${at}: irq still up after the write to register 3`;
    else {
      this.job++;
      this.step = 0;
      this.transfers = 0;
      if (this.job === this.t.jobs.length) this.done = true;
    }
  }
}

export function runDma(def: ComponentDef, mode: 'gate' | 'switch', traces = dmaTraces()): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the DMA engine must simulate at gate level'], tested: 0 };
  const sim = simOf(def, DMA_PINS);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const n = traces.length, lanes = traces.map((t) => new DmaLane(t));
  const limit = 5000;
  sim.setInput('rst', 1); sim.setInput('cw', 0); sim.setInput('mr', 0); sim.cycle(); sim.setInput('rst', 0);
  for (let c = 1; c < limit && lanes.some((d) => !d.done && !d.why); c++) {
    const cfg = lanes.map((d) => d.cfg());
    sim.setInput('cw', cfg.map((x) => x.cw)); sim.setInput('ca', cfg.map((x) => x.ca)); sim.setInput('cd', cfg.map((x) => x.cd));
    sim.settle();
    const mv = sim.get('mv', n), ma = sim.get('ma', n), mw = sim.get('mw', n), md = sim.get('md', n);
    const bus = lanes.map((d, l) => d.ready(mv[l], ma[l], mw[l], md[l]));
    sim.setInput('mr', bus.map((b) => b.mr)); sim.setInput('mq', bus.map((b) => b.mq));
    sim.settle();
    const irq = sim.get('irq', n), busy = sim.get('busy', n);
    lanes.forEach((d, l) => { if (!d.done && !d.why) d.check(c, !!cfg[l].cw, mv[l], ma[l], mw[l], md[l], bus[l].mr, irq[l], busy[l]); });
    sim.cycle();
  }
  const out: LaneRun = { failures: [], failed: [], cycles: 0 };
  lanes.forEach((d, l) => {
    const w = d.why || (d.done ? '' : `stuck in copy ${d.job + 1}: irq never rose in ${limit} cycles`);
    if (w) { out.failures.push(`lane ${l + 1} (${d.t.name}): ${w}`); out.failed.push(l); }
    out.cycles += d.cycles;
  });
  return report(out, n, def);
}

// ---- m_flash: a page store over flash ----------------------------------------------------------------------

/**
 * m_flash's chip: 4 blocks of 4 pages, a page one 16-bit word plus a 4-bit spare area (tag). Erased, a page reads
 * all ones; programming can only clear bits, so a page is programmed once between erases. Times scaled from chapter
 * 34's (read, program, erase): busy for this many cycles after the command.
 */
export const FLASH16 = { blocks: 4, pages: 4, logical: 8, tR: 2, tP: 6, tE: 20 } as const;
/** Flash commands (fcmd). */
export const FCMD = { NOP: 0, READ: 1, PROG: 2, ERASE: 3 } as const;
const FCMD_NAMES = ['NOP', 'READ', 'PROG', 'ERASE'];

export class Flash16Model {
  readonly data = new Uint16Array(FLASH16.blocks * FLASH16.pages).fill(0xffff);
  readonly tag = new Uint8Array(FLASH16.blocks * FLASH16.pages).fill(15);
  readonly erases = new Array<number>(FLASH16.blocks).fill(0);
  busyUntil = 0;
  /** The last read's page, shown once the read is done (-1: none). */
  private shown = -1;
  why = '';
  /** What the chip shows during `cycle`: busy, and the last read's word and tag once it is no longer busy. */
  out(cycle: number): { fbusy: number; fq: number; fqt: number } {
    const busy = cycle <= this.busyUntil ? 1 : 0;
    if (busy || this.shown < 0) return { fbusy: busy, fq: (0x3c3c ^ (cycle * 0x2f1d)) & 0xffff, fqt: (cycle * 5) & 15 };
    return { fbusy: 0, fq: this.data[this.shown], fqt: this.tag[this.shown] };
  }
  /** The rising edge at the end of `cycle`, with its command. */
  edge(cmd: number, fa: number, fd: number, ft: number, cycle: number): void {
    const fail = (w: string) => { if (!this.why) this.why = `cycle ${cycle}: ${w}`; };
    if (cmd === FCMD.NOP) return;
    if (cycle <= this.busyUntil) return fail(`${FCMD_NAMES[cmd]} while the chip is busy (wait for fbusy = 0)`);
    const blk = fa >> 2;
    switch (cmd) {
      case FCMD.READ: this.shown = fa; this.busyUntil = cycle + FLASH16.tR; break;
      case FCMD.PROG:
        if (this.tag[fa] !== 15 || this.data[fa] !== 0xffff) return fail(`PROG page ${fa} (block ${blk}), which holds data: flash cannot overwrite a page until its block is erased; write it somewhere erased`);
        this.data[fa] = fd; this.tag[fa] = ft & 7;
        this.shown = -1; this.busyUntil = cycle + FLASH16.tP;
        break;
      case FCMD.ERASE:
        for (let p = 0; p < FLASH16.pages; p++) { this.data[blk * FLASH16.pages + p] = 0xffff; this.tag[blk * FLASH16.pages + p] = 15; }
        this.erases[blk]++;
        this.shown = -1; this.busyUntil = cycle + FLASH16.tE;
        break;
    }
  }
}

export const FLASH_PINS = ['lpage', 'wd', 'we', 're', 'clk', 'rst', 'fbusy', 'fq', 'fqt', 'ready', 'rd', 'fcmd', 'fa', 'fd', 'ft'];

/** m_flash's traces: each fills every logical page first (a page never written has no value to read), goes on, and ends reading every page back. */
export function flashTraces(): MemTrace[] {
  const r = rng(141);
  const rnd = (n: number) => Math.floor(r() * n);
  const L = FLASH16.logical;
  const fill = (): MemReq[] => Array.from({ length: L }, (_, i) => ({ addr: i, we: true, wd: rnd(0x10000), gap: 0 }));
  const readAll = (): MemReq[] => Array.from({ length: L }, (_, i) => ({ addr: i, we: false, wd: 0, gap: 0 }));
  const mk = (name: string, n: number, f: (i: number) => MemReq): MemTrace => ({ name, reqs: [...fill(), ...Array.from({ length: n }, (_, i) => f(i)), ...readAll()] });
  const req = (addr: number, we: boolean): MemReq => ({ addr, we, wd: rnd(0x10000), gap: rnd(2) });
  return [
    mk('random writes and reads', 80, () => req(rnd(L), r() < 0.5)),
    mk('one page rewritten, over and over', 60, (i) => req(i % 4 === 3 ? rnd(L) : 5, i % 4 !== 3)),
    mk('every page rewritten in turn', 64, (i) => req(i % L, i % 3 !== 2)),
    mk('reads only, after the fill', 40, () => req(rnd(L), false)),
    mk('two hot pages, two cold', 80, (i) => req(i % 5 === 4 ? 2 + rnd(2) : i & 1, r() < 0.7)),
  ];
}

export function runFlash(def: ComponentDef, mode: 'gate' | 'switch', traces = flashTraces()): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the page store must simulate at gate level'], tested: 0 };
  const sim = simOf(def, FLASH_PINS);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const n = traces.length, lanes = traces.map((t) => new Requester(t));
  const dev = traces.map(() => new Flash16Model());
  const ref = traces.map(() => new Map<number, number>());
  const why: string[] = new Array<string>(n).fill('');
  const limit = Math.max(...traces.map((t) => t.reqs.length)) * 120 + 400;
  const per = (f: (l: number) => number) => Array.from({ length: n }, (_, l) => f(l));
  sim.setInput('rst', 1); sim.setInput('re', 0); sim.setInput('we', 0); sim.setInput('fbusy', 0); sim.cycle(); sim.setInput('rst', 0);
  for (let c = 1; c < limit && lanes.some((q, l) => q.done < 0 && !why[l]); c++) {
    const cur = lanes.map((q) => q.cur), fo = dev.map((d) => d.out(c));
    sim.setInput('lpage', per((l) => cur[l]?.addr ?? 0));
    sim.setInput('wd', per((l) => cur[l]?.wd ?? 0));
    sim.setInput('re', per((l) => (cur[l] && !cur[l]!.we ? 1 : 0)));
    sim.setInput('we', per((l) => (cur[l]?.we ? 1 : 0)));
    sim.setInput('fbusy', fo.map((x) => x.fbusy)); sim.setInput('fq', fo.map((x) => x.fq)); sim.setInput('fqt', fo.map((x) => x.fqt));
    sim.settle();
    const ready = sim.get('ready', n), rd = sim.get('rd', n), fcmd = sim.get('fcmd', n), fa = sim.get('fa', n), fd = sim.get('fd', n), ft = sim.get('ft', n);
    for (let l = 0; l < n; l++) {
      if (why[l] || lanes[l].done >= 0) continue;
      const q = cur[l];
      const completed = !!q && !!ready[l];
      if (completed) {
        if (q.we) ref[l].set(q.addr, q.wd);
        else if (rd[l] !== ref[l].get(q.addr)) why[l] = `cycle ${c}: the read of logical page ${q.addr} gave rd = ${hex(rd[l])}; it holds ${hex(ref[l].get(q.addr)!)}`;
      }
      dev[l].edge(fcmd[l], fa[l], fd[l], ft[l], c);
      if (!why[l] && dev[l].why) why[l] = dev[l].why;
      lanes[l].advance(completed, c);
    }
    sim.cycle();
  }
  return finish(lanes, why, limit, def);
}
