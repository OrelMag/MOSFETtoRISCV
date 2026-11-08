// The memory hierarchy's figures, one source for the step's table (widgets/cache.ts hierarchyWidget) and its 3D model
// (hierarchy3dparts.ts). Desktop-core numbers in nanoseconds; cycles are ns × CORE_GHZ. They are NOT the site's model
// clock (dram/timing.ts CLOCK_NS, flash/model.ts FLASH_TIMES count cycles of the chapters' single-cycle CPU): mixing the
// two would put flash nearer than DRAM.
//
// Sources (orders of magnitude; they vary by product):
//  - Registers: one cycle of a 4 GHz core, 0.25 ns (Hennessy & Patterson, Computer Architecture: A Quantitative Approach, 6th ed., ch. 2 and App. B).
//  - L1 4-5 cycles, L2 12-15 cycles: measured on Intel Golden Cove (L1D 5 cycles, L2 ~15) and Willow Cove (L2 14), Chips and Cheese,
//    "Going Armchair Quarterback on Golden Cove's Caches" (chipsandcheese.com, 2022-02-11); H&P ch. 2 for the ladder.
//  - L3 40+ cycles and DRAM 200+ cycles: H&P ch. 2 (a last-level hit tens of cycles, a DRAM access ~50-100 ns); measured loaded
//    DRAM latency of a desktop part is 60-100 ns, of which the JEDEC DDR4-3200 CL22 column access alone is 13.75 ns.
//  - Flash: a NAND page read, tR. SK hynix H27UCG8T2ATR (MLC) datasheet: tR 60 us typical, 80 us maximum (rapptor.vub.ac.be/Education/2BAIW/CAD/pdf/h27ucg8t2atr.pdf);
//    Micron's SLC parts are 25 us. An NVMe read adds controller and software time on top, still tens of us.

export const CORE_GHZ = 4;

export interface HLevel {
  id: 'reg' | 'l1' | 'l2' | 'l3' | 'dram' | 'ssd';
  name: string; cap: string; ns: number; built: string;
  /** The analogy's place (chapters/analogies.ts 'cache' and its desk figure: desk = L1, shelf = L2, library = L3, a warehouse
   *  across town = DRAM). The registers are part of the core; the SSD, which the analogy leaves out, is another city. */
  place: 'core' | 'desk' | 'shelf' | 'library' | 'warehouse' | 'city';
  /** A real part with this latency, for the readout. */
  real: string;
}

export const LEVELS: HLevel[] = [
  { id: 'reg', name: 'Registers', cap: '~1 KB', ns: 0.25, built: 'flip-flops, in the datapath', place: 'core', real: 'one cycle of a 4 GHz core' },
  { id: 'l1', name: 'L1 cache', cap: '32–64 KB', ns: 1, built: '6T SRAM, per core, split I / D', place: 'desk', real: 'Golden Cove L1D: 48 KB, 5 cycles' },
  { id: 'l2', name: 'L2 cache', cap: '0.5–2 MB', ns: 3.5, built: 'SRAM, per core', place: 'shelf', real: 'Willow Cove L2: 1.25 MB, 14 cycles; Golden Cove ~15' },
  { id: 'l3', name: 'L3 cache', cap: '8–64 MB', ns: 12, built: 'SRAM, shared by all cores', place: 'library', real: 'a shared last-level cache: 40+ cycles' },
  { id: 'dram', name: 'DRAM', cap: '8–128 GB', ns: 80, built: '1T1C, off chip, refreshed', place: 'warehouse', real: 'DDR4-3200 loaded latency, 60–100 ns (CL22 alone: 13.75 ns)' },
  { id: 'ssd', name: 'NVMe SSD', cap: '1–8 TB', ns: 80_000, built: 'flash, through the OS', place: 'city', real: 'NAND page read: SK hynix H27UCG8T2ATR tR 60 µs typ., 80 µs max' },
];

/** Cycles of the core clock, as the table shows them. */
export const cyclesOf = (ns: number): number => Math.max(1, Math.round(ns * CORE_GHZ));

/** The "real" paragraph's ranges in the cache chapter, in core cycles: L1 4 to 5, L2 12 to 15, L3 40 or more, DRAM 200 or more. */
export const REAL_CYCLES: Record<'l1' | 'l2' | 'l3' | 'dram', [number, number]> = {
  l1: [4, 5], l2: [12, 15], l3: [40, Infinity], dram: [200, Infinity],
};
