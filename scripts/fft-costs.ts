// The FFT programs of src/dsp/fftpy.ts measured on the gate-level pipelined RV32IM (cycle engine), cycle by cycle with PipeProfile: cycles,
// instructions, stalls, flushes, the costliest lines; the single-cycle RV32IM's count (one instruction a clock: the golden model's steps); the
// error against a float DFT. npx vite-node scripts/fft-costs.ts [--write] (about 10 minutes: the 64-point programs run on a 459 000-NAND
// CPU). --write saves src/dsp/fftcosts.json, which tests/fft-software.test.ts holds to the programs (a hash of each source) and re-measures
// at 16 points.

import { writeFileSync } from 'node:fs';
import { FFT_DATA } from '../src/dsp/bench24data';
import { FFT_VARIANTS, fftCase, FFT_SIZES } from '../src/dsp/fftpy';
import { measureFft } from '../src/dsp/fftmeasure';

const write = process.argv.includes('--write');
const out: Record<string, unknown> = {};
const only = process.argv.filter((a) => /^\d+$/.test(a)).map(Number);
for (const N of FFT_SIZES) {
  if (only.length && !only.includes(N)) continue;
  for (const v of FFT_VARIANTS) {
    const t = Date.now();
    const m = await measureFft(fftCase(v, N, FFT_DATA));
    out[`${v}${N}`] = m;
    console.log(`${v}${N}`.padEnd(8), JSON.stringify({ cycles: m.cycles, kernel: m.kernel, kI: m.kernelInstrs, instrs: m.instrs, stall: m.stall, flush: m.flush, err: m.maxErr, words: m.words }), `${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
}
if (write) {
  writeFileSync('src/dsp/fftcosts.json', JSON.stringify(out, null, 1) + '\n');
  console.log('wrote src/dsp/fftcosts.json');
}
