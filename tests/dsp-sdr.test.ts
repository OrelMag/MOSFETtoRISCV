// A software radio: the mixer and the CIC in gates equal the integer model every clock, the typed-array model equals the clock-by-clock one, and the whole chain is held to what it claims
// (the tuned station lands at zero, the test tone's SNR, Carson's rule). The clip rendered by the gates equals the model's, bit for bit.

import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import {
  ADC_SCALE, AUD, carson, carrierToNoise, CIC_N, CIC_R, cicBlock, demodulate, FrontModel, frontBlock, FS, MixModel, modIndex, NCO_BITS, NCO_K, occupied, receive, sample, SDR_COS, SDR_SIN, STATIONS, stationAt,
  synthBand, toneFm, toneSnr, tuningWord, W_CIC, W_IN, W_MIX, wordHz, bandSpectrum, DEV,
} from '../src/dsp/sdr';
import { CicModel } from '../src/dsp/multirate';
import { complexMixer, sdrFront } from '../src/lib/sdr';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { tick } from './yieldtick';

const lcg = (seed: number) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
const randWord = (r: () => number, w: number) => Math.floor(r() * 2 ** w) - 2 ** (w - 1);

describe('the oscillator tables', () => {
  it('hold ±127 and are a cosine and a sine a quarter turn apart', () => {
    expect(Math.max(...SDR_COS)).toBe(127);
    expect(Math.min(...SDR_COS)).toBe(-127);
    const N = SDR_COS.length;
    expect(N).toBe(2 ** NCO_K);
    for (let i = 0; i < N; i++) expect(SDR_COS[i]).toBe(SDR_SIN[(i + N / 4) % N]);
  });
  it('a tuning word gives the frequency asked for, to a step of the register', () => {
    for (const f of [-300_000, -60_000, 140_000, 340_000, 5_000]) expect(Math.abs(wordHz(tuningWord(f)) - f)).toBeLessThanOrEqual(FS / 2 ** NCO_BITS / 2);
  });
});

describe('the gates', () => {
  it('the mixer equals the model on every clock, any tuning', async () => {
    const r = lcg(5);
    for (const [f, k] of [[-300_000, 6], [140_000, 4], [-60_000, 8]]) {
      const ftw = tuningWord(f), m = new MixModel(ftw, k);
      const fresh = new BitSim(flatten(complexMixer(k)));
      for (let i = 0; i < 1500; i++) {
        const xr = randWord(r, W_IN), xi = randWord(r, W_IN);
        fresh.setInput('xr', [wordOf(xr, W_IN)]); fresh.setInput('xi', [wordOf(xi, W_IN)]); fresh.setInput('ftw', [ftw]);
        fresh.settle();
        const got = [signedOf(fresh.get('yr', 1)[0], W_MIX), signedOf(fresh.get('yi', 1)[0], W_MIX)], want = m.edge(xr, xi);
        if (got[0] !== want.yr || got[1] !== want.yi) expect([f, i, got]).toEqual([f, i, [want.yr, want.yi]]);
        fresh.cycle();
      }
      await tick();
    }
  }, 120_000);

  it('the front end equals the model on every output, every clock', async () => {
    const r = lcg(9), sim = new BitSim(flatten(sdrFront())), ftw = tuningWord(-60_000), m = new FrontModel(ftw);
    sim.setInput('ftw', [ftw]);
    for (let i = 0; i < 3000; i++) {
      const xr = randWord(r, W_IN), xi = randWord(r, W_IN);
      sim.setInput('xr', [wordOf(xr, W_IN)]); sim.setInput('xi', [wordOf(xi, W_IN)]);
      sim.cycle();
      m.edge(xr, xi);
      const got = [signedOf(sim.get('yr', 1)[0], W_CIC), signedOf(sim.get('yi', 1)[0], W_CIC), sim.get('valid', 1)[0]];
      if (got[0] !== m.yr || got[1] !== m.yi || got[2] !== (m.valid ? 1 : 0)) expect([i, got]).toEqual([i, [m.yr, m.yi, m.valid ? 1 : 0]]);
      if (i % 500 === 0) await tick();
    }
  }, 120_000);
});

describe('the model on typed arrays', () => {
  it('a CIC over a block equals CicModel word for word, wrapping and all', () => {
    const r = lcg(3), x = Array.from({ length: 4000 }, () => randWord(r, W_MIX)), m = new CicModel(CIC_N, CIC_R, W_CIC), out: number[] = [];
    for (const v of x) { m.edge(v); if (m.valid) out.push(m.y); }
    expect(Array.from(cicBlock(x))).toEqual(out);
  });
  it('mixer and CIC over a block equal FrontModel', () => {
    const r = lcg(4), n = 4000, xr = Array.from({ length: n }, () => randWord(r, W_IN)), xi = Array.from({ length: n }, () => randWord(r, W_IN)), ftw = tuningWord(140_000);
    const m = new FrontModel(ftw), a: number[] = [], b: number[] = [];
    for (let i = 0; i < n; i++) { m.edge(xr[i], xi[i]); if (m.valid) { a.push(m.yr); b.push(m.yi); } }
    const y = frontBlock(xr, xi, ftw);
    expect(Array.from(y.yr)).toEqual(a);
    expect(Array.from(y.yi)).toEqual(b);
  });
});

