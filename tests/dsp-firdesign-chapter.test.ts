// What "FIR design" claims: each number in the text and each Try box. The slider ranges are the widgets' own (RANGES), so a Try box is checked against what its slider can reach.
import { describe, expect, it } from 'vitest';
import { chFirDesign, figures } from '../src/chapters/ch-dsp-firdesign';
import { numOf } from '../src/chapters/order';
import { bitsToHold } from '../src/dsp/fixed';
import { csdAdders, csdOf, foldedMults, linearDelay, MacModel, maskReport, MASK, sceneMac, binaryDigits, deltaPass, type MacConfig } from '../src/dsp/firdesign';
import { chapterDesign, csdTap, csdTotals, designRows, macOf, macTone, MAC_TONES, RANGES, windowDesign } from '../src/widgets/dspfir';
import { guardFor, tapWords } from '../src/dsp/firdesign';
import { flatten } from '../src/sim/flatten';
import { analyzeTiming } from '../src/sim/timing';
import { firCosts, firMac } from '../src/lib/firmac';
import { stats } from '../src/sim/stats';

describe('the book', () => {
  it('follows the z-plane', () => expect(numOf('firdesign')).toBe(numOf('zplane') + 1));
  it('has its steps, each with words and something to do', () => {
    expect(chFirDesign.steps.length).toBe(8);
    for (const s of chFirDesign.steps) { expect(s.body.length, s.title).toBeGreaterThan(600); expect(!!s.widget || !!s.scene, s.title).toBe(true); expect(s.challenge, s.title).toBeTruthy(); }
  });
});

