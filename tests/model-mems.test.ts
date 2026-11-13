import { describe, expect, it } from 'vitest';
import { SD_LIMIT } from '../src/dsp/converters';
import { boundsOf } from '../src/gl/kit/scene';
import {
  FIT_DBV, FS_PER_PA, IM69, MAX_SPL, MEMBRANE, MIC_CHAIN, PCM_RATE, TYPICAL, capacitances, deflection, meanDeflection, membraneVolts, micRun, resonanceHz, sensitivityDbv, splToPa,
} from '../src/phys/memsmic';
import { CHAIN } from '../src/widgets/dspconverters';
import { DIE, LAYERS, PADS, PKG, PORT, PORT_X, STACK, STACK_K, SWING_K, micModel, newBitsTex, worstSwing } from '../src/widgets/mems3dkit';

/** A tone's amplitude in the CIC's words (as a share of full scale), by correlation over whole periods after the warm-up. */
function wordAmp(words: readonly number[], hz: number, skip = 8): number {
  let s = 0, c = 0;
  const w = words.slice(skip);
  w.forEach((v, i) => { const ph = (2 * Math.PI * hz * (i + skip)) / PCM_RATE; s += v * Math.sin(ph); c += v * Math.cos(ph); });
  return (2 * Math.hypot(s, c)) / w.length;
}

describe('the MEMS microphone (phys/memsmic.ts): checks that test something', () => {
  it('positive pressure raises the density of 1s (the datasheet’s polarity)', () => {
    const r = micRun(120, 1000, 2 * 3072);
    let hi = 0, nHi = 0, lo = 0, nLo = 0;
    r.pressure.forEach((p, i) => { if (i < 3072) return; if (p > 0.5 * Math.max(...r.pressure)) { hi += r.bits[i]; nHi++; } else if (p < 0.5 * Math.min(...r.pressure)) { lo += r.bits[i]; nLo++; } });
    expect(hi / nHi).toBeGreaterThan(0.5);
    expect(lo / nLo).toBeLessThan(0.5);
    expect(membraneVolts(MEMBRANE, 1)).toBeGreaterThan(0);
    const [c1, c2] = capacitances(MEMBRANE, 1);
    expect(c1).toBeGreaterThan(c2); // pressure from the port closes the gap to backplate 1
  });
  it('at the overload point the membrane has used about 8 % of its gap (the onset of the distortion the datasheet shows rising there)', () => {
    const f = meanDeflection(MEMBRANE, splToPa(IM69.aop)) / MEMBRANE.gap;
    expect(f).toBeGreaterThan(0.05);
    expect(f).toBeLessThan(0.12);
    expect(deflection(MEMBRANE, splToPa(IM69.aop) * Math.SQRT2, 0)).toBeLessThan(MEMBRANE.gap / 2);
  });
  it('the membrane’s resonance is far above the audio band, so a quasi-static bow is the right picture', () => {
    expect(resonanceHz(MEMBRANE)).toBeGreaterThan(40e3);
  });
  it('the flat-plate capacitance at rest, and the mean deflection is the bow’s average', () => {
    const [c] = capacitances(MEMBRANE, 0);
    expect(c).toBeCloseTo((8.8541878128e-12 * Math.PI * MEMBRANE.a ** 2) / MEMBRANE.gap, 15);
    let s = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) { const r = ((i + 0.5) / n) * MEMBRANE.a; s += deflection(MEMBRANE, 3, r) * 2 * Math.PI * r * (MEMBRANE.a / n); }
    expect(s / (Math.PI * MEMBRANE.a ** 2) / meanDeflection(MEMBRANE, 3)).toBeCloseTo(1, 5);
  });
});

