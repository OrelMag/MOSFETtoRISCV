// The FFT as software (dsp/fftpy.ts): every program compiles and fits its CPU; the radix-2 ones are the DSP core's FFT and the oracle's
// bit for bit; the others stay near the float DFT; src/dsp/fftcosts.json belongs to today's programs and the 16-point ones are measured
// again on the gates; the chapters quote those numbers.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import costs from '../src/dsp/fftcosts.json';
import { FFT_DATA } from '../src/dsp/bench24data';
import { fftCase, FFT_SIZES, FFT_VARIANTS, dftFloat, sourceHash, type FftVariant } from '../src/dsp/fftpy';
import { measureFft } from '../src/dsp/fftmeasure';
import { compilePy } from '../src/lang/compile';
import { runPy } from '../src/lang/interp';
import { BENCH24 } from '../src/dsp/programs24';
import { Iss24 } from '../src/dsp/iss24';
import { assemble24 } from '../src/dsp/asm24';
import { chSpectrum } from '../src/chapters/ch-dsp-spectrum';
import { chDspCore } from '../src/chapters/ch-dsp-core';
import { fftBoth } from '../src/chapters/dspcore/fftboth';
import { fftCost, fftMults } from '../src/chapters/spectrum/fftsw';
import { tick } from './yieldtick';

type Cost = { hash: string; kernel: number; maxErr: number; agrees: boolean; cycles: number; perLine: [number, number, number][] };
const C = costs as unknown as Record<string, Cost>;
const lists = (v: FftVariant, N: number) => {
  const c = fftCase(v, N, FFT_DATA), r = runPy(c.program.source, { maxSteps: 10_000_000, maxDepth: 400 });
  return { re: r.lists.get(c.program.out.re)!, im: r.lists.get(c.program.out.im)!, bins: c.program.out.bins, c };
};

describe('the FFT programs', () => {
  it('compile for RV32IM and fit their ROM and data memory', () => {
    for (const N of FFT_SIZES) for (const v of FFT_VARIANTS) {
      const c = fftCase(v, N, FFT_DATA), k = compilePy(c.program.source, { dmemWords: 2 ** c.dmemK, m: true });
      expect(k.error, `${v}${N}`).toBeNull();
      expect(k.words.length, `${v}${N}`).toBeLessThanOrEqual(2 ** c.imemK);
    }
  });

  it('radix 2, recursive and in place: the DSP core\'s 64-point FFT and the oracle, word for word', () => {
    const b = BENCH24.find((x) => x.id === 'fft')!, iss = new Iss24(assemble24(b.src).words, b.x, b.y);
    for (let i = 0; i < 100_000 && !iss.halted; i++) iss.step();
    const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v), dsp = iss.out.map(s16);
    const oracle = JSON.parse(readFileSync('tests/dsp/vectors/dspcore.json', 'utf8')).fft;
    for (const v of ['rec', 'iter'] as const) {
      const r = lists(v, 64);
      expect(r.re, v).toEqual(dsp.slice(0, 64));
      expect(r.im, v).toEqual(dsp.slice(64));
      expect(r.re, v).toEqual(oracle.yre);
      expect(r.im, v).toEqual(oracle.yim);
    }
  });

  it('every program within its recorded error of the float DFT, all under 3', () => {
    for (const N of FFT_SIZES) for (const v of FFT_VARIANTS) {
      const r = lists(v, N), ref = dftFloat(r.c.re, r.c.im);
      let e = 0;
      for (let k = 0; k < r.bins; k++) e = Math.max(e, Math.abs(r.re[k] - ref.re[k]), Math.abs(r.im[k] - ref.im[k]));
      expect(Math.round(e * 100) / 100, `${v}${N}`).toBe(C[`${v}${N}`].maxErr);
      expect(e).toBeLessThan(3);
    }
  });
});

describe('the measured costs', () => {
  it('belong to today\'s programs (rerun scripts/fft-costs.ts --write after changing one), and the gates agreed with the interpreter', () => {
    for (const N of FFT_SIZES) for (const v of FFT_VARIANTS) {
      expect(C[`${v}${N}`].hash, `${v}${N}: rerun scripts/fft-costs.ts --write`).toBe(sourceHash(fftCase(v, N, FFT_DATA).program.source));
      expect(C[`${v}${N}`].agrees, `${v}${N}`).toBe(true);
    }
  });

  it('the 16-point radix-2 and radix-4 programs measured again on the gates', async () => {
    for (const v of ['iter', 'fast'] as const) {
      const m = await measureFft(fftCase(v, 16, FFT_DATA), tick);
      expect({ cycles: m.cycles, kernel: m.kernel, agrees: m.agrees }, v).toEqual({ cycles: C[`${v}16`].cycles, kernel: C[`${v}16`].kernel, agrees: true });
    }
  }, 180_000);

  it('each faster program is faster, at 16 and 64 points', () => {
    for (const N of FFT_SIZES) {
      const k = (v: FftVariant) => fftCost(v, N).kernel;
      expect(k('rec')).toBeLessThan(k('dft'));
      expect(k('fast')).toBeLessThan(k('iter'));
      expect(k('real')).toBeLessThan(k('iter'));
    }
    expect(fftCost('iter', 64).kernel).toBeLessThan(fftCost('rec', 64).kernel);
    expect([fftMults('rec', 64), fftMults('fast', 64), fftMults('dft', 64)]).toEqual([768, 324, 16384]);
  });
});

describe('the chapters', () => {
  it('spectrum: the FFT steps come last, before the recap, with a scene each', () => {
    const t = chSpectrum.steps.map((s) => s.title);
    expect(t.slice(-4)).toEqual(['The FFT as a program', 'In place, by loops', 'Making it fast', 'Real input, half the work']);
    expect(t[7]).toBe('A keypad in gates');
    for (const s of chSpectrum.steps.slice(-4)) expect(s.scene).toBeTruthy();
  });

  it('dspcore: the comparison is the last step, and the core beats both RV32IM programs in time', () => {
    expect(chDspCore.steps.at(-1)!.title).toBe('The same FFT on both');
    const f = fftBoth();
    expect(f.dsp).toBe(4512);
    expect(f.scT).toBeGreaterThan(f.fastT);
    expect(f.fastT).toBeGreaterThan(f.dspT);
    expect(f.productsPerButterfly).toBeLessThan(f.perButterfly / 2);
    expect(chDspCore.steps.at(-2)!.body).not.toContain('no RV32 figure');
  });
});
