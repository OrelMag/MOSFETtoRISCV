// The out-of-order core as a cycle-level model (chapter 24): the reference the gate-level core must match cycle for
// cycle, and what the chapter's explorers run at any size. DOM-free.
//
// The core (OOO_CORE; P6 style: values wait in the reorder buffer, the rename table maps a register to a ROB entry):
//   Fetch      up to `width` sequential instructions from the PC, ending after the first predicted taken. A BTB
//              (direct-mapped, tagged: target + 2-bit counter) predicts; with predict 'ras' a return-address stack
//              predicts returns (jalr x0, 0(ra)) and calls push pc + 4. The group waits in the fetch register; fetch
//              loads it only when everything in it dispatches this cycle.
//   Dispatch   in order: each instruction takes a ROB entry, an issue-queue entry (not jal / lui: their value is known
//              when decoded, so their ROB entry is done at once) and a store-queue entry for a store. The first that
//              does not fit stops the rest. Entries freed this cycle are usable next cycle.
//   Issue      port 0: ALU, branches, jalr, loads, stores; port 1: ALU, branches, jalr, multiply, divide; ports 2+: ALU
//              (one port does everything when width is 1). An instruction two ports take is bound at dispatch to the
//              one with fewer instructions waiting (port 0 on a tie). Each port
//              picks the oldest ready instruction bound to it. Ready: every producer's result is on a bus this cycle
//              or earlier (wakeup and capture in the same cycle, so dependent instructions go back to back). Each port
//              has one result bus: an instruction of latency L picked at t needs the bus free at t + L. A load also
//              waits until every older store has executed. The divider takes one division at a time and keeps its
//              result until its port's bus is free.
//   Execute    result on the bus at t + L (ALU, branch, jalr, store: 1; load: 2, address then memory; multiply: 2;
//              divide: 19), written into the ROB and the waiting issue-queue entries at the end of that cycle.
//   Commit     up to `width` done entries from the head in order, one store per cycle (one memory write port). A
//              mispredicted branch commits and then everything younger is flushed: ROB, issue queue, fetch register,
//              units in flight, the rename table (all registers back in the register file), the return-address stack
//              (from its committed copy); fetch restarts at the right PC next cycle. With recover: 'resolve' the flush
//              happens when the branch executes instead (the model only: it needs rename-table checkpoints).
//
// Timing does not depend on data values: loads wait for older stores whatever their addresses, and every unit has a
// fixed latency. Only the correct path's control flow matters, which the golden model gives: it steps once per
// correct-path instruction as it is fetched. Wrong-path instructions are fetched, renamed and executed like any other
// (they compete for ports and buses with older ones) until the flush removes them.

import { ISS, type IssOptions } from './iss';
import { disasm } from './isa';
import { classify, LAT, latencyOf, type Latencies, type UopClass } from './ilp';

export type Predictor = 'perfect' | 'btb' | 'ras';

export interface OooConfig {
  /** Instructions fetched, dispatched, issued (ports) and committed per cycle. */
  width: number;
  rob: number;
  iq: number;
  sq: number;
  lat: Latencies;
  predict: Predictor;
  btb: number;
  ras: number;
  recover: 'commit' | 'resolve';
  /** Issue in program order (a scoreboarded in-order machine with the same front and back end). */
  inorder: boolean;
  /** Branches and jalr on port 0 only, or on ports 0 and 1. */
  branchPorts: 1 | 2;
  /** How an instruction that several ports take picks one: alternate, or the port with fewer waiting. */
  bind: 'alternate' | 'balance';
}

/** The gate-level core's shape (decisions D4–D6 of the plan). */
export const OOO_CORE: OooConfig = {
  width: 2, rob: 16, iq: 8, sq: 4, lat: LAT, predict: 'ras', btb: 16, ras: 4, recover: 'commit', inorder: false, branchPorts: 2, bind: 'balance',
};

export type UopState = 'fetched' | 'queued' | 'issued' | 'done' | 'committed' | 'flushed';

export interface Uop {
  /** Fetch order (unique for the run). */
  seq: number;
  pc: number;
  word: number;
  text: string;
  cls: UopClass;
  rd: number;
  srcs: number[];
  /** On a wrong path: fetched after a mispredicted instruction, flushed before it can commit. */
  wrong: boolean;
  /** Where fetch went next. */
  pnext: number;
  /** Where the program went next (correct path only). */
  next?: number;
  mispredict: boolean;
  /** The golden model's step (correct path only): what it wrote. */
  value?: number;
  /** Producers it waited for at dispatch (in flight then). */
  deps: Uop[];
  port: number;
  /** Cycles: fetched, dispatched, picked (issued), result on the bus / done, committed or flushed (-1: not yet). */
  f: number;
  d: number;
  s: number;
  x: number;
  c: number;
  state: UopState;
  /** ROB entry (circular index) once dispatched. */
  rob: number;
}

