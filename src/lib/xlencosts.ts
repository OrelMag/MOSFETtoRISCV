// Chapter 25's width comparison, measured on lib/cpu64.ts xlenCpu (defaults: 64-word ROM, 32-word data memory, Kogge–Stone
// adders) and kept here as plain numbers so the chapter imports no circuit. tests/cpu64.test.ts rebuilds and remeasures
// every one. NANDs: the program ROM left out (as the benchmarks count them); period: static timing, in NAND delays.

export const XLEN_COSTS = {
  /** The whole core, M included / without M. */
  rv32im: { nands: 73384, period: 124 },
  rv64im: { nands: 172285, period: 150 },
  rv32i: { nands: 52830, period: 103 },
  rv64i: { nands: 106445, period: 117 },
  /** The W unit (64 only): two operand multiplexers, a result multiplexer, wiring; depth in NAND delays. */
  wUnit: { nands: 782, depth: 7 },
  /** The immediate's sign extension from 32 to 64 bits: wiring. */
  immExt: 0,
  /** Blocks at 32 / 64 bits. */
  mUnit: { 32: 20392, 64: 65555 },
  /** Store alignment + load extraction. */
  lsu: { 32: 1509, 64: 3263 },
  /** The data memory: 32 words of the register width, in byte banks. */
  dmem: { 32: 20636, 64: 41272 },
  regfile: { 32: 23141, 64: 45957 },
  alu: { 32: { nands: 3196, depth: 46 }, 64: { nands: 6940, depth: 50 } },
  /** The decode the control unit does not do (M; at 64 also OP-32 / OP-IMM-32). */
  decode: { 32: 31, 64: 37 },
} as const;
