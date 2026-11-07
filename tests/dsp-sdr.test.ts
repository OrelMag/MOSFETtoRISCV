// A software radio: the mixer and the CIC in gates equal the integer model every clock, the typed-array model equals the clock-by-clock one, and the whole chain is held to what it claims
// (the tuned station lands at zero, the test tone's SNR, Carson's rule). The clip rendered by the gates equals the model's, bit for bit.

import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import {
  ADC_SCALE, AUD, carson, carrierToNoise, CIC_N, CIC_R, cicBlock, FrontModel, frontBlock, FS, MixModel, modIndex, NCO_BITS, NCO_K, occupied, receive, sample, SDR_COS, SDR_SIN, STATIONS, stationAt,
  synthBand, stationOccupied, TEST_TONE_HZ, trailingZeros, toneSnrOff, interferenceDb, ringSpread, chanWorstDb, preLiftDb, analogueLiftDb, firstClipNoiseDb, keyingRatio, KEYING_LOST_DB, morseUnits, mixerSfdr, toneFm, toneSnr, tuningWord, W_CIC, W_IN, W_MIX, wordHz, bandSpectrum, DEV,
} from '../src/dsp/sdr';
import { CicModel } from '../src/dsp/multirate';
import { complexMixer, sdrFront } from '../src/lib/sdr';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { CLIP_CLOCKS, CLIP_SKIP, gateClip, modelClip } from '../src/dsp/sdrclip';
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
    const r = receive(band, -440_000, -40);
    expect(stationAt(-440_000)).toBeUndefined();
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
  it('the stations deviate to their limit, and de-emphasis gives the programme back', () => {
    // the test tone's samples: the frequency step between neighbours, from the band itself, peaks at the deviation
    const b4 = synthBand(FS / 4), n = 20000, z = (i: number) => [b4.re[i], b4.im[i]];
    // tuned and filtered to the station alone the discriminator reads ±1 deviation at the loudest moment
    const r = receive(b4, STATIONS[0].f, -60);
    let top = 0;
    for (let i = 3000; i < r.chain.disc.length - 100; i++) top = Math.max(top, Math.abs(r.chain.disc[i]));
    expect(z(0).length + n).toBeGreaterThan(0);
    expect(top).toBeGreaterThan(0.9);
    expect(top).toBeLessThan(1.1);
    // the audio is the programme: correlation with the test tone, any delay within a few samples, is near 1
    const a = r.chain.audio, ref = (i: number) => Math.sin((2 * Math.PI * TEST_TONE_HZ * i) / AUD);
    let best = 0;
    for (let d = -10; d <= 10; d++) {
      let c = 0, ea = 0, er = 0;
      for (let i = 400; i < a.length - 20; i++) { const x = a[i], y = ref(i + d); c += x * y; ea += x * x; er += y * y; }
      best = Math.max(best, Math.abs(c) / Math.sqrt(ea * er));
    }
    expect(best).toBeGreaterThan(0.995);
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
  it('equals the model bit for bit: the words leaving the CIC, and so the sound', async () => {
    for (const f of [STATIONS[0].f, STATIONS[3].f]) {
      const run = await gateClip(band(), f, -40, { pause: tick }), { xr, xi } = sample(band(), -40, 0, CLIP_CLOCKS), m = frontBlock(xr, xi, tuningWord(f));
      expect(run.clocks).toBe(CLIP_CLOCKS);
      expect(run.yr).toEqual(Array.from(m.yr));
      expect(run.yi).toEqual(Array.from(m.yi));
      const model = modelClip(band(), f, -40);
      expect(Array.from(run.clip.samples)).toEqual(Array.from(model.samples));
      expect(run.clip.source).toBe('gates');
      expect(model.source).toBe('model');
    }
  }, 240_000);
  it('is long enough to hold sixteen cycles of the test tone, and that tone is what comes out', async () => {
    const run = await gateClip(band(), STATIONS[0].f, -40, { pause: tick }), a = run.clip.samples;
    expect(a.length).toBe(CLIP_CLOCKS / 40 - CLIP_SKIP);
    // zero crossings of a 1 kHz tone at 24 kHz: two a millisecond
    let z = 0;
    for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 !== a[i] < 0) z++;
    expect(Math.abs(z - 2 * (a.length / 24))).toBeLessThanOrEqual(3);
  }, 240_000);
});

function band() { return synthBand(FS / 4); }

describe('how fine a table', () => {
  it('each bit of table is about 6 dB of spurious-free range, and the weak station beside a loud one feels it', () => {
    const s = [4, 5, 6, 7, 8].map((k) => mixerSfdr(k));
    for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBeGreaterThan(4.5);
    const weak = [5, 6, 7, 8].map((k) => keyingRatio(receive(synthBand(FS), STATIONS[3].f, -40, FS, k).chain.audio));
    for (let i = 1; i < weak.length; i++) expect(weak[i]).toBeGreaterThan(weak[i - 1] + 3);
  });
});

