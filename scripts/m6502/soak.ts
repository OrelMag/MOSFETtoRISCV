// The transistor-level 6502 against the ISS, longer than the unit tests: every SingleStepTests sample
// case (25 per opcode), long lock-step runs with random interrupts, and Klaus Dormann's functional
// test for as many cycles as asked (needs the cache: node scripts/m6502/fetch-tests.mjs).
//   npx vite-node scripts/m6502/soak.ts [--klaus <cycles>] [--seeds <n>]
import { existsSync, readFileSync } from 'node:fs';
import { assemble, toImage } from '../../src/m6502/asm';
import { Chip6502 } from '../../src/m6502/chip';
import { Cpu6502, Ram64 } from '../../src/m6502/iss';
import { PROGRAMS } from '../../src/m6502/programs';
import { lockstep, type StepCase, StepRunner } from '../../src/m6502/verify';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
let fails = 0;
let t0 = performance.now();
const sample = JSON.parse(readFileSync('tests/m6502/singlestep-sample.json', 'utf8')) as Record<string, StepCase[]>;
const runner = new StepRunner();
let n = 0;
for (const [k, cases] of Object.entries(sample)) for (const [i, c] of cases.entries()) {
  const e = runner.run(c);
  n++;
  if (e) { fails++; console.log(`SST ${k} #${i}: ${e}`); }
}
console.log(`SingleStepTests sample: ${n} cases, ${fails} failing, ${((performance.now() - t0) / 1000).toFixed(1)} s`);

t0 = performance.now();
const chip = new Chip6502(new Ram64());
const seeds = arg('--seeds', 10);
let cyc = 0;
for (const p of PROGRAMS) for (let seed = 1; seed <= seeds; seed++) {
  let x = seed, irq = false, nmi = false;
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const e = lockstep(chip, toImage(assemble(p.source)), 4000, () => { if (rnd() < 0.01) irq = !irq; if (rnd() < 0.004) nmi = !nmi; return { irq, nmi }; });
  cyc += 4000;
  if (e) { fails++; console.log(`${p.name} seed ${seed}: ${e}`); }
}
const dt = (performance.now() - t0) / 1000;
console.log(`lock-step with interrupts: ${cyc} cycles, ${(cyc / dt).toFixed(0)} cycles/s (ISS and chip together)`);

const kc = arg('--klaus', 0);
if (kc && existsSync('tests/m6502/.cache/6502_functional_test.bin')) {
  const img = new Uint8Array(65536);
  img.set(readFileSync('tests/m6502/.cache/6502_functional_test.bin'));
  // start at $0400 through the reset vector
  img[0xfffc] = 0x00; img[0xfffd] = 0x04;
  t0 = performance.now();
  const e = lockstep(new Chip6502(new Ram64()), img, kc);
  if (e) { fails++; console.log(`Klaus: ${e}`); }
  console.log(`Klaus functional test: ${kc} cycles in lock-step, ${e ? 'FAILED' : 'ok'}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
void Cpu6502;
process.exit(fails ? 1 : 0);
