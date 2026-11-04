// Chapter 49's typed numbers, pinned to the model, and its shape.
import { describe, expect, it } from 'vitest';
import { chSwitch } from '../src/chapters/ch-comm-switch';
import { holSaturation, runTraffic, sharedCapacity, singleFrame } from '../src/comm/ethswitch';
import { sharedEfficiency } from '../src/widgets/ethswitchtools';

describe('chapter 49 typed numbers', () => {
  it('is chapter 49, eight steps, three recap checks', () => {
    expect(chSwitch.num).toBe(49);
    expect(chSwitch.steps.length).toBe(8);
    expect(chSwitch.recap!.check!.length).toBe(3);
  });
  it('step 1: 20 sources at 10 % need 10 units for overflow below 1e-6', () => {
    expect(sharedCapacity(20, 0.1, 1e-6)).toBe(10);
  });
  it('step 5: a 64-byte frame leaves at cycle 65 store-and-forward and 14 cut-through; 1526 bytes at 100 Mb/s is 122 us', () => {
    expect(singleFrame({ cellK: 7 }, 64).firstOut).toBe(65);
    expect(singleFrame({ cellK: 7, cut: true }, 64).firstOut).toBe(14);
    expect(((1518 + 8) * 8) / 100e6 * 1e6).toBeCloseTo(122.08, 2);
  });
  it('step 6: the saturation figures typed in the text', () => {
    const at = (voq: boolean, cells: number) => runTraffic({ pattern: 'uniform', load: 1, frameBytes: 64, cycles: 120000, seed: 11, opts: { cellK: 7, voq, cells } }).throughput;
    expect(at(false, 4)).toBeCloseTo(0.68, 2);
    expect(at(true, 4)).toBeCloseTo(0.8, 1);
    expect(at(true, 8)).toBeCloseTo(0.89, 1);
    expect(at(true, 16)).toBeCloseTo(0.93, 1);
    expect(holSaturation(4, false, 400000, 3)).toBeCloseTo(0.655, 2);
    expect(holSaturation(4, false, 400000, 3, false) * 64 / 65).toBeCloseTo(0.68, 2);
  }, 120000);
  it('step 8: shared-wire efficiency for four stations', () => {
    expect(sharedEfficiency(4, 84 * 8)).toBeCloseTo(0.49, 2);
  });
});
