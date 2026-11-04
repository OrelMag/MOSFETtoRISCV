// Chapter 45's models: the NCO and the FSK pair (the integer cycle models the gates are compared with), constellations and
// symbol error rates against a seeded Monte Carlo, the voice-band modems' numbers, ADSL's bit loading.

import { describe, expect, it } from 'vitest';
import {
  ACC_BITS, ADSL, BELL103, bitLoad, bitsForTone, bitsPerSymbol, constellation, decide, DOWN_TONES, DS0, energies, fskDemodulate, fskModulate,
  FS, FTW_MARK, FTW_SPACE, gapDb, gapToShannonDb, MODEMS, monteCarlo, ncoHz, noisy, PCM_RATE, qInv, RX_LONG, SAMPLES_PER_BIT,
  serClosed, SINE_TABLE, sliceBits, snrForSer, toneSnrDb, tuningWord, worstNeighbourBits,
} from '../src/comm/modem';
import { MARKED, ratioToDb, shannon, snrNeeded } from '../src/comm/limits';
import { dbToRatio } from '../src/comm/limits';
import { qFunc, rng } from '../src/phys/line';
import { tick } from './yieldtick';

describe('NCO and FSK in integers', () => {
  it('the table is one sine period in six-bit offset binary, positive exactly in the first half', () => {
    expect(SINE_TABLE).toHaveLength(64);
    expect(Math.min(...SINE_TABLE)).toBe(0);
    expect(Math.max(...SINE_TABLE)).toBe(63);
    SINE_TABLE.forEach((v, i) => expect(v >= 32).toBe(i < 32));
    SINE_TABLE.forEach((v, i) => expect(v + SINE_TABLE[(i + 32) % 64]).toBe(63));
  });
  it('the Bell 103 tones land within half a frequency step of the published ones', () => {
    const step = FS / 2 ** ACC_BITS;
    expect(step).toBeCloseTo(2.34375, 5);
    for (const f of [BELL103.originate.space, BELL103.originate.mark, BELL103.answer.space, BELL103.answer.mark]) {
      expect(Math.abs(ncoHz(tuningWord(f)) - f)).toBeLessThanOrEqual(step / 2);
    }
    expect([FTW_SPACE, FTW_MARK]).toEqual([457, 542]);
    expect(ncoHz(FTW_SPACE)).toBeCloseTo(1071.1, 1);
    expect(ncoHz(FTW_MARK)).toBeCloseTo(1270.3, 1);
  });
  it('Bell 103 is 300 baud: 64 samples a bit at 19 200 Hz', () => {
    expect(BELL103.baud).toBe(300);
    expect(SAMPLES_PER_BIT).toBe(64);
  });
  it('the period counter threshold sits between the two periods', () => {
    const pSpace = FS / ncoHz(FTW_SPACE), pMark = FS / ncoHz(FTW_MARK);
    expect(Math.floor(pSpace)).toBeGreaterThanOrEqual(RX_LONG);
    expect(Math.ceil(pMark)).toBeLessThan(RX_LONG);
  });
  it('a modulated stream is a sine of the right frequency (rising crossings over the bits)', () => {
    for (const [bit, hz] of [[0, ncoHz(FTW_SPACE)], [1, ncoHz(FTW_MARK)]] as const) {
      const s = fskModulate(Array(30).fill(bit));
      let rises = 0;
      for (let i = 1; i < s.length; i++) if (s[i] >= 32 && s[i - 1] < 32) rises++;
      expect(Math.abs(rises - (hz * 30) / 300)).toBeLessThanOrEqual(2);
    }
  });
  it('a noiseless line gives every bit back, over seeded random messages', () => {
    const u = rng(7);
    for (let t = 0; t < 20; t++) {
      const bits = Array.from({ length: 40 }, () => (u() < 0.5 ? 0 : 1));
      const got = sliceBits(fskDemodulate(fskModulate(bits)), 40);
      expect(got.slice(2)).toEqual(bits.slice(2));
    }
  });
  it('noise breaks a period counter: clean at 0, ruined at 12 steps rms', async () => {
    const u = rng(11), bits = Array.from({ length: 200 }, () => (u() < 0.5 ? 0 : 1)), tx = fskModulate(bits);
    const errs = (sigma: number) => { const g = sliceBits(fskDemodulate(noisy(tx, sigma, 3)), 200); return g.slice(2).filter((b, i) => b !== bits[i + 2]).length; };
    expect(errs(0)).toBe(0);
    await tick();
    expect(errs(12)).toBeGreaterThan(20);
  });
});

