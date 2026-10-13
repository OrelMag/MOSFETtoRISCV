// Long checks of the transistor-level 6502 against the ISS, in slices that run in parallel processes
// (the cache: node scripts/m6502/fetch-tests.mjs):
//   npx vite-node scripts/m6502/chip-full.ts sst <first> <last>      SingleStepTests, opcodes first..last (hex), all 10 000 cases each
//   npx vite-node scripts/m6502/chip-full.ts klaus <start> <cycles>   Klaus Dormann's test: the ISS runs to the first instruction
//        boundary at or after cycle <start>, the chip takes over its registers (a loader program) and memory, and the two
//        run <cycles> cycles in lock-step, every bus cycle compared
import { readFileSync } from 'node:fs';
import { Chip6502 } from '../../src/m6502/chip';
import { OPCODES } from '../../src/m6502/isa';
import { Cpu6502, Ram64 } from '../../src/m6502/iss';
import { type StepCase, StepRunner } from '../../src/m6502/verify';

const [mode, a, b] = process.argv.slice(2);
const t0 = performance.now();
const hex = (v: number) => v.toString(16);

if (mode === 'sst') {
  const runner = new StepRunner();
  let n = 0, bad = 0;
  for (const o of OPCODES) {
    if (!o || o.op < parseInt(a, 16) || o.op > parseInt(b, 16)) continue;
    const key = o.op.toString(16).padStart(2, '0');
    const raw = JSON.parse(readFileSync(`tests/m6502/.cache/${key}.json`, 'utf8')) as { initial: Raw; final: Raw; cycles: [number, number, string][] }[];
    let fails = 0;
    for (const [i, t] of raw.entries()) {
      const e = runner.run([st(t.initial), st(t.final), t.cycles.flatMap(([x, d, k]) => [x, d, k === 'write' ? 1 : 0])] as StepCase);
      n++;
      if (e) { bad++; if (fails++ < 3) console.log(`${key} #${i}: ${e}`); }
    }
    console.log(`${key} ${o.mnemonic} ${o.mode}: ${raw.length} cases, ${fails} failing`);
  }
  console.log(`DONE sst ${a}..${b}: ${n} cases, ${bad} failing, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(bad ? 1 : 0);
}

interface Raw { pc: number; s: number; a: number; x: number; y: number; p: number; ram: [number, number][] }
function st(r: Raw) { return [r.pc, r.s, r.a, r.x, r.y, r.p, r.ram.flat()]; }

if (mode === 'klaus') {
  const start = Number(a), len = Number(b);
  const ram = new Ram64();
  ram.mem.set(readFileSync('tests/m6502/.cache/6502_functional_test.bin'));
  const iss = new Cpu6502(ram);
  iss.pc = 0x400;
  while (iss.cycles < start) iss.step();
  // the chip: a loader puts the ISS's registers in place, then jumps to its PC; memory is the ISS's from there on
  const loader = new Uint8Array(65536);
  loader.set([0xa2, iss.s, 0x9a, 0xa9, iss.p, 0x48, 0xa9, iss.a, 0xa2, iss.x, 0xa0, iss.y, 0x28, 0x4c, iss.pc & 0xff, iss.pc >> 8], 0xf000);
  loader[0xfffd] = 0xf0;
  let loading = true;
  const mem = new Ram64();
  mem.mem.set(ram.mem);
  const chip = new Chip6502({ read: (x) => (loading ? loader[x] : mem.read(x)), write: (x, v) => (loading ? (loader[x] = v) : mem.write(x, v)) });
  chip.reset(2);
  for (let i = 0; i < 7 + 22; i++) chip.cycle();
  loading = false;
  for (let c = 0; c < len; c++) {
    iss.tick(); chip.cycle();
    if (iss.busAddr !== chip.addr || iss.busData !== chip.data || iss.busWrite !== chip.write || iss.busSync !== chip.sync) {
      console.log(`FAIL klaus at cycle ${iss.cycles}: iss ${hex(iss.busAddr)} ${hex(iss.busData)} ${iss.busWrite ? 'w' : 'r'} s${iss.busSync}, chip ${hex(chip.addr)} ${hex(chip.data)} ${chip.write ? 'w' : 'r'} s${chip.sync}`);
      process.exit(1);
    }
    if (iss.pc === 0x3469 && iss.atBoundary) { console.log(`reached the success trap at cycle ${iss.cycles}`); break; }
  }
  console.log(`DONE klaus ${start} +${len}: ok through cycle ${iss.cycles}, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
