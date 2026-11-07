// What "A DSP core" says in words, held to what the code measures: the figures file, the model's cycle counts, the instruction count, the scipy answers.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { chDspCore } from '../src/chapters/ch-dsp-core';
import { DSP_LEVEL } from '../src/chapters/dspladder';
import figures from '../src/bench/dspcore.json';
import { assemble24 } from '../src/dsp/asm24';
import { BIQUAD_DATA, DOT_DATA, FFT_DATA, FIR16_DATA, FIR64_DATA } from '../src/dsp/bench24data';
import { INSTRS24 } from '../src/dsp/isa24';
import { Iss24 } from '../src/dsp/iss24';
import { BENCH24 } from '../src/dsp/programs24';
import { DSP24_DECODE, } from '../src/lib/dsp24';
import { dsp24Core } from '../src/lib/dsp24core';
import { dspPerProduct } from '../src/widgets/dspcore';
import { stats } from '../src/sim/stats';

const V = JSON.parse(readFileSync('tests/dsp/vectors/dspcore.json', 'utf8'));

describe('A DSP core', () => {
  it('is on the signal processing level, with a recap of three quizzes', () => {
    expect(chDspCore.level).toBe(DSP_LEVEL);
    expect(chDspCore.recap!.check).toHaveLength(3);
    expect(chDspCore.steps.length).toBe(8);
  });
  it('the benchmark data in src are the oracle\'s', () => {
    expect(FIR16_DATA.h).toEqual(V.fir16.h); expect(FIR16_DATA.x).toEqual(V.fir16.x);
    expect(FIR64_DATA.h).toEqual(V.fir64.h); expect(BIQUAD_DATA.sections).toEqual(V.biquad.sections);
    expect(DOT_DATA.x).toEqual(V.dot.x); expect(FFT_DATA.wr).toEqual(V.fft.wr);
  });
  it('the figures file is what the gates and the model measure now', () => {
    expect(stats(dsp24Core()).nands).toBe(figures.nands.core);
    expect(stats(DSP24_DECODE).nands).toBe(figures.nands.decode);
    for (const b of BENCH24) {
      const iss = new Iss24(assemble24(b.src).words, b.x, b.y);
      iss.run();
      expect(iss.steps, b.id).toBe((figures.cycles as Record<string, { cycles: number }>)[b.id].cycles);
    }
  });
  it('the prose\'s instruction count and per-product range', () => {
    expect(INSTRS24).toHaveLength(27);
    const per = (['fir16', 'fir64', 'biquad', 'dot'] as const).map(dspPerProduct);
    expect(Math.min(...per)).toBeGreaterThanOrEqual(1.05 - 0.005);
    expect(Math.max(...per)).toBeLessThan(1.525);
  });
  it('every Try box is pinned by a test', () => {
    for (const s of chDspCore.steps) {
      const body = typeof s.body === 'string' ? s.body : '';
      const tries = (body.match(/class="try"/g) ?? []).length;
      expect(tries <= 1).toBe(true);
    }
  });
});