describe('constellations', () => {
  const sets: ['psk' | 'qam', number][] = [['psk', 2], ['psk', 4], ['psk', 8], ['qam', 4], ['qam', 16], ['qam', 64], ['qam', 256]];
  for (const [k, M] of sets) {
    it(`${M}-${k}: unit energy, Gray neighbours differ in one bit, noiseless decisions are exact`, () => {
      const c = constellation(k, M);
      expect(energies(c).mean).toBeCloseTo(1, 9);
      expect(worstNeighbourBits(c)).toBe(1);
      c.pts.forEach(([x, y], i) => expect(decide(c, x, y)).toBe(i));
    });
  }
  it('peak-to-average power ratio: 0 dB for PSK, 2.55 dB for 16-QAM, 3.68 dB for 64-QAM', () => {
    expect(energies(constellation('psk', 8)).papr).toBeCloseTo(0, 9);
    expect(energies(constellation('qam', 16)).papr).toBeCloseTo(2.55, 2);
    expect(energies(constellation('qam', 64)).papr).toBeCloseTo(3.68, 1);
  });
  it('QPSK is 4-QAM', () => {
    for (const s of [1, 3, 10]) expect(serClosed('psk', 4, s)).toBe(serClosed('qam', 4, s));
  });
  it('qInv inverts Q', () => {
    for (const p of [0.3, 1e-3, 1e-7]) expect(qFunc(qInv(p)) / p).toBeCloseTo(1, 5);
  });
});

describe('symbol error rate: closed form against seeded Monte Carlo', () => {
  const cases: ['psk' | 'qam', number, number][] = [['psk', 2, 6], ['qam', 4, 8], ['qam', 16, 14], ['qam', 64, 20], ['qam', 256, 26]];
  for (const [k, M, db] of cases) {
    it(`${M}-${k} at ${db} dB`, async () => {
      const c = constellation(k, M), n = 200_000, mc = monteCarlo(c, db, n, 5), cf = serClosed(k, M, dbToRatio(db));
      await tick();
      const sd = Math.sqrt((cf * (1 - cf)) / n);
      expect(Math.abs(mc.ser - cf)).toBeLessThan(5 * sd + 1e-4);
    });
  }
  it('8-PSK: the two-neighbour approximation is within 10 % where the error rate is below 5 %', async () => {
    const c = constellation('psk', 8), n = 300_000;
    for (const db of [12, 13, 14]) {
      const mc = monteCarlo(c, db, n, 9), cf = serClosed('psk', 8, dbToRatio(db));
      expect(Math.abs(mc.ser / cf - 1)).toBeLessThan(0.1);
      await tick();
    }
  });
  it('Gray labels: bit errors are about one per symbol error at high SNR', () => {
    const mc = monteCarlo(constellation('qam', 16), 14, 200_000, 21);
    expect(mc.bitErrors / mc.symErrors).toBeLessThan(1.15);
    expect(mc.bitErrors / mc.symErrors).toBeGreaterThanOrEqual(1);
  });
  it('two more bits a symbol cost about 6 dB (the factor four in M − 1)', () => {
    const at = (M: number) => snrForSer('qam', M, 1e-6);
    expect(at(16) - at(4)).toBeGreaterThan(5.5);
    expect(at(16) - at(4)).toBeLessThan(7.5);
    expect(at(256) - at(64)).toBeGreaterThan(5.8);
    expect(at(256) - at(64)).toBeLessThan(6.6);
  });
  it('uncoded QAM sits about 9 dB above Shannon at 1e-6, and the gap formula agrees', () => {
    expect(gapToShannonDb(256, 1e-6)).toBeGreaterThan(8);
    expect(gapToShannonDb(256, 1e-6)).toBeLessThan(10);
    expect(gapDb(1e-7)).toBeGreaterThan(9.5);
    expect(gapDb(1e-7)).toBeLessThan(10.2);
  });
});

describe('the modems', () => {
  const m = (id: string) => MODEMS.find((x) => x.id === id)!;
  it('rate / baud', () => {
    expect([m('bell103'), m('v22'), m('v22bis')].map(bitsPerSymbol)).toEqual([1, 2, 4]);
    expect(bitsPerSymbol(m('v32'))).toBe(4);
    expect(bitsPerSymbol(m('v32bis'))).toBe(6);
    expect(bitsPerSymbol(m('v34'))).toBeCloseTo(9.8, 1);
    expect(bitsPerSymbol(m('v90'))).toBe(7);
  });
  it('V.34 is the row the limits chapter marks', () => {
    expect(m('v34').rate).toBe(MARKED.find((x) => x.short === 'V.34')!.rate);
  });
  it('V.90: 7 of the 8 bits of a DS0 sample, 8000 times a second, against a 64 kb/s channel', () => {
    expect(PCM_RATE).toBe(8000);
    expect(DS0).toBe(64000);
    expect(m('v90').rate).toBe(PCM_RATE * 7);
  });
  it('56 kb/s through 3.1 kHz would need 54 dB, which no loop has; 33.6 kb/s needs 33 dB', () => {
    expect(ratioToDb(snrNeeded(56000 / 3100))).toBeCloseTo(54.4, 0);
    expect(ratioToDb(snrNeeded(33600 / 3100))).toBeCloseTo(32.6, 0);
    expect(shannon(3100, snrNeeded(33600 / 3100))).toBeCloseTo(33600, 3);
  });
});

