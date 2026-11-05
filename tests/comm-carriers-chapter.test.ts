// Many carriers on the page: what its challenges claim, on the gates and the model, and the chapter's place in the book.
import { describe, expect, it } from 'vitest';
import { chCarriers } from '../src/chapters/ch-comm-carriers';
import { chModem } from '../src/chapters/ch-comm-modem';
import { numOf } from '../src/chapters/order';
import { moveStep } from '../src/chapters/stepmoves';
import { flatPower, waterFill } from '../src/comm/carriers';
import { bitRev, FftStream, packFx, unpackFx } from '../src/comm/fftfix';
import { fftNet, fxButterfly } from '../src/lib/fft';
import { evalOnce, simulate } from '../src/sim/harness';
import { BF_K, BF_N, block8, nearZero, polar, STREAM_N } from '../src/widgets/carriers';

const W = 10;

describe('the chapter', () => {
  it('holds the moved steps at the places the table says, and follows Modems', () => {
    expect(chCarriers.steps[moveStep('modem', 7).step].title).toBe('Many tones, one FFT');
    expect(chCarriers.steps[moveStep('modem', 8).step].title).toBe('ADSL: many carriers');
    expect(numOf('carriers')).toBe(numOf('modem') + 1);
    expect(chModem.steps.at(-1)!.title).toBe('300 b/s to 56 kb/s');
    expect(chCarriers.steps.length).toBeLessThan(15);
  });
  it('every step has text and something to look at or answer', () => {
    for (const s of chCarriers.steps) { expect(s.body.length).toBeGreaterThan(200); expect(!!s.scene || !!s.widget || !!s.challenge, s.title).toBe(true); }
  });
  it('types no chapter number and no stale pointers', () => {
    for (const s of chCarriers.steps) {
      expect(s.body, s.title).not.toMatch(/chapter \d/i);
      expect(s.body, s.title).not.toMatch(/the last step's inverse FFT|This chapter keeps it a model/);
    }
  });
});

describe('what the challenges say', () => {
  it('the butterfly: b 45° ahead of a at the same size leaves y1 at rounding', () => {
    const sim = simulate(fxButterfly(W, BF_K, BF_N)), [, y1] = evalOnce(sim, [packFx(polar(0.6, 0), W), packFx(polar(0.6, 45), W)]);
    expect(nearZero(y1)).toBe(true);
    const [, far] = evalOnce(sim, [packFx(polar(0.6, 0), W), packFx(polar(0.6, 225), W)]);
    expect(nearZero(far)).toBe(false);
  });
  it('the network: tone 3 lands on X3, and only there', () => {
    const got = evalOnce(simulate(fftNet(8, W)), block8('tone', 3).map((c) => packFx(c, W))).map((v: number) => { const c = unpackFx(v, W); return Math.hypot(c.re, c.im) / 512; });
    expect(got[3]).toBeGreaterThan(0.8);
    got.forEach((v: number, i: number) => { if (i !== 3) expect(v, `X${i}`).toBeLessThan(0.03); });
  });
  it('the stream: tone 5 arrives eleventh, and has the largest bar', () => {
    const N = STREAM_N, x = Array.from({ length: N }, (_, n) => polar(0.8, (360 * 5 * n) / N)), t = FftStream.transform(x, W), mags = t.map((c) => Math.hypot(c.re, c.im));
    expect(mags.indexOf(Math.max(...mags))).toBe(5);
    expect(bitRev(10, 4)).toBe(5);
  });
  it('the water-filling quiz', () => {
    const p = waterFill([1, 2], 3);
    expect(p.power[0]).toBeCloseTo(1.25); expect(p.power[1]).toBeCloseTo(1.75);
    expect(flatPower([1, 2], 3).total).toBeLessThan(p.total);
  });
});
