import { describe, expect, it } from 'vitest';
import { CODEX_F } from '../src/campaign/codexdspf';
import { MORE9F } from '../src/campaign/codexmore9f';
import { CHECK11F } from '../src/campaign/codexcheck11f';
import {
  absorptionDepth, alphaSi, C_FD_FF, CCD42_40, ccdReadTime, ccdRetained, CG_4T, dynamicRangeDb, IMX183, ktcNoise, rowTime, SI_CUTOFF_NM,
} from '../src/phys/imagesensor';

// The numbers the image-sensor codex entries print, held to phys/imagesensor.ts.
const text = (id: string) => [CODEX_F.find((e) => e.id === id)!.body, JSON.stringify(MORE9F[id]), JSON.stringify(CHECK11F[id])].join(' ').replace(/ /g, ' ');
const has = (id: string, s: string) => expect(text(id), `${id} should say ${s}`).toContain(s);

describe('image-sensor codex numbers', () => {
  it('qe: absorption depths, cut-off, the IMX183 point', () => {
    expect(SI_CUTOFF_NM).toBeCloseTo(1107, 0);
    has('qe', '1107 nm');
    for (const [nm, s] of [[450, '0.39 µm'], [650, '3.6 µm'], [900, '33 µm']] as const) { expect(absorptionDepth(nm).toFixed(s.startsWith('0') ? 2 : s.startsWith('3.') ? 1 : 0)).toBe(s.split(' ')[0]); has('qe', s); }
    expect(Math.round(alphaSi(900))).toBe(306);
    has('qe', `${Math.round(IMX183.peakQe * 100)} % at 525 nm`);
  });
  it('ccd: corner retention, read time, output swing', () => {
    expect((ccdRetained(2047, 2047) * 100).toFixed(1)).toBe('98.4');
    has('ccd', '98.4 %');
    expect(ccdReadTime(3e6).toFixed(1)).toBe('1.4');
    has('ccd', '1.4 s at 3 MHz');
    expect(Math.round(CCD42_40.fullWell * CCD42_40.cg / 1000)).toBe(675);
    has('ccd', '675 mV');
  });
  it('aps and cds: gain, capacitance, kTC', () => {
    expect(C_FD_FF.toFixed(2)).toBe('2.67');
    has('aps', `${CG_4T} µV per electron is 2.67 fF`);
    expect(ktcNoise(C_FD_FF).toFixed(1)).toBe('20.8');
    has('cds', '20.8 e⁻ rms');
  });
  it('rollingshutter and fullwell: row time, ranges', () => {
    expect((rowTime() * 1e6).toFixed(1)).toBe('12.3');
    has('rollingshutter', '12.3 µs a row');
    expect(dynamicRangeDb(IMX183).toFixed(1)).toBe('73.1');
    expect(dynamicRangeDb(CCD42_40).toFixed(1)).toBe('94.0');
    has('fullwell', '73.1 dB');
    has('fullwell', '94.0 dB');
  });
});
