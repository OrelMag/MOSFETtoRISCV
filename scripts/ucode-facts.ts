// The microcode painter's numbers, measured: the book's microprogram and the chapter's answer (I-type in three cycles)
// against riscv-tests and the benchmarks. Written to src/bench/ucodefacts.json, which the multicycle chapter's text
// reads; tests/ucode.test.ts re-measures and fails when they differ. Run: npx vite-node scripts/ucode-facts.ts [--write]

import { writeFileSync } from 'node:fs';
import '../src/lib';
import { measureUcodeFacts } from '../tests/ucodefacts';

const facts = await measureUcodeFacts();
console.log(JSON.stringify(facts, null, 2));
if (process.argv.includes('--write')) writeFileSync(new URL('../src/bench/ucodefacts.json', import.meta.url), `${JSON.stringify(facts, null, 2)}\n`);