describe('the receiver', () => {
  const band = synthBand(FS / 4);
  it('the ADC does not clip the loudest case: four stations and noise at the default', () => {
    expect(sample(band, -40).clipped).toBe(0);
  });
  it('tuned to the test tone, it comes out as a clean 1 kHz tone', () => {
    const r = receive(band, STATIONS[0].f, -40), snr = toneSnr(r.chain.audio);
    expect(snr).toBeGreaterThan(30);
  });
  it('tuned between stations it gives noise, not the tone', () => {
    const r = receive(band, -180_000, -40);
    expect(stationAt(-180_000)).toBeUndefined();
    expect(toneSnr(r.chain.audio)).toBeLessThan(5);
  });
  it('more noise, a worse tone, and C/N moves one for one', () => {
    const a = toneSnr(receive(band, STATIONS[0].f, -40).chain.audio), b = toneSnr(receive(band, STATIONS[0].f, -25).chain.audio);
    expect(a).toBeGreaterThan(b);
    expect(carrierToNoise(1, -25, 102_000) - carrierToNoise(1, -40, 102_000)).toBeCloseTo(-15, 9);
  });
  it('the demodulator recovers an arpeggio and Morse from their stations, and the weak one is audible', () => {
    for (const k of [1, 2, 3]) {
      const r = receive(band, STATIONS[k].f, -40), a = r.chain.audio;
      let e = 0;
      for (let i = 2000; i < a.length; i++) e += a[i] * a[i];
      expect(e / (a.length - 2000)).toBeGreaterThan(0.005);
    }
  });
  it('de-emphasis undoes pre-emphasis', () => {
    const r = receive(band, STATIONS[0].f, -60), a = r.chain.audio;
    let peak = 0;
    for (let i = 4000; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(1.1);
  });
  it('the spectrum shows the four peaks', () => {
    const s = sample(band, -40), sp = bandSpectrum(s.xr, s.xi);
    for (const st of STATIONS) {
      const bin = Math.round((st.f / FS + 0.5) * 2048);
      expect(Math.max(...Array.from(sp.slice(bin - 3, bin + 4)))).toBeGreaterThan(-60);
    }
    expect(ADC_SCALE).toBeGreaterThan(0);
  });
});

describe('Carson\'s rule', () => {
  it('holds 98 % of the power, within a tenth, for modulation indices from 1 up', () => {
    for (const [dev, fm] of [[50_000, 1_000], [50_000, 5_000], [50_000, 15_000], [75_000, 15_000], [20_000, 10_000]]) {
      const got = occupied(toneFm(dev, fm), 0.98), want = carson(dev, fm);
      expect(modIndex(dev, fm)).toBeGreaterThan(1);
      expect(Math.abs(got - want) / want).toBeLessThan(0.1);
    }
  });
  it('the stations are spaced wider than the band they occupy', () => {
    const f = STATIONS.map((s) => s.f).sort((a, b) => a - b);
    for (let i = 1; i < f.length; i++) expect(f[i] - f[i - 1]).toBeGreaterThan(carson(DEV, 3000));
    expect(AUD).toBe(24_000);
  });
});

describe('a clip rendered by the gates', () => {
  it('equals the model bit for bit, and so does the sound that comes of it', async () => {
    const f = STATIONS[0].f, n = 2400, { xr, xi } = sample(band(), -40, 0, n), ftw = tuningWord(f);
    const sim = new BitSim(flatten(sdrFront())), gr: number[] = [], gi: number[] = [];
    sim.setInput('ftw', [ftw]);
    for (let i = 0; i < n; i++) {
      sim.setInput('xr', [wordOf(xr[i], W_IN)]); sim.setInput('xi', [wordOf(xi[i], W_IN)]);
      sim.cycle();
      if (sim.get('valid', 1)[0]) { gr.push(signedOf(sim.get('yr', 1)[0], W_CIC)); gi.push(signedOf(sim.get('yi', 1)[0], W_CIC)); }
      if (i % 600 === 0) await tick();
    }
    const m = frontBlock(xr, xi, ftw);
    expect(gr).toEqual(Array.from(m.yr));
    expect(gi).toEqual(Array.from(m.yi));
    expect(Array.from(demodulate(gr, gi).audio)).toEqual(Array.from(demodulate(m.yr, m.yi).audio));
  }, 120_000);
});

function band() { return synthBand(FS / 4); }

describe('what it costs', () => {
  it('the NANDs of the pieces are measured, and the CIC pair is the larger', () => {
    const mix = stats(complexMixer()).nands, front = stats(sdrFront()).nands;
    expect(mix).toBeGreaterThan(5000);
    expect(front).toBeGreaterThan(mix);
  });
});
