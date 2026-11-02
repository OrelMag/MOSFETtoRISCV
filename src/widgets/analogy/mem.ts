// DOM-free models behind the memory figures (merge G): desk (the hierarchy), seesaw (the sense amplifier), island (flash).
// Every number comes from the site's own model: CacheModel, the hierarchy step's table, dram.ts' capacitances, the sense
// offset, switchsim's FG_STEP / FG_READ and flash/model.ts' FlashDevice.

import { CacheModel } from '../../sim/cachemodel';
import { FG_READ, FG_STEP, VDD_VOLTS } from '../../sim/switchsim';
import { CELL_C, BITLINE_C } from '../../lib/dram';
import { FlashDevice } from '../../flash/model';
import { DRAM_OFFSET_MV, type Read } from './model';

// ---- desk: the memory hierarchy ----

/** The four places of the analogy, as the chapter's "The memory hierarchy" table has them (widgets/cache.ts hierarchyWidget):
 *  desk = L1, shelf = L2, library = L3 (shared by the whole department), warehouse = DRAM. Latency in ns for a ~4 GHz core. */
export const DESK_TIERS = [
  { place: 'desk', level: 'L1 cache', capacity: '32–64 KB', ns: 1 },
  { place: 'shelf', level: 'L2 cache', capacity: '0.5–2 MB', ns: 4 },
  { place: 'library', level: 'L3 cache', capacity: '8–64 MB', ns: 12 },
  { place: 'warehouse', level: 'DRAM', capacity: '8–128 GB', ns: 80 },
] as const;

/** The table's own conversion: cycles = ns × 4, at least 1. */
export const tierCycles = (i: number): number => Math.max(1, Math.round(DESK_TIERS[i].ns * 4));

/** The figure's caches are scaled down so a short run shows every level at work: 4 lines of 4 words on the desk (the
 *  size of chapter 22's direct-mapped cache), then 4× and 16× that, in front of a 4 KB warehouse. */
export const LINE_BYTES = 16, DESK_BYTES = [64, 256, 1024] as const, WAREHOUSE_BYTES = 4096;
export type Pattern = 'sequential' | 'random';

export interface DeskAccess {
  addr: number;
  /** 0 desk … 3 warehouse: the nearest place that had the word. */
  tier: number;
  cycles: number;
  /** The line brought to the desk by a miss: its first byte address (null on a desk hit). */
  filled: number | null;
}

export class Desk {
  readonly levels = DESK_BYTES.map((size) => new CacheModel({ size, line: LINE_BYTES, ways: 1, replacement: 'lru', write: 'wb' }));
  readonly log: DeskAccess[] = [];
  total = 0;
  hits = [0, 0, 0, 0];
  private k = 0;
  private rng = 1;

  /** The next address of a pattern: a word at a time through the warehouse, or seeded random words of it. */
  nextAddr(p: Pattern): number {
    if (p === 'sequential') return (4 * this.k++) % WAREHOUSE_BYTES;
    this.rng = (Math.imul(this.rng, 1103515245) + 12345) >>> 0;
    return 4 * ((this.rng >>> 8) % (WAREHOUSE_BYTES / 4));
  }

  access(addr: number): DeskAccess {
    let tier = 3;
    for (let i = 0; i < this.levels.length; i++) if (this.levels[i].access(addr).hit) { tier = i; break; }
    const a: DeskAccess = { addr, tier, cycles: tierCycles(tier), filled: tier > 0 ? addr - (addr % LINE_BYTES) : null };
    this.total += a.cycles;
    this.hits[tier]++;
    this.log.push(a);
    return a;
  }

  get accesses(): number { return this.log.length; }
  /** Average cycles per access (the chapter's AMAT, measured). */
  get average(): number { return this.accesses ? this.total / this.accesses : 0; }

  /** First byte address of the line each desk slot holds (null: empty). */
  deskLines(): (number | null)[] {
    const c = this.levels[0];
    return c.lines.map((ways, set) => (ways[0].valid ? (ways[0].tag * c.sets + set) * LINE_BYTES : null));
  }
}

// ---- seesaw: the sense amplifier ----

/** Bit line minus reference line, in mV, when the cell joins the bit line. Precharged, the line sits at ½ and the move is
 *  (level − ½)·VDD·C_cell / (C_cell + C_bit) (the leaky figure's deltaMv). Not precharged, it is left at the rail the last
 *  sense drove it to (1 = VDD), so the cell can barely move it. The reference line is at ½ either way. */
export function seesawDiffMv(level: number, precharged: boolean): number {
  const start = precharged ? 0.5 : 1;
  const bl = (BITLINE_C * start + CELL_C * level) / (CELL_C + BITLINE_C);
  return (bl - 0.5) * VDD_VOLTS * 1000;
}

export interface Sensed { read: Read; resolved: 0 | 1; cell: 0 | 1; coin: boolean }

/** Sense: the amplifier compares the lines; under its offset it latches X, which settles to either rail (a coin toss).
 *  The cell, still on the bit line, is written back to the rail. */
export function seesawSense(level: number, precharged: boolean, coin: () => boolean = () => Math.random() < 0.5): Sensed {
  const d = seesawDiffMv(level, precharged);
  const x = Math.abs(d) < DRAM_OFFSET_MV;
  const resolved: 0 | 1 = x ? (coin() ? 1 : 0) : d > 0 ? 1 : 0;
  return { read: x ? 'X' : resolved, resolved, cell: resolved, coin: x };
}

// ---- island: the floating gate ----

/** One block's endurance in the chapter's wear widget (widgets/flash.ts: each block good for 400 erases; real TLC 3 000). */
export const ISLAND_ENDURANCE = 400;
/** Pulses to a programmed cell from erased: the first charge level at or above FG_READ. */
export const PULSES_TO_PROGRAM = Math.ceil(FG_READ / FG_STEP - 1e-9);

export class Island {
  q = 0;
  pulses = 0;
  readonly dev = new FlashDevice({ blocks: 1, pagesPerBlock: 1, wordsPerPage: 1 }, ISLAND_ENDURANCE);

  get worn(): boolean { return this.dev.bad[0] === 1; }
  get erases(): number { return this.dev.erases[0]; }

  /** One program pulse: FG_STEP of charge, up to 1 (switchsim's fgmos). */
  program(): boolean {
    if (this.worn) return false;
    this.q = Math.min(1, this.q + FG_STEP);
    this.pulses++;
    return true;
  }
  /** Read at the read voltage: the cell conducts (reads 1) only while the charge is below FG_READ. */
  read(): 0 | 1 { return this.q < FG_READ ? 1 : 0; }
  /** Erase empties the island; the block's count goes up, and past its endurance the erase fails and the block is bad. */
  erase(): boolean {
    const op = this.dev.erase(0);
    if (op.ok) this.q = 0;
    return op.ok;
  }
}
