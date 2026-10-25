// The out-of-order core as a cycle-level model (chapter 26): the reference the gate-level core must match cycle for
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
// Beyond the core (the lab, chapter 26): fetch and commit widths apart from the ports, any number of ports each with
// its own units (portsOf gives the ports above), and a pipelined divider. Every commit slot is accounted for
// (stats.slots): committed, or charged to what the oldest instruction in flight waits for once issue is done (its
// producer's unit, older stores for a load, a busy divider, a port or bus taken, the one store a cycle; from a flush
// until an instruction fetched after it commits: the misprediction; an empty window otherwise: the front end).
//
// Timing does not depend on data values: loads wait for older stores whatever their addresses, and every unit has a
// fixed latency. Only the correct path's control flow matters, which the golden model gives: it steps once per
// correct-path instruction as it is fetched. Wrong-path instructions are fetched, renamed and executed like any other
// (they compete for ports and buses with older ones) until the flush removes them.

import { ISS, type IssOptions } from './iss';
import { disasm } from './isa';
import { classify, LAT, latencyOf, type Latencies, type UopClass } from './ilp';

export type Predictor = 'perfect' | 'btb' | 'ras';

/** What an issue port can run: ALU operations, branches and jalr, loads and stores, multiplies, divides. */
export type Unit = 'alu' | 'branch' | 'mem' | 'mul' | 'div';
export const UNITS: Unit[] = ['alu', 'branch', 'mem', 'mul', 'div'];
export const UNIT_NAME: Record<Unit, string> = { alu: 'ALU operations', branch: 'branches', mem: 'loads and stores', mul: 'multiplies', div: 'divides' };

/** The unit a class needs (jal and lui none: their value is known at dispatch). */
export function unitOf(cls: UopClass): Unit | null {
  switch (cls) {
    case 'branch': case 'jalr': return 'branch';
    case 'load': case 'store': return 'mem';
    case 'mul': return 'mul';
    case 'div': return 'div';
    case 'jal': case 'lui': return null;
    default: return 'alu';
  }
}

export interface OooConfig {
  /** Instructions fetched, dispatched, issued (ports) and committed per cycle, unless fetch / commit / ports say otherwise. */
  width: number;
  /** Instructions fetched and dispatched per cycle (default: width). */
  fetch?: number;
  /** Instructions committed per cycle (default: width). */
  commit?: number;
  /** The issue ports, each with the units it runs (default: portsOf(width, branchPorts)). */
  ports?: Unit[][];
  /** A divider takes one division at a time ('iterative', as the gates do; default) or a new one every cycle. */
  divider?: 'iterative' | 'pipelined';
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
  /** Branches and jalr on port 0 only, or on ports 0 and 1 (the default ports only). */
  branchPorts: 1 | 2;
  /** How an instruction that several ports take picks one: alternate, or the port with fewer waiting. */
  bind: 'alternate' | 'balance';
}

/** The gate-level core's shape (decisions D4–D6 of the plan). */
export const OOO_CORE: OooConfig = {
  width: 2, rob: 16, iq: 8, sq: 4, lat: LAT, predict: 'ras', btb: 16, ras: 4, recover: 'commit', inorder: false, branchPorts: 2, bind: 'balance',
};

/** The default ports for a width: port 0 ALU, branches, memory; port 1 ALU, branches, multiply, divide; ports 2+ ALU
 *  (one port does everything when width is 1). */
export function portsOf(width: number, branchPorts: 1 | 2 = 2): Unit[][] {
  if (width === 1) return [UNITS.slice()];
  return Array.from({ length: width }, (_, p): Unit[] =>
    p === 0 ? ['alu', 'branch', 'mem'] : p === 1 ? (branchPorts === 2 ? ['alu', 'branch', 'mul', 'div'] : ['alu', 'mul', 'div']) : ['alu']);
}

export interface OooShape { fetch: number; commit: number; ports: Unit[][] }

