import { describe, expect, it } from 'vitest';
import { CLIP_PEAK, prepareClip } from '../src/dsp/clip';

describe('a clip made ready to play', () => {
  it('never exceeds the limit, whatever a wrapped or unstable filter hands it', () => {
    for (const a of [1e9, 1, 1e-6]) {
      const out = Array.from(prepareClip(Array.from({ length: 1000 }, (_, i) => a * Math.sin(i))));
      expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(CLIP_PEAK + 1e-6);
      expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(0.25);
    }
    const scaled = prepareClip([10, -10, 10, -10], { scale: 1, fade: 0 });
    expect(Array.from(scaled).every((v) => Math.abs(v) <= CLIP_PEAK + 1e-6)).toBe(true);
  });
  it('starts and ends at silence, and stays silent on silence', () => {
    const out = prepareClip(new Array<number>(1000).fill(1));
    expect(out[0]).toBe(0); expect(out[999]).toBe(0);
    expect(Array.from(prepareClip(new Array<number>(10).fill(0))).every((v) => v === 0)).toBe(true);
  });
});