describe('ADSL bit loading', () => {
  it('the numbers: 256 tones at 4.3125 kHz make 1.104 MHz; 4000 symbols a second', () => {
    expect(ADSL.tones * ADSL.spacingHz).toBe(1_104_000);
    expect(ADSL.symbolRate).toBe(4000);
  });
  it('a tone carries floor(log2(1 + SNR / gap)) bits, 0 below the gap, capped at 15', () => {
    expect(bitsForTone(0, 9.8)).toBe(0);
    expect(bitsForTone(9.8 + 4.8, 9.8)).toBe(2);
    expect(bitsForTone(100, 9.8)).toBe(15);
  });
  it('a longer loop or a higher noise floor carries less, and never more than the cap on every tone', () => {
    const a = bitLoad(1, -120, 9.8), b = bitLoad(3, -120, 9.8), c = bitLoad(3, -110, 9.8);
    expect(a.rate).toBeGreaterThan(b.rate);
    expect(b.rate).toBeGreaterThan(c.rate);
    expect(a.total).toBeLessThanOrEqual(DOWN_TONES.length * 15);
    expect(b.bits[0]).toBeGreaterThan(b.bits[b.bits.length - 1]);
    expect(toneSnrDb(40, 3, -120)).toBeGreaterThan(toneSnrDb(200, 3, -120));
  });
});

// ---- the gates against the models -------------------------------------------------------------------------------------------

import { FSK_RX, FSK_TX, fskLink, modemLine, NCO, SINE_ROM } from '../src/lib';
import { FskRxModel, FskTxModel, NcoModel } from '../src/comm/modem';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { lcg, out, set, tick as clock, checkSpec } from './util';

describe('gates against the models', () => {
  it('the sine ROM matches its table (exhaustive)', () => { checkSpec(SINE_ROM); });
  it('the NCO equals the accumulator every cycle, for random and fixed tuning words', async () => {
    const sim = simulate(NCO), m = new NcoModel(), r = lcg(3);
    set(sim, { clk: 0, ftw: 0 });
    sim.reset('zero');
    for (let i = 0; i < 600; i++) {
      const w = i < 300 ? FTW_MARK : r(2 ** ACC_BITS);
      set(sim, { ftw: w });
      expect(out(sim, 's'), `cycle ${i}`).toBe(m.sample);
      clock(sim); m.clock(w);
      if (i % 100 === 99) await tick();
    }
  });
  it('FSK_TX equals the model every output every cycle on a random bit stream', async () => {
    const sim = simulate(FSK_TX), m = new FskTxModel(), r = lcg(5);
    set(sim, { clk: 0, bit: 0 });
    sim.reset('zero');
    let b = 0;
    for (let i = 0; i < 1000; i++) {
      if (i % 40 === 0) b = r(2);
      set(sim, { bit: b });
      expect(out(sim, 's'), `cycle ${i}`).toBe(m.sample);
      clock(sim); m.clock(b);
      if (i % 100 === 99) await tick();
    }
  });
  it('FSK_RX equals the model on random samples and on a modulated message, d and the period every cycle', async () => {
    const sim = simulate(FSK_RX), m = new FskRxModel(), r = lcg(9);
    set(sim, { clk: 0, s: 0 });
    sim.reset('zero');
    const stream = [...Array.from({ length: 400 }, () => r(64)), ...fskModulate([1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1])];
    for (let i = 0; i < stream.length; i++) {
      set(sim, { s: stream[i] });
      clock(sim); m.clock(stream[i]);
      expect(out(sim, 'd'), `d, cycle ${i}`).toBe(m.d);
      expect(out(sim, 'period'), `period, cycle ${i}`).toBe(m.cnt);
      if (i % 100 === 99) await tick();
    }
  });
  it('the line delays by its stages and a hit flips the sign bit', () => {
    const sim = simulate(modemLine(2));
    set(sim, { clk: 0, s: 0, hit: 0 });
    sim.reset('zero');
    const seq = [5, 40, 17, 63, 32, 0], hits = [0, 0, 1, 0, 0, 0], got: number[] = [];
    for (let i = 0; i < seq.length + 2; i++) {
      set(sim, { s: seq[i] ?? 0, hit: hits[i] ?? 0 });
      clock(sim);
      got.push(out(sim, 'y'));
    }
    expect(got.slice(1, 7)).toEqual([5, 40, 17 ^ 32, 63, 32, 0]);
  });
  it('the whole link, end to end: bits sent come out of the receiver', async () => {
    const sim = simulate(fskLink(2)), bits = [1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1], got: number[] = [];
    set(sim, { clk: 0, bit: 0, hit: 0 });
    sim.reset('zero');
    let c = 0;
    for (const b of bits) {
      for (let i = 0; i < 64; i++, c++) {
        set(sim, { bit: b });
        clock(sim);
        if (i === 48) got.push(out(sim, 'd'));
      }
      await tick();
    }
    expect(got.slice(2)).toEqual(bits.slice(2));
  });
  it('costs, from the gates', () => {
    const c = { rom: stats(SINE_ROM).nands, nco: stats(NCO).nands, tx: stats(FSK_TX).nands, rx: stats(FSK_RX).nands, line: stats(modemLine(2)).nands, link: stats(fskLink(2)).nands };
    console.log('modem costs', JSON.stringify(c));
    expect(c.tx).toBeGreaterThan(c.nco);
    expect(c.link).toBe(c.tx + c.line + c.rx);
  });
});
