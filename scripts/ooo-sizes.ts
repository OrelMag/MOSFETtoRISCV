// The out-of-order core's cost by window size (chapter 26's lab, roadmap Phase 17e): for every reorder buffer × issue
// queue × store queue size the gate-level core is built (lib/ooocore.ts oooCpu({ rob, iq, sq })) and measured as the
// benchmarks measure a CPU (tests/verify/bench.ts measureCpu: NANDs without the program ROM, the static-timing period
// in NAND delays), with the NANDs of the units the sizes change. Prints a table; with --write, saves
// src/bench/ooosizes.json (checked in; tests/ooosizes-cost.test.ts holds it to the generators and to results.json).
//   npx vite-node scripts/ooo-sizes.ts [--write] [--only rob,iq,sq]
import { writeFileSync } from 'node:fs';
import { OOO_SIZES, type OooSizes } from '../src/lib/ooo';
import { PS_PER_NAND } from '../src/sim/timing';
import { BENCH_DMEM_K, BENCH_IMEM_K } from '../tests/verify/bench';
import { IQ_SIZES, measureSize, ROB_SIZES, SIZED_UNITS, sizeProgram, SQ_SIZES, type SizePoint } from '../tests/verify/ooosizes';

const args = process.argv.slice(2), write = args.includes('--write');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map(Number) : null;
if (write && only) throw new Error('--write measures the whole grid');
const grid: OooSizes[] = only ? [{ rob: only[0], iq: only[1], sq: only[2] }]
  : ROB_SIZES.flatMap((rob) => IQ_SIZES.flatMap((iq) => SQ_SIZES.map((sq) => ({ rob, iq, sq }))));
const words = sizeProgram(), points: SizePoint[] = [], t0 = performance.now();
for (const z of grid) {
  const t1 = performance.now(), p = measureSize(z, words);
  points.push(p);
  console.log(`ROB ${String(z.rob).padStart(2)}  IQ ${String(z.iq).padStart(2)}  SQ ${z.sq}  ${String(p.nands).padStart(7)} NAND  period ${String(p.period).padStart(3)} (load ${p.periodLoad})  `
    + `${SIZED_UNITS.map((n) => `${n} ${p.units[n]}`).join('  ')}  path ${p.path.join(' → ')}  (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
}
console.log(`total ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (write) {
  const out = {
    note: 'The gate-level out-of-order core (lib/ooocore.ts) by window size: NANDs without the program ROM and the static-timing period in NAND delays, as src/bench/results.json measures a CPU (the default point is its ooo row); periodLoad: the period under the load-dependent delay model (sim/delay.ts); path: the top-level instances the critical path crosses; units: NANDs of the reorder buffer, issue queue, store queue and rename table. Written by scripts/ooo-sizes.ts.',
    psPerNand: PS_PER_NAND, imemWords: 2 ** BENCH_IMEM_K, dmemWords: 2 ** BENCH_DMEM_K, default: OOO_SIZES,
    rob: ROB_SIZES, iq: IQ_SIZES, sq: SQ_SIZES, points,
  };
  writeFileSync(new URL('../src/bench/ooosizes.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  console.log('wrote src/bench/ooosizes.json');
}
