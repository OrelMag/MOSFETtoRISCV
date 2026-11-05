// The on-ramp's arithmetic.

import { describe, expect, it } from 'vitest';
import { bytesWithLoss, cleanChance, delayOf, layerCost, onTheLine, packetCount, pushTime, storeAndForward, travelTime, WIRE_OVERHEAD } from '../src/comm/message';

describe('how long a message takes', () => {
  it('1 KB from New York to London: 28 ms of travel, whatever the rate', () => {
    expect(travelTime(5.6e6)).toBeCloseTo(0.028, 9);
    expect(pushTime(1000, 1e9)).toBeCloseTo(8e-6, 12);
    expect(delayOf(1000, 1e9, 5.6e6)).toBeCloseTo(0.028008, 9);
    expect(delayOf(1000, 1e12, 5.6e6) / delayOf(1000, 1e9, 5.6e6)).toBeGreaterThan(0.999);
  });
  it('a fast long line holds megabytes', () => {
    expect(onTheLine(10e9, 5.6e6)).toBe(35e6);
  });
});

describe('packets', () => {
  const plan = { bytes: 1e6, payload: 1000, header: 40, rate: 1e6, hops: 4 };
  it('equal packets match the closed form: all sent, then one packet time per further hop', () => {
    const t = (1040 * 8) / 1e6;
    expect(packetCount(plan)).toBe(1000);
    expect(storeAndForward(plan)).toBeCloseTo((1000 + 3) * t, 9);
  });
  it('one big message pays the whole size at every hop; packets almost none of that', () => {
    const whole = storeAndForward({ ...plan, payload: 1e6 });
    expect(whole).toBeCloseTo((4 * (1e6 + 40) * 8) / 1e6, 6);
    expect(storeAndForward(plan)).toBeLessThan(whole / 3);
  });
  it('very small packets lose to their headers', () => {
    expect(storeAndForward({ ...plan, payload: 20 })).toBeGreaterThan(storeAndForward(plan));
  });
  it('a last short packet does not overtake the one before it', () => {
    const p = { bytes: 1500, payload: 1000, header: 0, rate: 8000, hops: 3 };
    expect(storeAndForward(p)).toBeCloseTo(3 + 0.5, 9);
  });
  it('a wrong bit costs a block, so small blocks lose less', () => {
    expect(cleanChance(1000, 0)).toBe(1);
    const ber = 1e-6;
    const whole = bytesWithLoss({ bytes: 1e6, payload: 1e6, header: 40 }, ber), cut = bytesWithLoss({ bytes: 1e6, payload: 1000, header: 40 }, ber);
    expect(whole / 1e6).toBeGreaterThan(2000);
    expect(cut / 1e6).toBeLessThan(1.06);
  });
});

describe('layers', () => {
  it('a full Ethernet frame is about 95 % data', () => {
    expect(WIRE_OVERHEAD).toBe(38);
    const c = layerCost(1460);
    expect(c.total).toBe(1538);
    expect(c.share).toBeCloseTo(0.949, 3);
  });
  it('one byte costs 84 on the wire, padded to the 64-byte minimum frame', () => {
    expect(layerCost(1).pad).toBe(5);
    expect(layerCost(1).total).toBe(84);
    expect(layerCost(6).pad).toBe(0);
  });
});