export interface CycleInfo {
  cycle: number;
  committed: Uop[];
  issued: Uop[];
  dispatched: Uop[];
  fetched: Uop[];
  /** Instructions flushed at the end of this cycle. */
  flushed: Uop[];
}

export interface OooStats {
  cycles: number;
  instructions: number;
  mispredicts: number;
  wrongPath: number;
  /** Cycles dispatch stopped for lack of a ROB / issue-queue / store-queue entry. */
  robFull: number;
  iqFull: number;
  sqFull: number;
}

interface BtbEntry { tag: number; target: number; ctr: number; jump: boolean }

export class OooModel {
  readonly cfg: OooConfig;
  cycle = 0;
  halted = false;
  readonly stats: OooStats = { cycles: 0, instructions: 0, mispredicts: 0, wrongPath: 0, robFull: 0, iqFull: 0, sqFull: 0 };
  /** In flight, in program order (dispatched: ROB entries). */
  readonly robList: Uop[] = [];
  /** The fetch register (fetched, waiting to dispatch). */
  fd: Uop[] = [];
  /** Recent instructions, committed or flushed, for timelines (newest last). */
  readonly history: Uop[] = [];
  historyMax = 400;
  private readonly iss: ISS;
  private readonly imem: number;
  private fetchPc = 0;
  private wrongPath = false;
  private seq = 0;
  private robHead = 0;
  private robTail = 0;
  private aluNext = 0;
  private btb: (BtbEntry | null)[];
  private rasSpec: number[] = [];
  private rasCommit: number[] = [];
  /** Per port: cycles whose bus is taken. */
  private busy: Set<number>[];
  private div: Uop | null = null;

  constructor(readonly words: number[], cfg: Partial<OooConfig> = {}, opts: IssOptions = {}) {
    this.cfg = { ...OOO_CORE, ...cfg, lat: { ...OOO_CORE.lat, ...cfg.lat } };
    this.iss = new ISS(words, { m: true, ...opts });
    this.imem = opts.imemWords ?? 1 << 16;
    this.btb = new Array(this.cfg.btb).fill(null);
    this.busy = Array.from({ length: this.cfg.width }, () => new Set<number>());
  }

  /** The issue queue: dispatched, not yet picked (program order). */
  iqList(): Uop[] { return this.robList.filter((u) => u.state === 'queued'); }

  /** Rename table: register → the youngest in-flight instruction writing it. */
  rat(): Map<number, Uop> {
    const m = new Map<number, Uop>();
    for (const u of this.robList) if (u.rd) m.set(u.rd, u);
    return m;
  }

  /** Ports that may run a class (width 1: one port does everything). */
  private portsFor(cls: UopClass): number[] {
    const w = this.cfg.width;
    if (w === 1) return [0];
    if (cls === 'branch' || cls === 'jalr') return this.cfg.branchPorts === 2 ? [0, 1] : [0];
    if (cls === 'load' || cls === 'store') return [0];
    if (cls === 'mul' || cls === 'div') return [1];
    return Array.from({ length: w }, (_, i) => i);
  }

  private predict(pc: number, word: number): number {
    const c = classify(word);
    const { predict, btb } = this.cfg;
    if (predict === 'ras' && c.ret && this.rasSpec.length) return this.rasSpec[this.rasSpec.length - 1];
    const i = (pc >>> 2) % btb, e = this.btb[i];
    if (e && e.tag === Math.floor((pc >>> 2) / btb) && (e.jump || e.ctr >= 2)) return e.target;
    return (pc + 4) >>> 0;
  }

  private rasPush(ras: number[], v: number): void {
    ras.push(v);
    if (ras.length > this.cfg.ras) ras.shift();
  }

  private rasOp(ras: number[], u: { pc: number; word: number }): void {
    const c = classify(u.word);
    if (this.cfg.predict !== 'ras') return;
    if (c.ret) ras.pop();
    else if (c.call) this.rasPush(ras, (u.pc + 4) >>> 0);
  }

