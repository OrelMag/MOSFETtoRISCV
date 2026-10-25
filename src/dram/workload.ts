// Workloads for the controller (chapter 36): a program run on the golden model, its loads and stores
// through the behavioural model of the CPUs' 2-way write-back cache, gives the line requests the cache
// would make (a dirty victim's write-back, then the fill) and the instructions between them. Priced on
// the cycle-exact controller and device (CtrlModel, DeviceModel).

import { assemble } from '../riscv/asm';
import { BENCHMARKS } from '../riscv/benchprograms';
import { decode } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { CacheModel } from '../sim/cachemodel';
import { CtrlModel, DeviceModel, type DramConfig, idle, transfer } from './controller';

export interface LineReq { la: number; wr: boolean; /** Instructions retired since the previous request. */ gap: number }
export interface Workload { id: string; name: string; dmemWords: number; instructions: number; reqs: LineReq[] }

const sext = (v: number, b: number) => (v << (32 - b)) >> (32 - b);

/** A memory copy of 1 024 words from word 0 to word 1 024 (4 K words of memory): two streams, interleaved. */
export const COPY_SOURCE = `# copy 1 024 words from 0x0000 to 0x1000
        li   a0, 0
        li   a1, 0x1000
        li   a2, 1024
loop:   lw   t0, 0(a0)
        sw   t0, 0(a1)
        addi a0, a0, 4
        addi a1, a1, 4
        addi a2, a2, -1
        bnez a2, loop
done:   j    done`;

/** The line requests of a program behind the 2-way, 2-set write-back cache of the CPUs (64 bytes). */
export function workload(id: string, name: string, source: string, dmemWords: number): Workload {
  const a = assemble(source);
  if (a.errors.length) throw new Error(`${id}: ${a.errors[0].message}`);
  const iss = new ISS(a.words, { dmemWords, imemWords: 128, m: true });
  const cache = new CacheModel({ size: 64, line: 16, ways: 2, replacement: 'lru', write: 'wb' });
  const reqs: LineReq[] = [];
  let gap = 0;
  for (let n = 0; n < 2_000_000 && !iss.halted; n++) {
    const pc = iss.pc, w = iss.imem[pc >>> 2] >>> 0, d = decode(w), op = w & 0x7f;
    let addr = -1, store = false;
    if (op === 0x03) addr = (iss.x[d.rs1] + sext(w >>> 20, 12)) >>> 0;
    if (op === 0x23) { addr = (iss.x[d.rs1] + sext(((w >>> 25) << 5) | ((w >>> 7) & 31), 12)) >>> 0; store = true; }
    if (addr >= 0) {
      const set = Math.floor(addr / 16) % cache.sets, before = cache.lines[set].map((l) => ({ tag: l.tag, dirty: l.dirty && l.valid }));
      const r = cache.access(addr, store);
      if (!r.hit) {
        const v = before[r.way];
        if (v.dirty) { reqs.push({ la: (v.tag * cache.sets + set), wr: true, gap }); gap = 0; }
        reqs.push({ la: Math.floor(addr / 16), wr: false, gap }); gap = 0;
      }
    }
    iss.step();
    gap++;
    if (iss.pc === pc) break;
  }
  return { id, name, dmemWords, instructions: iss.retired, reqs };
}

let cached: Workload[] | null = null;
/** The four RV32I benchmarks (64-word memory) and the copy (4 K words). */
export function workloads(): Workload[] {
  return (cached ??= [
    ...BENCHMARKS.filter((b) => !b.needs).map((b) => workload(b.id, b.name, b.source, 64)),
    workload('copy', 'Copy 1 K words', COPY_SOURCE, 4096),
  ]);
}

export interface Priced { cycles: number; memCycles: number; hits: number; misses: number; conflicts: number; refreshes: number; fixed: number }

/**
 * Cycles of a workload on a single-cycle CPU: one per instruction, plus each request's stall from the
 * cycle it is raised to its last word (the controller and device, cycle-exact; refresh included). `fixed`:
 * the same with today's fixed miss costs (8 a fill, 4 more for a write-back first).
 */
export function price(w: Workload, c: DramConfig): Priced {
  const ctrl = new CtrlModel(c), dev = new DeviceModel(c);
  let mem = 0;
  for (const r of w.reqs) {
    idle(ctrl, dev, r.gap);
    mem += transfer(ctrl, dev, r.wr, r.la).cycles;
  }
  if (dev.err) throw new Error(`${w.id}: ${dev.why}`);
  const fixed = w.reqs.reduce((s, r) => s + (r.wr ? 4 : 8), 0);
  return { cycles: w.instructions + mem, memCycles: mem, hits: ctrl.stats.hits, misses: ctrl.stats.misses, conflicts: ctrl.stats.conflicts, refreshes: ctrl.stats.refreshes, fixed };
}
