// Chapter float's "Narrower and wider" comparison: the adder, multiplier and fma of lib/fpu.ts built at six formats, measured
// once (NANDs from stats(), depth from logicDepth()) and kept here as plain numbers so the chapter imports no circuit
// (float64's fma alone is 70 000 NANDs). tests/fpformats.test.ts rebuilds and re-measures every one.
// `tree` is the significand multiplier's own NANDs inside fpMul, `round` its normalize & round.

import type { FpFormat } from '../sim/fpref';

export interface FormatInfo { id: string; name: string; short: string; f: FpFormat }

/** The formats compared, narrowest first. E5M2 and the chapter's E4M3 follow the IEEE rules (exponent all ones = ∞ / NaN). */
export const FORMAT_LIST: FormatInfo[] = [
  { id: 'e5m2', name: 'FP8 E5M2', short: 'E5M2', f: { E: 5, M: 2 } },
  { id: 'e4m3', name: 'FP8 E4M3 (this chapter\'s)', short: 'E4M3', f: { E: 4, M: 3 } },
  { id: 'f16', name: 'binary16', short: 'f16', f: { E: 5, M: 10 } },
  { id: 'bf16', name: 'bfloat16', short: 'bf16', f: { E: 8, M: 7 } },
  { id: 'f32', name: 'float32', short: 'f32', f: { E: 8, M: 23 } },
  { id: 'f64', name: 'float64', short: 'f64', f: { E: 11, M: 52 } },
];

interface UnitCost { nands: number; depth: number }

export const FORMAT_COSTS: Record<string, { add: UnitCost; mul: UnitCost & { tree: number; round: number }; fma: UnitCost }> = {
  e5m2: { add: { nands: 2344, depth: 145 }, mul: { nands: 2080, depth: 115, tree: 143, round: 1446 }, fma: { nands: 4846, depth: 207 } },
  e4m3: { add: { nands: 2553, depth: 151 }, mul: { nands: 2405, depth: 121, tree: 242, round: 1676 }, fma: { nands: 5222, depth: 209 } },
  f16: { add: { nands: 3785, depth: 163 }, mul: { nands: 4965, depth: 150, tree: 1696, round: 2666 }, fma: { nands: 10021, depth: 230 } },
  bf16: { add: { nands: 4976, depth: 169 }, mul: { nands: 5617, depth: 144, tree: 911, round: 3659 }, fma: { nands: 11481, depth: 235 } },
  f32: { add: { nands: 8218, depth: 181 }, mul: { nands: 14913, depth: 176, tree: 7524, round: 6118 }, fma: { nands: 26348, depth: 270 } },
  f64: { add: { nands: 15256, depth: 205 }, mul: { nands: 47573, depth: 200, tree: 34508, round: 11334 }, fma: { nands: 70139, depth: 306 } },
};

/** Largest finite value, smallest normal, smallest subnormal: exact doubles for every format here (float64 included). */
export function formatRange(f: FpFormat): { max: number; minNormal: number; minSub: number; emax: number } {
  const emax = 2 ** (f.E - 1) - 1;
  return { max: (2 - 2 ** -f.M) * 2 ** emax, minNormal: 2 ** (1 - emax), minSub: 2 ** (1 - emax - f.M), emax };
}