  private trainBtb(u: Uop): void {
    const { btb, predict } = this.cfg;
    if (u.cls !== 'branch' && u.cls !== 'jal' && u.cls !== 'jalr') return;
    if (predict === 'ras' && classify(u.word).ret) return;
    const i = (u.pc >>> 2) % btb, tag = Math.floor((u.pc >>> 2) / btb), e = this.btb[i];
    const taken = u.next !== ((u.pc + 4) >>> 0);
    if (u.cls === 'branch') {
      if (e && e.tag === tag && !e.jump) {
        e.ctr = Math.max(0, Math.min(3, e.ctr + (taken ? 1 : -1)));
        if (taken) e.target = u.next!;
      } else if (taken) this.btb[i] = { tag, target: u.next!, ctr: 2, jump: false };
    } else this.btb[i] = { tag, target: u.next!, ctr: 3, jump: true };
  }

  private fetchOne(pc: number): Uop {
    const word = this.words[(pc >>> 2) % this.imem] ?? 0;
    const c = classify(word);
    const u: Uop = {
      seq: this.seq++, pc, word, text: disasm(word, pc), cls: c.cls, rd: c.rd, srcs: c.srcs, wrong: this.wrongPath,
      pnext: 0, mispredict: false, deps: [], port: -1, f: this.cycle, d: -1, s: -1, x: -1, c: -1, state: 'fetched', rob: -1,
    };
    if (!this.wrongPath) {
      this.iss.step();
      u.next = this.iss.pc;
      if (u.rd) u.value = this.iss.x[u.rd];
    }
    u.pnext = this.cfg.predict === 'perfect' && !u.wrong ? u.next! : this.predict(pc, word);
    this.rasOp(this.rasSpec, u);
    if (!u.wrong && u.pnext !== u.next) { u.mispredict = true; this.wrongPath = true; }
    if (u.wrong) this.stats.wrongPath++;
    return u;
  }

  /** Advance one clock cycle. */
  step(): CycleInfo {
    const t = this.cycle, cfg = this.cfg;
    const info: CycleInfo = { cycle: t, committed: [], issued: [], dispatched: [], fetched: [], flushed: [] };
    if (this.halted) return info;

    // The divider's result takes its port's bus at the first free cycle once it is ready.
    if (this.div && this.div.x < 0 && this.div.s + cfg.lat.div <= t && !this.busy[this.div.port].has(t)) {
      this.div.x = t;
      this.busy[this.div.port].add(t);
    }
    for (const u of this.robList) if (u.state === 'issued' && u.x >= 0 && u.x <= t) u.state = 'done';
    for (const b of this.busy) for (const c of b) if (c < t) b.delete(c);

    // Commit: done entries (results written at the end of an earlier cycle), from the head, in order.
    let flushAfter: Uop | null = null, stores = 0;
    while (info.committed.length < cfg.width && this.robList.length) {
      const u = this.robList[0];
      if (u.state !== 'done' || u.x >= t) break;
      if (u.cls === 'store' && stores++ >= 1) break;
      this.robList.shift();
      this.robHead = (this.robHead + 1) % cfg.rob;
      u.state = 'committed';
      u.c = t;
      info.committed.push(u);
      this.stats.instructions++;
      this.trainBtb(u);
      this.rasOp(this.rasCommit, u);
      this.remember(u);
      if (u.next === u.pc) { this.halted = true; break; }
      if (u.mispredict) {
        this.stats.mispredicts++;
        if (cfg.recover === 'commit') { flushAfter = u; break; }
      }
    }

    // Issue: each port picks the oldest ready instruction bound to it.
    if (!this.halted) this.issue(t, info);

    // Dispatch the fetch register in order; stop at the first that does not fit.
    // Entries freed this cycle (committed, picked) are usable only from the next.
    const storesIn = (us: Uop[]) => us.filter((u) => u.cls === 'store').length;
    let rob = cfg.rob - this.robList.length - info.committed.length;
    let iq = cfg.iq - this.iqList().length - info.issued.length;
    let sq = cfg.sq - storesIn(this.robList) - storesIn(info.committed);
    while (this.fd.length && !this.halted) {
      const u = this.fd[0];
      const needsIq = u.cls !== 'jal' && u.cls !== 'lui';
      if (rob < 1) { this.stats.robFull++; break; }
      if (needsIq && iq < 1) { this.stats.iqFull++; break; }
      if (u.cls === 'store' && sq < 1) { this.stats.sqFull++; break; }
      this.fd.shift();
      rob--; if (needsIq) iq--; if (u.cls === 'store') sq--;
      const ratNow = this.rat();
      u.deps = u.srcs.map((r) => ratNow.get(r)).filter((p): p is Uop => !!p);
      u.d = t;
      u.rob = this.robTail;
      this.robTail = (this.robTail + 1) % cfg.rob;
      if (needsIq) {
        const ports = this.portsFor(u.cls);
        if (ports.length === 1) u.port = ports[0];
        else if (cfg.bind === 'balance') {
          const n = (p: number) => this.robList.filter((o) => o.state === 'queued' && o.port === p).length;
          u.port = ports.reduce((a, b) => (n(b) < n(a) ? b : a));
        } else u.port = ports[this.aluNext++ % ports.length];
        u.state = 'queued';
      } else {
        u.state = 'done';
        u.x = t;
      }
      this.robList.push(u);
      info.dispatched.push(u);
    }

    // Fetch into the fetch register when it empties this cycle.
    if (!this.fd.length && !this.halted) {
      let pc = this.fetchPc;
      for (let k = 0; k < cfg.width; k++) {
        const u = this.fetchOne(pc);
        info.fetched.push(u);
        pc = u.pnext;
        if (u.pnext !== ((u.pc + 4) >>> 0)) break;
      }
      this.fd = info.fetched.slice();
      this.fetchPc = pc;
    }

    // Recovery at the end of the cycle.
    if (cfg.recover === 'resolve' && !flushAfter) {
      flushAfter = this.robList.find((u) => u.mispredict && u.x === t) ?? null;
    }
    if (flushAfter) this.flush(flushAfter, info);

    this.cycle++;
    this.stats.cycles = this.cycle;
    return info;
  }

