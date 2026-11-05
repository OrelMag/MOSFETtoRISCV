// Capstone 2's verdicts: the carrier link against the chapters' own results, and the briefs' reference designs.

import { describe, expect, it } from 'vitest';
import { bestCarrier, bestSerial, CARRIER_BITS, CARRIER_BRIEF, CARRIER_REFERENCE_RATE, CODES, MODULATIONS, runCarrier, runSerial, SERIAL_BRIEF, SERIAL_REFERENCE_RATE } from '../src/comm/linkdesign';
import { dbToRatio } from '../src/comm/limits';
import { monteCarlo, constellation } from '../src/comm/modem';
import { berOf, eye, prbs } from '../src/phys/line';
import { tick } from './yieldtick';

const ch = (snrDb: number) => ({ name: 't', hz: 1e6, snrDb, target: 1e-3 });

describe('the carrier link', () => {
  it('with no code it counts what the modem chapter counts', () => {
    for (const [mod, snr] of [[0, 8], [1, 14], [2, 20]] as const) {
      const r = runCarrier(ch(snr), { mod, code: 0 }, 200000, 3), mc = monteCarlo(constellation('qam', MODULATIONS[mod].M), snr, 40000, 5);
      expect(r.ber / mc.ber).toBeGreaterThan(0.8);
      expect(r.ber / mc.ber).toBeLessThan(1.25);
    }
  });
  it('the rate is band × bits a symbol × code rate', () => {
    expect(runCarrier(ch(30), { mod: 1, code: 1 }, 2000).rate).toBe(1e6 * 4 * 0.5);
    expect(runCarrier(ch(30), { mod: 3, code: 0 }, 2000).rate).toBe(1e6 * 8);
  });
  it('with plenty of SNR every choice is clean, the decoder aligned', () => {
    for (let code = 0; code < CODES.length; code++) {
      const r = runCarrier(ch(40), { mod: 0, code }, 5000);
      expect(r.errors, CODES[code].name).toBe(0);
      expect(r.bits).toBeGreaterThan(4000);
    }
  });
  it('a code buys real gain at the same SNR, and the longer code buys more', () => {
    const none = runCarrier(ch(5), { mod: 0, code: 0 }, 100000, 7).ber;
    const k3 = runCarrier(ch(5), { mod: 0, code: 1 }, 100000, 7).ber;
    const k7 = runCarrier(ch(5), { mod: 0, code: 2 }, 100000, 7).ber;
    expect(k3).toBeLessThan(none);
    expect(k7).toBeLessThan(k3);
  });
  it('soft decisions buy real gain over hard ones on the same code', () => {
    expect(runCarrier(ch(15), { mod: 2, code: 3 }, 60000, 5).ber).toBeLessThan(runCarrier(ch(15), { mod: 2, code: 2 }, 60000, 5).ber / 5);
  });
});

describe('the serial link', () => {
  it('is the serial chapter\'s reading of the same eye', () => {
    const e = eye(prbs(9, 1022), { rate: 8, bandwidth: 4 });
    const r = runSerial(SERIAL_BRIEF, { line: 0, eq: 0, rate: 1 });
    expect(r.opening).toBeCloseTo(e.opening, 9);
    expect(r.ber).toBeCloseTo(berOf(e.opening / 2, 0.04), 12);
  });
  it('PAM4 costs noise margin and halves the symbol rate', () => {
    const fast = 5, nrz = runSerial(SERIAL_BRIEF, { line: 0, eq: 0, rate: fast }), pam = runSerial(SERIAL_BRIEF, { line: 1, eq: 0, rate: fast });
    expect(nrz.rate).toBe(pam.rate);
    expect(pam.opening).toBeLessThan(0.7);
  });
  it('decision feedback is not offered to PAM4', () => {
    const r = runSerial(SERIAL_BRIEF, { line: 1, eq: 3, rate: 0 });
    expect(r.closes).toBe(false);
    expect(r.unmodelled).toBe(true);
  });
});

describe('the briefs', () => {
  it('each has a design that closes, and not every choice does', async () => {
    const c = bestCarrier();
    expect(c.rate).toBe(CARRIER_REFERENCE_RATE);
    // the point of the brief: only soft decisions make the larger constellation close
    expect(CODES[c.choice.code].q).toBe(3);
    expect(MODULATIONS[c.choice.mod].M).toBe(64);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      expect(runCarrier(CARRIER_BRIEF, { mod: 2, code: 2 }, CARRIER_BITS, seed).closes).toBe(false);
      expect(runCarrier(CARRIER_BRIEF, { mod: 1, code: 0 }, CARRIER_BITS, seed).closes).toBe(false);
      expect(runCarrier(CARRIER_BRIEF, { mod: 2, code: 3 }, CARRIER_BITS, seed).closes).toBe(true);
      await tick();
    }
    expect(runCarrier(CARRIER_BRIEF, c.choice, CARRIER_BITS).closes).toBe(true);
    expect(runCarrier(CARRIER_BRIEF, { mod: 3, code: 0 }, CARRIER_BITS).closes).toBe(false);
    expect(runCarrier(CARRIER_BRIEF, { mod: 1, code: 0 }, CARRIER_BITS).closes).toBe(false);
    await tick();
    const s = bestSerial();
    expect(s.rate).toBe(SERIAL_REFERENCE_RATE);
    expect(runSerial(SERIAL_BRIEF, s.choice).closes).toBe(true);
    expect(runSerial(SERIAL_BRIEF, { line: 0, eq: 0, rate: 5 }).closes).toBe(false);
    expect(dbToRatio(CARRIER_BRIEF.snrDb)).toBeCloseTo(39.8, 1);
  }, 180_000);
});