/** A configuration's widths and ports, defaults filled in. */
export function shapeOf(cfg: OooConfig): OooShape {
  return { fetch: cfg.fetch ?? cfg.width, commit: cfg.commit ?? cfg.width, ports: cfg.ports ?? portsOf(cfg.width, cfg.branchPorts) };
}

/** Why a configuration cannot run (none: it can). */
export function configProblems(cfg: Partial<OooConfig>): string[] {
  const c: OooConfig = { ...OOO_CORE, ...cfg }, sh = shapeOf(c), out: string[] = [];
  for (const u of UNITS) if (!sh.ports.some((p) => p.includes(u))) out.push(`No port runs ${UNIT_NAME[u]}.`);
  if (sh.fetch < 1 || sh.commit < 1) out.push('Fetch and commit need a width of 1 or more.');
  if (c.rob < 1 || c.iq < 1 || c.sq < 1) out.push('The reorder buffer and both queues need an entry or more.');
  return out;
}

/** Where a commit slot went: an instruction committed, or what the oldest one in flight was waiting for. */
export type SlotCause = 'retired' | 'mispredict' | 'frontend' | 'dependency' | 'memory' | 'muldiv' | 'port' | 'store';
export const SLOT_CAUSES: SlotCause[] = ['retired', 'mispredict', 'frontend', 'dependency', 'memory', 'muldiv', 'port', 'store'];

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
  /** Where this cycle's empty commit slots went (null: none empty). */
  lost: SlotCause | null;
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
  /** Commit slots (commit width × cycles) by where they went; they add up to commit × cycles. */
  slots: Record<SlotCause, number>;
}

interface BtbEntry { tag: number; target: number; ctr: number; jump: boolean }

export class OooModel {
  readonly cfg: OooConfig;
  cycle = 0;
  halted = false;
  readonly stats: OooStats = {
    cycles: 0, instructions: 0, mispredicts: 0, wrongPath: 0, robFull: 0, iqFull: 0, sqFull: 0,
    slots: { retired: 0, mispredict: 0, frontend: 0, dependency: 0, memory: 0, muldiv: 0, port: 0, store: 0 },
  };
  readonly shape: OooShape;
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
  /** Per port: the division its iterative divider holds. */
  private div: (Uop | null)[];
  private readonly iterDiv: boolean;
  /** The cycle of the last flush; until an instruction fetched after it commits, its slots go to the misprediction. */
  private flushedAt = -1;
  private recovering = false;

  constructor(readonly words: number[], cfg: Partial<OooConfig> = {}, opts: IssOptions = {}) {
    this.cfg = { ...OOO_CORE, ...cfg, lat: { ...OOO_CORE.lat, ...cfg.lat } };
    const bad = configProblems(this.cfg);
    if (bad.length) throw new Error(bad.join(' '));
    this.shape = shapeOf(this.cfg);
    this.iterDiv = (this.cfg.divider ?? 'iterative') === 'iterative';
    this.iss = new ISS(words, { m: true, ...opts });
    this.imem = opts.imemWords ?? 1 << 16;
    this.btb = new Array(this.cfg.btb).fill(null);
    this.busy = this.shape.ports.map(() => new Set<number>());
    this.div = this.shape.ports.map(() => null);
  }

  /** The issue queue: dispatched, not yet picked (program order). */
  iqList(): Uop[] { return this.robList.filter((u) => u.state === 'queued'); }

  /** Rename table: register → the youngest in-flight instruction writing it. */
  rat(): Map<number, Uop> {
    const m = new Map<number, Uop>();
    for (const u of this.robList) if (u.rd) m.set(u.rd, u);
    return m;
  }

