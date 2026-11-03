// The coherent dual-core's timing model (chapter 27, lib/coherent.ts), cycle for cycle. The header is the
// specification the gates follow; tests/coherent.test.ts holds both to it at every clock edge.
//
// MACHINE. Two cores, each behind a private write-back cache of 4 sets x 4-word lines, direct-mapped, and one
// shared memory of 2^K words (K >= 5; a line is 4 words). Word address bits: [1:0] byte, [3:2] word in line,
// [5:4] set, [K+1:6] tag (t = K - 4 bits); the line address L = [K+1:4] (K - 2 bits). A line is I (v = 0), S
// (v = 1, m = 0, clean, any number of copies) or M (v = 1, m = 1, dirty, the only valid copy): MSI, two state bits
// per line. Each cache keeps its {m, v, tag} per set twice: once for the core, once for the snoop port (a
// duplicate array, written together), so a snoop looks a line up without taking the core's tag port.
//
// A CORE ACCESS (lw / sw / amoswap.w / amoadd.w / lr.w / sc.w, word accesses only) in a cycle looks at the
// state at the start of the cycle:
//   hit    = the set holds its line (v and the tags are equal);
//   perm   = hit and (the access only reads, or m = 1);  writes = sw, amo*, sc.w;
//   scFail = sc.w and the reservation does not hold: valid and its line equal to this access's line;
//   grant  = scFail or perm.  The core retires the instruction in this cycle iff it is not a memory access or
//            grant = 1; otherwise it holds (retire = 0) and the cache asks the bus:
//   need   = access, not grant;   upgr = need and hit (the line is S, the access writes): BusUpgr;
//            otherwise a miss: BusRd (the access reads) or BusRdX (it writes);   wb = a miss with the set's line M.
// A granted access reads or writes the cache's data array in that same cycle (a write only when it is a store,
// amo* or a successful sc.w; lr.w and a failed sc.w write nothing; sc.w returns 0 or 1 in rd, instead of memory).
// lr.w sets the reservation {valid, L}; any sc.w clears it (after it was tested).
//
// THE BUS carries one transaction at a time. Idle: the requesters (need) go to the round-robin arbiter (ARBITER2:
// priority bit p, flipped on every cycle both ask; p = 0 power-on, core 0 first). The winner W is GRANTED in that
// cycle (the grant cycle); at its edge:
//   * the other cache X looks the line up in its snoop tags. If X holds it: BusRd: M becomes S (S stays), BusRdX
//     / BusUpgr: it becomes I. X's reservation on that line is lost for a BusRdX / BusUpgr. (Nothing happens in
//     the non-coherent variant: the caches do not snoop.)
//   * the transaction starts: busy = 1, owner = W, flush = (X held the line M and it is no BusUpgr: X will supply
//     it), count = 0 if W's miss has an M victim to write back, else 4.
// Busy: the count goes 0..7. Counts 0-3 write the victim (W's set, old tag) back, a word a cycle, to memory.
// Counts 4-7 move the line: word c-4 of the line comes from X's data array if flush (and is written to memory in
// the same cycle: the Flush) else from memory; W's cache writes it into its data array. A BusUpgr has the single
// cycle 4. On the last cycle (7, or 4 for BusUpgr) W's state for the set becomes M (the access writes) or S, its
// tag the line's; a BusRd / BusRdX also drops W's reservation if it names the line this fill evicts. busy = 0.
// The next cycle is a grant cycle again: W's access is a hit and retires, X's accesses meanwhile see its new state
// (a write to a line it just lost waits for the bus), and loads of S lines go on (the data arrays have a second
// read port for the bus: the core never waits for a snoop).
// Accesses of X's core hit the cache during a flush; X's line is S or I from the grant edge on, so no store can
// change it behind the Flush; a store X makes in the grant cycle itself is in the array before the Flush reads.
//
// SAME EDGE: reservation sets (lr.w) lose against clears (a snooped invalidation of the lr.w's line, or an eviction);
// sc.w tests the reservation of the cycle's start.
//
// MEMORY ORDER. Within a cycle nothing two cores retire touches one line in a way that matters (a write needs M,
// which excludes any other valid copy), so the golden model's harts (riscv/iss.ts, MultiISS) are stepped in any
// order; their loads and stores go through the cache data this model keeps, so the stale reads of the variant
// without snooping are reproduced too.