describe('the MEMS microphone: plumbing (these pin choices, they do not test the physics)', () => {
  it('σ is the fit that gives −38 dBV/Pa, and the typical sizes are the ones the brief states', () => {
    expect(sensitivityDbv(MEMBRANE)).toBeCloseTo(FIT_DBV, 3);
    expect(TYPICAL).toEqual({ a: 0.5e-3, h: 0.5e-6, rho: 2330, gap: 2e-6, vb: 10 });
    expect(MEMBRANE.sigma / 1e6).toBeGreaterThan(10);
    expect(MEMBRANE.sigma / 1e6).toBeLessThan(50);
  });
  it('the chain is the converters chapter’s, and the output rate is 48 kHz', () => {
    expect(MIC_CHAIN).toEqual(CHAIN);
    expect(PCM_RATE).toBe(48000);
  });
  it('a 1 kHz tone at 94 dB SPL comes back from the loop and the CIC at the datasheet’s −36 dBFS', () => {
    const hz = (PCM_RATE * 43) / 2048, r = micRun(94, hz, 64 * 2048);
    expect(20 * Math.log10(wordAmp(r.words, hz))).toBeCloseTo(IM69.sensDbfs, 0);
    expect(FS_PER_PA * Math.SQRT2).toBeCloseTo(10 ** (-36 / 20), 12);
  });
  it('the slider’s top is where the loop’s limit is: the datasheet’s overload point would be full scale, past it', () => {
    expect(splToPa(MAX_SPL) * Math.SQRT2 * FS_PER_PA).toBeCloseTo(SD_LIMIT, 9);
    expect(MAX_SPL).toBeLessThan(IM69.aop);
    expect(splToPa(IM69.aop) * Math.SQRT2 * FS_PER_PA).toBeCloseTo(1, 1);
  });
});

describe('the MEMS microphone model (widgets/mems3dkit.ts)', () => {
  const m = micModel({ p: 0, bits: newBitsTex(), spl: 94 });
  it('the package is the datasheet’s drawing: 4 × 3 × 1.2 mm, a 0.25 mm substrate, a Ø 0.6 mm port 1.32 mm from the end', () => {
    expect(PKG).toEqual({ l: 4, w: 3, h: 1.2, sub: 0.25 });
    expect(PORT.d).toBe(0.6);
    expect(PORT_X + PKG.l / 2).toBeCloseTo(1.32, 12);
    const { min, max } = boundsOf(m);
    expect(max[0] - min[0]).toBeCloseTo(4, 2);
    expect(max[2] - min[2]).toBeCloseTo(3, 2);
    expect(max[1]).toBeCloseTo(1.2, 3);
    expect(PADS.map((p) => p.name)).toEqual(['1 DATA', '2 VDD', '3 CLOCK', '4 SELECT']);
    for (const p of PADS) { expect(Math.abs(p.x) + 0.2).toBeLessThanOrEqual(PKG.l / 2 - 0.3 + 1e-9); expect(Math.abs(p.z) + 0.35).toBeLessThanOrEqual(PKG.w / 2 - 0.3 + 1e-9); }
  });
  it('the die sits over the port, inside the lid, and its cavity is wider than the port and the membrane', () => {
    expect(PORT_X - DIE.side / 2).toBeGreaterThan(-PKG.l / 2 + 0.08);
    expect(DIE.cavity).toBeGreaterThan(PORT.d);
    expect(DIE.cavity).toBeGreaterThan(2 * MEMBRANE.a * 1e3);
    expect(LAYERS.top).toBeLessThan(PKG.h - 0.08);
  });
  it('one vertical exaggeration for the whole stack, and the drawn swing stays inside the drawn gap at the loudest the page allows', () => {
    expect(STACK_K).toBe(20);
    expect(SWING_K).toBe(4);
    expect(LAYERS.mem[0] - LAYERS.bp2[1]).toBeCloseTo(STACK.gap * 1e3 * STACK_K, 12);
    expect(LAYERS.bp1[0] - LAYERS.mem[1]).toBeCloseTo(STACK.gap * 1e3 * STACK_K, 12);
    expect(LAYERS.mem[1] - LAYERS.mem[0]).toBeCloseTo(STACK.membrane * 1e3 * STACK_K, 12);
    expect(worstSwing()).toBeLessThan(0.95);
    expect(worstSwing()).toBeGreaterThan(0.5); // and is seen
  });
  it('every named part is labelled, typical sizes say so, σ is called a fit, and the finite labels are unique', () => {
    for (const it of m.items) {
      for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
      if (it.name) expect(it.mat.label, it.name).toBeTruthy();
    }
    const card = (n: string) => m.items.find((i) => i.name === n)!.info!;
    expect(card('membrane').dim).toMatch(/typical/);
    expect(card('membrane').source).toMatch(/fit/);
    expect(card('membrane').dim).toMatch(new RegExp(`${STACK_K}× taller`));
    expect(card('MEMS die').dim).toMatch(/typical/);
    expect(card('backplate').dim).toMatch(/typical/);
    expect(card('lid').source).toMatch(/IM69D130 datasheet/);
    expect(new Set(m.anchors!.map((a) => a.text)).size).toBe(m.anchors!.length);
    expect(m.beats!.length).toBe(7);
  });
});
