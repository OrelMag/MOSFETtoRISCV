// FIR design and IIR and stability quote the same mask's figures (written on separate branches): one reading of the mask, one set of answers.
import { describe, expect, it } from 'vitest';
import fir from './dsp/vectors/firdesign.json';
import iir from './dsp/vectors/iir.json';
import { MASK as FIR_MASK } from '../src/dsp/firdesign';
import { MASK as IIR_MASK } from '../src/dsp/iir';
import { PM_TAPS } from '../src/widgets/dspiir';

describe('the two filter chapters agree', () => {
  it('on the mask: the same edges and ripple, read as peak to peak by both', () => {
    expect(FIR_MASK.pass).toBeCloseTo(IIR_MASK.fp, 12);
    expect(FIR_MASK.stop).toBeCloseTo(IIR_MASK.fs, 12);
    expect(FIR_MASK.rippleDb).toBe(IIR_MASK.rp);
    expect(FIR_MASK.stopDb).toBe(IIR_MASK.rs);
    expect(iir.fir.dp).toBeCloseTo(fir.mask.deltaPass, 10);
    expect(iir.fir.ds).toBeCloseTo(fir.mask.deltaStop, 12);
  });
  it('on what scipy says it takes: Parks–McClellan 114, or 115 odd; Kaiser 147 odd', () => {
    expect(iir.fir.pm).toBe(fir.fewest.remez);
    expect(iir.fir.pm_odd).toBe(fir.fewest.remez + 1);
    expect(PM_TAPS).toBe(iir.fir.pm_odd);
    expect(iir.fir.kaiser).toBe(fir.fewest.kaiserord);
  });
});