  /** Ports that may run a class. */
  private portsFor(cls: UopClass): number[] {
    const unit = unitOf(cls)!, out: number[] = [];
    this.shape.ports.forEach((p, i) => { if (p.includes(unit)) out.push(i); });
    return out;
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
    const info: CycleInfo = { cycle: t, committed: [], issued: [], dispatched: [], fetched: [], flushed: [], lost: null };
    if (this.halted) return info;

    // An iterative divider's result takes its port's bus at the first free cycle once it is ready.
    for (const d of this.div) if (d && d.x < 0 && d.s + cfg.lat.div <= t && !this.busy[d.port].has(t)) {
      d.x = t;
      this.busy[d.port].add(t);
    }
    for (const u of this.robList) if (u.state === 'issued' && u.x >= 0 && u.x <= t) u.state = 'done';
    for (const b of this.busy) for (const c of b) if (c < t) b.delete(c);

    // Commit: done entries (results written at the end of an earlier cycle), from the head, in order.
    let flushAfter: Uop | null = null, stores = 0;
    while (info.committed.length < this.shape.commit && this.robList.length) {
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
    this.account(t, info, stores > 1);

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
      for (let k = 0; k < this.shape.fetch; k++) {
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

  /** This cycle's commit slots: the committed ones, the rest to what the oldest instruction left waits for (after issue). */
  private account(t: number, info: CycleInfo, storeLimit: boolean): void {
    const committed = info.committed, sl = this.stats.slots, empty = this.shape.commit - committed.length;
    sl.retired += committed.length;
    if (this.recovering && committed.some((u) => u.f > this.flushedAt)) this.recovering = false;
    if (empty > 0) sl[info.lost = this.halted ? 'frontend' : this.headCause(t, storeLimit)] += empty;
  }

  /** What the oldest instruction in flight waits for in cycle t, once commit and issue are done. */
  headCause(t: number, storeLimit = false): SlotCause {
    const u = this.robList[0];
    if (!u) return this.recovering ? 'mispredict' : 'frontend';
    if (u.wrong || (this.recovering && u.f > this.flushedAt)) return 'mispredict';
    if (u.state === 'done' && u.x < t) return storeLimit ? 'store' : 'frontend';
    if (u.state === 'done' || u.state === 'issued') return unitCause(u.cls);
    const lagging = u.deps.find((p) => !(p.x >= 0 && p.x <= t));
    if (lagging) return unitCause(lagging.cls);
    if (u.cls === 'load' && this.robList.some((o) => o.seq < u.seq && o.cls === 'store' && !(o.x >= 0 && o.x < t))) return 'memory';
    if (u.cls === 'div' && this.iterDiv && this.div[u.port]) return 'muldiv';
    return 'port';
  }

  private issue(t: number, info: CycleInfo): void {
    const cfg = this.cfg;
    const ready = (u: Uop) => u.state === 'queued' && u.d < t && u.deps.every((p) => p.x >= 0 && p.x <= t);
    const lat = (u: Uop) => latencyOf(u.cls, cfg.lat);
    const storesExecuted = (u: Uop) => this.robList.every((o) => o.seq >= u.seq || o.cls !== 'store' || (o.x >= 0 && o.x < t));
    const can = (u: Uop) => {
      if (!ready(u)) return false;
      if (u.cls === 'load' && !storesExecuted(u)) return false;
      if (u.cls === 'div' && this.iterDiv) { const d = this.div[u.port]; return !d || (d.x >= 0 && d.x <= t); }
      return !this.busy[u.port].has(t + lat(u));
    };
    const pick = (u: Uop) => {
      u.state = 'issued';
      u.s = t;
      if (u.cls === 'div' && this.iterDiv) this.div[u.port] = u;
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
    for (let p = 0; p < this.shape.ports.length; p++) {
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
    this.div = this.div.map((d) => (d && d.seq > after.seq ? null : d));
    this.flushedAt = t;
    this.recovering = true;
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

/** The cause charged to a slot the oldest instruction holds while it (or the producer it waits for) is in a unit. */
function unitCause(cls: UopClass): SlotCause {
  return cls === 'load' || cls === 'store' ? 'memory' : cls === 'mul' || cls === 'div' ? 'muldiv' : 'dependency';
}