import { decode, OPCODES } from './isa';
import { MultiISS } from './multi';
import type { ISS, ModelState } from './iss';

export const SETS = 4;
export const LINE_WORDS = 4;
export type CohState = 0 | 1 | 2;
export const ST_NAMES = ['I', 'S', 'M'] as const;
export type CohOp = 'BusRd' | 'BusRdX' | 'BusUpgr';

export interface CohOptions {
  /** false: private write-back caches that never snoop (the chapter's first cache step). */
  coherent?: boolean;
  /** Shared memory words, 2^K (K >= 5). */
  dmemWords?: number;
  imemWords?: number;
}

export interface BusEvent {
  cycle: number;
  core: number;
  op: CohOp;
  /** Byte address of the line. */
  line: number;
  /** Victim written back first (a dirty line of this cache's set). */
  writeback: boolean;
  flush: boolean;
  /** The other cache's line went from -> to (state numbers), or null. */
  other: { from: CohState; to: CohState } | null;
  resvLost: boolean;
  /** Cycles the transaction holds the bus (grant cycle included). */
  cycles: number;
}

export interface Look {
  kind: 'none' | 'ld' | 'st' | 'amo' | 'lr' | 'sc';
  addr: number;
  wr: boolean;
  set: number;
  tag: number;
  word: number;
  line: number;
  hit: boolean;
  perm: boolean;
  scFail: boolean;
  grant: boolean;
  need: boolean;
  upgr: boolean;
  wb: boolean;
}

interface Cache {
  st: CohState[];
  tag: number[];
  data: number[];
}

interface State {
  caches: Cache[];
  mem: number[];
  busy: boolean;
  owner: number;
  cnt: number;
  flush: boolean;
  prio: number;
  cycles: number;
  stalls: number[];
  busBusy: number;
  tx: { rd: number; rdx: number; upgr: number };
  invalidations: number;
  flushes: number;
  writebacks: number;
  scFails: number[];
  scOk: number[];
  log: BusEvent[];
  /** Transactions started by each core. */
  txBy: number[];
}

export class CohModel {
  readonly m: MultiISS;
  readonly coherent: boolean;
  readonly K: number;
  readonly t: number;
  private lineMask: number;
  private tagMask: number;
  s: State;
  /** What each core looked like at the start of the last cycle. */
  last: Look[] = [];

  constructor(program: number[], opts: CohOptions = {}) {
    this.coherent = opts.coherent !== false;
    const words = opts.dmemWords ?? 32;
    this.K = Math.round(Math.log2(words));
    if (2 ** this.K !== words || this.K < 5) throw new Error('CohModel: 2^K memory words, K >= 5');
    this.t = this.K - 4;
    this.lineMask = 2 ** (this.K - 2) - 1;
    this.tagMask = 2 ** this.t - 1;
    this.m = new MultiISS(program, 2, words, opts.imemWords ?? 64);
    this.s = this.fresh(words);
    this.m.harts.forEach((h, i) => {
      const x = h as unknown as { load: ISS['load']; store: ISS['store'] };
      x.load = (addr) => this.read(i, addr);
      x.store = (addr, _f3, v) => this.write(i, addr, v);
    });
  }

  private fresh(words: number): State {
    return {
      caches: [0, 1].map(() => ({ st: Array(SETS).fill(0) as CohState[], tag: Array(SETS).fill(0), data: Array(SETS * LINE_WORDS).fill(0) })),
      mem: Array(words).fill(0), busy: false, owner: 0, cnt: 0, flush: false, prio: 0, cycles: 0, stalls: [0, 0], busBusy: 0,
      tx: { rd: 0, rdx: 0, upgr: 0 }, invalidations: 0, flushes: 0, writebacks: 0, scFails: [0, 0], scOk: [0, 0], log: [], txBy: [0, 0],
    };
  }

  get halted(): boolean { return this.m.halted; }
  get cycles(): number { return this.s.cycles; }

