// The puzzles' reference programs on their computers' gates: pass / fail per test, cycles, words, NANDs.
//   npx vite-node scripts/puzzles.ts [--cpu cpu4|rv16|rv32] [--puzzle <id>] [--write]
// --write saves every measurement into src/puzzles/refdata.json (the pars; tests/puzzles.test.ts checks it).

import { writeFileSync } from 'node:fs';
import '../src/lib';
import { REF_COMPUTERS, type RefCpu } from '../src/puzzles/computers';
import { measureOn } from '../src/puzzles/measure';
import { PUZZLES } from '../src/puzzles/puzzles';
import { REFS, type RefData } from '../src/puzzles/refs';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const onlyCpu = arg('--cpu') as RefCpu | undefined, onlyPz = arg('--puzzle');
const write = process.argv.includes('--write');

const data: RefData = {};
let bad = 0;
for (const p of PUZZLES) {
  if (onlyPz && p.id !== onlyPz) continue;
  for (const c of REF_COMPUTERS) {
    if (onlyCpu && c.id !== onlyCpu) continue;
    const src = REFS[c.id][p.id];
    if (!src) { console.log(`${p.id.padEnd(12)} ${c.id.padEnd(5)} —`); continue; }
    const { run, point, diags } = measureOn(c.id, p, src);
    if (!run.ok) bad++;
    console.log(`${p.id.padEnd(12)} ${c.id.padEnd(5)} ${run.ok ? 'PASS' : 'FAIL'} cycles ${String(point.cycles).padStart(7)}  words ${String(point.words).padStart(3)}  NANDs ${point.nands}`);
    for (const d of diags) console.log(`    diag: ${d}`);
    for (const pr of run.problems) console.log(`    problem: ${pr}`);
    for (const r of run.results) if (!r.ok) console.log(`    ${r.name}: ${r.why}\n      in ${r.input.join(' ')}\n      expected ${r.expect.join(' ')}\n      got ${r.got.join(' ')}`);
    if (run.ok) (data[p.id] ??= []).push(point);
  }
}
if (write) {
  if (bad || onlyCpu || onlyPz) console.log('not written: run every reference, all passing');
  else {
    writeFileSync(new URL('../src/puzzles/refdata.json', import.meta.url), `${JSON.stringify(data, null, 1)}\n`);
    console.log('wrote src/puzzles/refdata.json');
  }
}
process.exitCode = bad ? 1 : 0;
