// The benches of act 10's clocked levels (roadmap Phase 16e). The device a level drives sits on the bench as a
// JS model that knows its rules and names the first one broken: the cell array of m_bank (rows that leak unless
// they are opened in time), the DRAM chip of m_ctrl (timings, refresh). Each lane of a BitSim runs one request
// trace with its own device; a request is held until the chip completes it. No DOM.

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

/** m_ctrl's chip: two banks of 64 rows of 16 words; chapter 33's timings (DDR4-3200 at our clock), one word per command. */
export const DRAM16 = { banks: 2, rows: 64, cols: 16, tRCD: 4, tCAS: 4, tRP: 4, tRAS: 9, tRFC: 12, tREFI: 256 } as const;
/** Chip commands (cmd), chapter 33's encoding. */
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