  save(): { m: { self: ModelState; harts: ModelState[] }; s: State } {
    return { m: this.m.save(), s: structuredClone(this.s) };
  }
  restore(v: { m: { self: ModelState; harts: ModelState[] }; s: State }): void {
    this.m.restore(v.m);
    this.s = structuredClone(v.s);
  }

  private read(i: number, addr: number): number {
    const c = this.s.caches[i], a = addr >>> 0;
    const set = (a >>> 4) & 3;
    return c.data[set * LINE_WORDS + ((a >>> 2) & 3)] >>> 0;
  }
  private write(i: number, addr: number, v: number): void {
    const c = this.s.caches[i], a = addr >>> 0;
    c.data[((a >>> 4) & 3) * LINE_WORDS + ((a >>> 2) & 3)] = v >>> 0;
  }

  /** What core i's next instruction asks of its cache, and how the cache answers, in the current state. */
  look(i: number): Look {
    const h = this.m.harts[i], c = this.s.caches[i];
    const d = decode(h.fetch(h.pc));
    let kind: Look['kind'] = 'none', addr = 0;
    if (d.opcode === OPCODES.LOAD) { kind = 'ld'; addr = (h.x[d.rs1] + d.imm) >>> 0; }
    else if (d.opcode === OPCODES.STORE) { kind = 'st'; addr = (h.x[d.rs1] + d.imm) >>> 0; }
    else if (d.opcode === OPCODES.AMO) { kind = d.name === 'lr.w' ? 'lr' : d.name === 'sc.w' ? 'sc' : 'amo'; addr = h.x[d.rs1] >>> 0; }
    const wr = kind === 'st' || kind === 'amo' || kind === 'sc';
    const set = (addr >>> 4) & 3, tag = (addr >>> 6) & this.tagMask, line = (addr >>> 4) & this.lineMask, word = (addr >>> 2) & 3;
    const hit = kind !== 'none' && c.st[set] !== 0 && c.tag[set] === tag;
    const perm = hit && (!wr || c.st[set] === 2);
    const scFail = kind === 'sc' && !(h.resValid && (h.resLine & this.lineMask) === line);
    const grant = kind === 'none' || scFail || perm;
    const need = kind !== 'none' && !grant;
    const upgr = need && hit;
    const wb = need && !hit && c.st[set] === 2;
    return { kind, addr, wr, set, tag, word, line, hit, perm, scFail, grant, need, upgr, wb };
  }