  private issue(t: number, info: CycleInfo): void {
    const cfg = this.cfg;
    const ready = (u: Uop) => u.state === 'queued' && u.d < t && u.deps.every((p) => p.x >= 0 && p.x <= t);
    const lat = (u: Uop) => latencyOf(u.cls, cfg.lat);
    const storesExecuted = (u: Uop) => this.robList.every((o) => o.seq >= u.seq || o.cls !== 'store' || (o.x >= 0 && o.x < t));
    const can = (u: Uop) => {
      if (!ready(u)) return false;
      if (u.cls === 'load' && !storesExecuted(u)) return false;
      if (u.cls === 'div') return !this.div || (this.div.x >= 0 && this.div.x <= t);
      return !this.busy[u.port].has(t + lat(u));
    };
    const pick = (u: Uop) => {
      u.state = 'issued';
      u.s = t;
      if (u.cls === 'div') this.div = u;
      else { u.x = t + lat(u); this.busy[u.port].add(u.x); }
      info.issued.push(u);
    };
    const queued = this.robList.filter((u) => u.state === 'queued');
    if (cfg.inorder) {
      const taken = new Set<number>();
      for (const u of queued) {
        if (taken.has(u.port) || !can(u)) break;
        taken.add(u.port);
        pick(u);
      }
      return;
    }
    for (let p = 0; p < cfg.width; p++) {
      const u = queued.find((q) => q.port === p && can(q));
      if (u) pick(u);
    }
  }

  private flush(after: Uop, info: CycleInfo): void {
    const t = this.cycle;
    const gone = [...this.robList.filter((u) => u.seq > after.seq), ...this.fd];
    for (const u of gone) {
      u.state = 'flushed';
      u.c = t;
      if (u.x > t) this.busy[u.port]?.delete(u.x);
      this.remember(u);
    }
    if (this.div && this.div.seq > after.seq) this.div = null;
    const keep = this.robList.filter((u) => u.seq <= after.seq);
    this.robList.length = 0;
    this.robList.push(...keep);
    this.robTail = (this.robHead + keep.length) % this.cfg.rob;
    this.fd = [];
    info.flushed.push(...gone);
    this.fetchPc = after.next!;
    this.wrongPath = false;
    // The return-address stack: from its committed copy at commit; at resolve, as it would be after `after`.
    if (this.cfg.recover === 'commit') this.rasSpec = this.rasCommit.slice();
    else {
      const ras = this.rasCommit.slice();
      for (const u of keep) this.rasOp(ras, u);
      this.rasSpec = ras;
    }
  }

  private remember(u: Uop): void {
    this.history.push(u);
    if (this.history.length > this.historyMax) this.history.splice(0, this.history.length - this.historyMax);
  }

  /** Run to the halt (a jump to itself) or `max` cycles. */
  run(max = 1_000_000): OooStats {
    while (!this.halted && this.cycle < max) this.step();
    return this.stats;
  }
}

/** Cycles and instructions of a program on a configuration (to the commit of its final jump to itself). */
export function oooRun(words: number[], cfg: Partial<OooConfig> = {}, opts: IssOptions = {}, max = 1_000_000): OooStats {
  return new OooModel(words, cfg, opts).run(max);
}