describe('the numbers in the text', () => {
  const F = figures();
  it('the mask: 0.10 and 0.125 cycles a sample, δp 0.00576, δs 0.001', () => {
    expect(F.dp).toBeCloseTo(0.005756, 6); expect(F.ds).toBeCloseTo(0.001, 12); expect(F.width).toBeCloseTo(0.025, 12);
  });
  it('114 taps are the fewest; 113 misses both bands; 115 is the fewest odd; Kaiser needs 147; the estimate is under', () => {
    expect(F.ch.n).toBe(114); expect(F.ch.fewestOddPm).toBe(115); expect(F.kaiser.numtaps).toBe(147);
    expect(F.pm113.passOk).toBe(false); expect(F.pm113.stopOk).toBe(false); expect(F.pm114.ok).toBe(true);
    expect(F.est).toBeLessThan(114);
    expect(F.iters).toBe(8);
    expect(linearDelay(114)).toBe(56.5);
  });
  it('the Try box on the Parks–McClellan step: 113 is inside the slider (60 … 130) and a weight cannot repair it', () => {
    expect(RANGES.remezTaps[0]).toBeLessThanOrEqual(113); expect(RANGES.remezTaps[1]).toBeGreaterThanOrEqual(114);
    expect(RANGES.weight[0]).toBeLessThan(0); expect(RANGES.weight[1]).toBeGreaterThan(0);
    for (const k of [-1, -0.5, 0.5, 1]) {
      const r = maskReport(pmTapsWeighted(113, k));
      expect(r.ok, `weight ${k}`).toBe(false);
    }
  });
  it('windows: Hann 269, Blackman 201, Kaiser 147, Hamming 489, the rectangle none; the slider reaches them (11 … 501)', () => {
    expect(F.hann).toBe(269); expect(F.blackman).toBe(201); expect(F.kaiserOdd).toBe(147); expect(F.hamming).toBe(489);
    expect(F.win.find((r) => r.kind === 'rectangular')!.n).toBeNull();
    for (const n of [F.hann, F.blackman, F.hamming, 61, 201]) { expect(n).toBeLessThanOrEqual(RANGES.windowTaps[1]); expect(n).toBeGreaterThanOrEqual(RANGES.windowTaps[0]); }
    expect(F.hannAny).toBe(268); expect(F.hammingAny).toBe(488); expect(F.blackmanAny).toBe(201); expect(F.kaiserAny).toBe(146);
    // not monotone: Kaiser meets, then misses a run of lengths, then meets again
    expect(F.runs.map((r) => r.ok)).toEqual([true, false, true]);
    expect(F.runs[0].from).toBe(146);
    expect(maskReport(windowDesign('kaiser', 147, F.kaiser.beta)).ok).toBe(true); expect(maskReport(windowDesign('kaiser', 151, F.kaiser.beta)).ok).toBe(false);
    expect(F.ham[3]).toBeLessThan(-57); expect(F.ham[3]).toBeGreaterThan(-60); expect(F.rect[1]).toBeGreaterThan(-60);
  });
  it('the window leaves the passband five times better than asked', () => {
    expect(F.dp / F.kaiserRep.passDev).toBeGreaterThan(5); expect(F.dp / F.kaiserRep.passDev).toBeLessThan(5.3);
  });
  it('doubling a window\'s length halves its transition', () => {
    const edge = (n: number) => { const h = windowDesign('blackman', n, 0); for (let i = 0; i < 4096; i++) { const f = 0.1125 + i / 16384; if (maskReport(h, { ...MASK, pass: 0.1, stop: f }).stopPeak < 0.1) return f - 0.1125; } return NaN; };
    const r = edge(201) / edge(101);
    expect(r).toBeGreaterThan(0.4); expect(r).toBeLessThan(0.6);
  });
  it('words: Q1.15 misses, 17 bits miss by 0.22 dB, 18 bits meet it, 115 taps meet it in 16 bits', () => {
    expect(F.q15.stopOk).toBe(false); expect(F.c114.frac).toBe(17); expect(F.c114q.stopOk).toBe(false); expect(F.c114q.stopDb + 60).toBeCloseTo(0.22, 2);
    expect(F.ff.frac).toBe(18); expect(F.ff.bits).toBe(17); expect(F.ch.hwN).toBe(115); expect(F.hwq.ok).toBe(true); expect(F.hw.frac).toBe(17);
    expect(F.spare).toBe(2); expect(F.guardSum).toBe(2); expect(F.guardN).toBe(7);
    for (const f of [15, 17, 18]) { expect(f).toBeGreaterThanOrEqual(RANGES.frac[0]); expect(f).toBeLessThanOrEqual(RANGES.frac[1]); }
    // the guard chip is against the actual product width: 2 at every fraction width of the slider
    for (let f = RANGES.frac[0]; f <= RANGES.frac[1]; f++) {
      const words = tapWords(F.ch.taps, f, 40), bits = bitsToHold(Math.max(...words.map(Math.abs)));
      expect(guardFor(words, 16, bits), `${f} bits after the point`).toBe(2);
    }
  });
  it('folding: 58 for 115 taps, 57 for 114; the folded and shared builds are cheaper than the direct; constants cheaper again', () => {
    expect(foldedMults(115)).toBe(58); expect(foldedMults(114)).toBe(57);
    expect(F.folded.nands).toBeLessThan(F.direct.nands); expect(F.foldedCsd.nands).toBeLessThan(F.folded.nands); expect(F.shared.nands).toBeLessThan(F.foldedCsd.nands);
    expect(F.direct.nands / F.shared.nands).toBeGreaterThan(12);
  });
  it('constants: digits and adders over the distinct taps, the tap the scene draws, and the NANDs against general multipliers', () => {
    const t = csdTotals(), c = csdTap();
    expect(t.distinct).toBe(58); expect(t.csd).toBeLessThan(t.bin); expect(t.nandsCsd).toBeLessThan(t.nandsTree / 4);
    expect(csdOf(c).length).toBeLessThan(binaryDigits(c)); expect(csdAdders(c)).toBe(csdOf(c).length - 1);
    expect(F.csd.tree).toBe(3572);
  });
  it('the scene: 16 taps, 33-bit accumulator, the tones the panel offers, and the gains the text quotes; the reach challenge is met by the stopband tone', () => {
    const s = sceneMac();
    expect(s.cfg.taps.length).toBe(16); expect(F.accBits).toBe(33); expect(F.sceneNands).toBe(stats(firMac(s.cfg)).nands);
    expect(s.report.ok).toBe(true);
    const measured = Object.fromEntries(MAC_TONES.map(([, f]) => [f, macTone(s.cfg, f, { clock: () => {}, check: () => {} }).gain]));
    expect(measured[0.04]).toBeGreaterThan(0.95); expect(measured[0.04]).toBeLessThan(1.05);
    expect(measured[0.35]).toBeLessThan(0.05);
    expect(Math.abs(measured[0.35] - F.gains[0.35])).toBeLessThan(0.01);
    expect(new Set(MAC_TONES.map(([, f]) => f)).has(0.35)).toBe(true);
  });
  it('the table: the 115-tap and the 147-tap filters both meet the mask in 16-bit words; Parks–McClellan is cheaper in every build', () => {
    const rows = designRows();
    expect(rows.every((r) => r.ok)).toBe(true);
    for (const st of ['Direct', 'Folded:', 'Folded, taps', 'One multiplier']) {
      const a = rows.find((r) => r.design !== 'Kaiser window' && r.structure.startsWith(st))!, b = rows.find((r) => r.design === 'Kaiser window' && r.structure.startsWith(st))!;
      expect(a.nands, st).toBeLessThan(b.nands);
    }
    expect(F.rows.length).toBe(rows.length);
    expect(1e5 / 115).toBeLessThan(1000);
    expect((115 * 48000) / 1e6).toBeCloseTo(5.52, 2);
  });
  it('the guard bits the taps ask for are enough for the worst input, and one fewer is not', () => {
    const cfg = macOf(chapterDesign().hwTaps), N = cfg.taps.length;
    // the worst input: full scale with the sign of each tap, so that every product adds (−32768 on a negative tap makes a positive product)
    const worst = (c: MacConfig) => {
      const m = new MacModel(c);
      const xs = c.taps.map((t) => (t >= 0 ? 32767 : -32768)).reverse();
      for (let f = 0; f < xs.length + 1; f++) for (let k = 0; k < N; k++) m.edge(k === N - 1 ? (xs[f] ?? 0) : 0);
      return m;
    };
    expect(cfg.guard).toBe(2);
    const m = worst(cfg);
    // the unwrapped sum, against the limit of the accumulator the gates have
    expect(Math.abs(m.exact)).toBeLessThan(2 ** (2 * 16 + cfg.guard - 1));
    expect(Math.abs(m.exact)).toBeGreaterThanOrEqual(2 ** (2 * 16 + cfg.guard - 2));
    // one guard bit fewer would wrap: the model's own accumulator then disagrees with the exact sum
    const tight = worst({ ...cfg, guard: cfg.guard - 1 });
    expect(Math.abs(tight.exact)).toBeGreaterThanOrEqual(2 ** (2 * 16 + cfg.guard - 2));
    expect(tight.acc).not.toBe(tight.exact);
    expect(m.acc).toBe(m.exact);
  });
  it('the fastest clocks: the parallel builds well under the clocks the slider offers at its top, the one multiplier timed from its gates', () => {
    const rows = designRows(), shared = rows.find((r) => r.design !== 'Kaiser window' && r.cycles > 1)!;
    expect(shared.basis).toBe('analysed');
    expect(shared.period).toBe(analyzeTiming(flatten(firMac(macOf(chapterDesign().hwTaps)), { mode: 'gate' }))!.period);
    for (const r of rows.filter((r) => r.cycles === 1)) { expect(r.basis).toBe('sum of parts'); expect(r.maxMhz, r.structure).toBeLessThan(RANGES.clock[1] / 2); }
    expect(shared.maxMhz).toBeGreaterThan(100);
    // the quiz: 10 million samples a second is within the parallel builds and beyond one multiplier
    expect(Math.min(...rows.filter((r) => r.cycles === 1).map((r) => r.maxMhz))).toBeGreaterThan(10);
    expect(shared.maxMhz / shared.cycles).toBeLessThan(10);
    expect(F.tShared.maxMhz / F.ch.hwN).toBeLessThan(10);
  });
});

/** The weighted design at the slider's stopband weight 10^k. */
import { remez, deltaStop } from '../src/dsp/firdesign';
function pmTapsWeighted(n: number, k: number): number[] {
  return remez(n, [0, MASK.pass, MASK.stop, 0.5], [1, 0], [1 / deltaPass(MASK), 10 ** k / deltaStop(MASK)]).taps;
}
void firCosts;