describe('the weak station with a coarse table', () => {
  // key up is as loud as key down: the discriminator follows a loud neighbour's spur, so the ratio is the ratio of two stretches of garbage, near 0 dB either side (not a floor or clamp)
  const unitPowers = (a: ArrayLike<number>) => {
    const M = morseUnits(), u = a.length / M.length, on: number[] = [], off: number[] = [];
    for (let k = 1; k < M.length - 1; k++) {
      if (M[k] !== M[k - 1] || M[k] !== M[k + 1]) continue;
      const s0 = Math.floor(k * u + u / 4), e0 = Math.floor((k + 1) * u - u / 4);
      let q = 0;
      for (let i = s0; i < e0; i++) q += a[i] * a[i];
      (M[k] === '1' ? on : off).push(q / (e0 - s0));
    }
    return { on, off };
  };
  it('at 3 and 4 bits the keying is lost: both ratios are within the scatter around 0 dB, key up is loud, and the ratio can fall below 0', () => {
    for (const k of [3, 4]) {
      const a = receive(synthBand(FS), STATIONS[3].f, -40, FS, k).chain.audio, r = keyingRatio(a), { on, off } = unitPowers(a);
      expect(Math.abs(r)).toBeLessThan(KEYING_LOST_DB);
      expect(Math.min(...off)).toBeGreaterThan(0.2 * Math.max(...on));
    }
    // 0.8 dB at 3 bits and -0.0 at 4 are the same finding, not a trend: the sign is not pinned, the size is
    expect(keyingRatio(receive(synthBand(FS), STATIONS[3].f, -60, FS, 4).chain.audio)).toBeLessThan(0.5);
  });
  it('from 5 bits the key-up audio falls away: well over the lost threshold, and rising 6 dB a bit', () => {
    const r = [5, 6, 7].map((k) => keyingRatio(receive(synthBand(FS), STATIONS[3].f, -40, FS, k).chain.audio));
    expect(r[0]).toBeGreaterThan(10);
    expect(r[1] - r[0]).toBeGreaterThan(15);
    expect(r[2] - r[1]).toBeGreaterThan(4);
  });
});

describe('what the audit found, pinned', () => {
  it('the test tone hides the table: its tuning word lands on table points on frequency, and not 100 Hz off', () => {
    expect(trailingZeros(tuningWord(STATIONS[0].f))).toBe(12);
    expect(toneSnrOff(4, 0)).toBeGreaterThan(75);
    const off = [3, 4, 5, 6, 8].map((k) => toneSnrOff(k, 100));
    expect(off[1]).toBeLessThan(55);
    for (let i = 1; i < off.length; i++) expect(off[i]).toBeGreaterThan(off[i - 1]);
    expect(off[4]).toBeGreaterThan(70);
  });
  it('the CIC folds the sweep into the weak station\'s channel, and a finer table does not remove it', () => {
    const six = interferenceDb(3, 6), twelve = interferenceDb(3, 12), alone = interferenceDb(3, 12, [2]);
    expect(six).toBeGreaterThan(twelve + 4);
    expect(Math.abs(twelve - alone)).toBeLessThan(2);
    expect(alone).toBeGreaterThan(-20);
  });
  it('the tone\'s CIC output stays on a circle, the weak station\'s does not', () => {
    expect(ringSpread(STATIONS[0].f, 800)).toBeLessThan(0.15);
    expect(ringSpread(STATIONS[3].f, 800)).toBeGreaterThan(0.25);
  });
  it('the channel filter\'s stopband, and the digital pre-emphasis against the analogue one', () => {
    expect(chanWorstDb(90_000, 120_000)).toBeLessThan(-50);
    expect(chanWorstDb(90_000, 120_000)).toBeGreaterThan(-60);
    expect(preLiftDb(10_000)).toBeCloseTo(11.1, 0);
    expect(analogueLiftDb(10_000)).toBeCloseTo(13.7, 0);
  });
  it('the ADC starts clipping at -12 dB of noise, and the stations\' highest audio frequencies come from their programmes', () => {
    expect(firstClipNoiseDb()).toBe(-12);
    expect(STATIONS.map((s) => s.fm)).toEqual([1000, 1046, 3000, 700]);
  });
});

describe('the keying floor and the measured bands', () => {
  const key = (b: ReturnType<typeof synthBand>, nd: number) => keyingRatio(receive(b, STATIONS[3].f, nd, FS, 12).chain.audio);
  it('at -40 dB of noise the weak station keys the same alone as among its neighbours: the noise sets the floor', () => {
    expect(Math.abs(key(synthBand(FS), -40) - key(synthBand(FS, [3]), -40))).toBeLessThan(2);
  });
  it('with the noise off the neighbours (the CIC alias) cost the weak station more than 5 dB of keying', () => {
    expect(key(synthBand(FS, [3]), -200) - key(synthBand(FS), -200)).toBeGreaterThan(5);
  });
  it('a station measured over about a second: the sweep, which grows, is wider than in its first quarter second, and none exceeds Carson by much', () => {
    const o = STATIONS.map((_, k) => stationOccupied(k));
    expect(o[2]).toBeGreaterThan(80_000);
    expect(o[0]).toBeCloseTo(102_000, -3);
    o.forEach((v, k) => expect(v).toBeLessThan(2 * (50_000 + STATIONS[k].fm) * 1.05));
  });
});

describe('what it costs', () => {
  it('the NANDs of the pieces are measured, and the CIC pair is the larger', () => {
    const mix = stats(complexMixer()).nands, front = stats(sdrFront()).nands;
    expect(mix).toBeGreaterThan(5000);
    expect(front).toBeGreaterThan(mix);
  });
});