  /** One clock cycle. Returns which cores retired an instruction. */
  step(): boolean[] {
    const s = this.s, look = [this.look(0), this.look(1)];
    this.last = look;
    const retired = look.map((l) => l.grant);
    const loseRes = [false, false];
    // ---- the bus
    if (!s.busy) {
      const r0 = look[0].need, r1 = look[1].need;
      const g0 = r0 && !(r1 && s.prio === 1), g1 = r1 && !(r0 && s.prio === 0);
      if (r0 && r1) s.prio ^= 1;
      const w = g0 ? 0 : g1 ? 1 : -1;
      if (w >= 0) {
        const L = look[w], x = 1 - w, cx = s.caches[x], hx = this.m.harts[x];
        let flush = false, other: BusEvent['other'] = null, resvLost = false;
        if (this.coherent && cx.st[L.set] !== 0 && cx.tag[L.set] === L.tag) {
          const from = cx.st[L.set];
          flush = from === 2 && !L.upgr;
          cx.st[L.set] = L.wr ? 0 : 1;
          other = { from, to: cx.st[L.set] };
          if (L.wr) {
            s.invalidations++;
            // a reservation held, or an lr.w retiring in this very cycle on the line: the clear wins
            if ((hx.resValid && (hx.resLine & this.lineMask) === L.line) || (look[x].kind === 'lr' && look[x].grant && look[x].line === L.line)) { loseRes[x] = true; resvLost = true; }
          }
        }
        if (flush) s.flushes++;
        if (L.wb) s.writebacks++;
        s.busy = true; s.owner = w; s.cnt = L.wb ? 0 : 4; s.flush = flush;
        s.txBy[w]++;
        const op: CohOp = L.upgr ? 'BusUpgr' : L.wr ? 'BusRdX' : 'BusRd';
        if (op === 'BusRd') s.tx.rd++; else if (op === 'BusRdX') s.tx.rdx++; else s.tx.upgr++;
        s.log.push({ cycle: s.cycles, core: w, op, line: L.line * 16, writeback: L.wb, flush, other, resvLost, cycles: (L.wb ? 4 : 0) + (L.upgr ? 1 : 4) + 1 });
        if (s.log.length > 64) s.log.shift();
      }
    } else {
      s.busBusy++;
      const o = s.owner, L = look[o], co = s.caches[o], cx = s.caches[1 - o], wd = s.cnt & 3;
      const base = L.set * LINE_WORDS + wd;
      if (s.cnt < 4) s.mem[(co.tag[L.set] << 4 | L.set << 2 | wd) % s.mem.length] = co.data[base];
      else if (!L.upgr) {
        const mi = (L.line << 2 | wd) % s.mem.length;
        const v = s.flush ? cx.data[base] : s.mem[mi];
        if (s.flush) s.mem[mi] = v;
        co.data[base] = v;
      }
      if (s.cnt === 7 || (s.cnt === 4 && L.upgr)) {
        co.st[L.set] = L.wr ? 2 : 1;
        co.tag[L.set] = L.tag;
        const ho = this.m.harts[o];
        if (!L.upgr && ho.resValid && (ho.resLine & this.lineMask & 3) === L.set && (ho.resLine & this.lineMask) !== L.line) loseRes[o] = true;
        s.busy = false;
      } else s.cnt++;
    }
    // ---- the cores
    look.forEach((l, i) => {
      if (l.kind !== 'none' && !l.grant) s.stalls[i]++;
      if (l.kind === 'sc' && l.grant) { if (l.scFail) s.scFails[i]++; else s.scOk[i]++; }
    });
    retired.forEach((r, i) => { if (r) this.m.harts[i].step(); });
    loseRes.forEach((x, i) => { if (x) this.m.harts[i].resValid = false; });
    s.cycles++;
    this.m.cycles++;
    return retired;
  }

  /** Why the invariants fail now (null: none does). SWMR: at most one M per line and then no other valid copy; every
   *  valid copy equals the golden value; memory equals it for every line with no M copy (except the line in flight). */
  invariants(): string | null {
    if (!this.coherent) return null;
    const s = this.s, nl = s.mem.length / LINE_WORDS;
    const o = s.busy ? this.look(s.owner) : null;
    // the line being moved, and the owner's old line in its set while the fill overwrites it, are in flight
    const inFlight = o && !o.upgr ? o.line : -1;
    const evicted = o && !o.upgr && s.cnt >= 4 && s.caches[s.owner].st[o.set] !== 0 ? (s.caches[s.owner].tag[o.set] << 2) | o.set : -1;
    for (let ln = 0; ln < nl; ln++) {
      const copies = [0, 1].map((i) => {
        const c = s.caches[i], set = ln & 3;
        return c.st[set] !== 0 && c.tag[set] === (ln >> 2) ? { i, st: c.st[set], words: c.data.slice(set * 4, set * 4 + 4) } : null;
      }).filter((x) => x !== null);
      const mCopies = copies.filter((c) => c!.st === 2);
      if (mCopies.length > 1) return `line ${ln}: two Modified copies`;
      if (mCopies.length === 1 && copies.length > 1) return `line ${ln}: a Modified copy and another valid copy`;
      if (this.coherent && ln !== inFlight && ln !== evicted && !mCopies.length) {
        const mem = s.mem.slice(ln * 4, ln * 4 + 4);
        for (const c of copies) if (c!.words.join() !== mem.join()) return `line ${ln}: a Shared copy in cache ${c!.i} differs from memory`;
      }
    }
    return null;
  }

  /** Every line's current value as the program sees it: the M copy, else memory. */
  memoryView(): number[] {
    const s = this.s, out = s.mem.slice();
    for (const c of s.caches) c.st.forEach((st, set) => { if (st === 2) for (let w = 0; w < 4; w++) out[((c.tag[set] << 4) | (set << 2) | w) % out.length] = c.data[set * 4 + w]; });
    return out;
  }
}
