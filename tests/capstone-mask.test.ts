// The filter-to-a-mask capstone: the bench holds the reference to the sheet with margin, and each wrong design fails for the reason it should,
// whatever the seed of the sequences (the learner never sees the seed).

import { describe, expect, it } from 'vitest';
import { capstoneById, capstoneChallenge, capstoneChipId, capstoneOfChip, capstoneRule, referenceNands } from '../src/campaign/capstone';
import { MASK_FRAC, MASK_SPEC, MASK_TAPS, maskIirSections, maskReference, maskReferenceDef, maskSeed, maskWords, runMask, sineLanes } from '../src/campaign/capmask';
import { checkChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { CAPSTONES, COMM_CAPSTONES, DSP_CAPSTONES } from '../src/learn/capstones';
import { constWord } from '../src/lib/alu';
import { Builder } from '../src/lib/builder';
import { placed } from '../src/lib/fft';
import { clampWord } from '../src/lib/fixedpt';
import { define } from '../src/lib/define';
import { maskAccBits, maskFir, maskIir } from '../src/lib/maskfilter';
import { stats } from '../src/sim/stats';
import { tick } from './yieldtick';

const SEEDS = [1, 2, 3, 77, 4242];
const ref = maskReference();
const OPEN = { budget: 1e9 };

/** Which of the bench's reasons a failure list gives. */
const reasons = (f: string[]) => ({
  pass: f.some((x) => /^pass band/.test(x)), stop: f.some((x) => /^stop band/.test(x)), wrap: f.some((x) => /wrapped/.test(x)), clip: f.some((x) => /clipped/.test(x)),
  cycle: f.some((x) => /never dies|still moving/.test(x)), budget: f.some((x) => /the budget is/.test(x)),
  other: f.filter((x) => !/^(pass band|stop band)|worst-case|noise|never dies|still moving|the budget is/.test(x)),
});

describe('the mask capstone', () => {
  it('is the DSP group on My path: cap_mask, cap_echo and cap_tune routed; the other groups are untouched', () => {
    expect(DSP_CAPSTONES.map((c) => c.id)).toEqual(['cap_mask', 'cap_echo', 'cap_tune']);
    expect(DSP_CAPSTONES.find((c) => c.id === 'cap_mask')!.route).toBe('#/campaign/play/cap_mask');
    expect(DSP_CAPSTONES.find((c) => c.id === 'cap_echo')!.route).toBe('#/campaign/play/cap_echo');
    expect(capstoneById('cap_tune')?.route).toBe('#/campaign/play/cap_tune');
    expect(capstoneById('cap_mask')?.title).toBe('A filter to a mask');
    expect(capstoneById('cap_fault')).toBeTruthy();
    expect(capstoneById('cap_t1')?.tier).toBe(1);
    expect(capstoneOfChip(capstoneChipId('cap_mask'))?.id).toBe('cap_mask');
    expect(CAPSTONES.length).toBe(4);
    expect(COMM_CAPSTONES.length).toBe(4);
    // only cap_mask has a challenge
    expect(capstoneChallenge('cap_mask')).toBeTruthy();
    expect(capstoneChallenge('cap_echo')).toBeUndefined();
  });

  it('has the pins and the rule of the sheet', () => {
    const ch = capstoneChallenge('cap_mask')!;
    expect(ch.ports.map((p) => `${p.name}:${p.dir}:${p.width}`)).toEqual(['x:in:12', 'clk:in:1', 'y:out:14']);
    const lib = capstoneRule('cap_mask')!.lib;
    expect(lib).toContain('nand');
    expect(lib).toContain('rca*');
    expect(lib.some((x) => /fir|biquad/.test(x))).toBe(false);
    expect(ch.brief).toMatch(/48 kHz/);
    expect(ch.brief).toMatch(/13\D000 NANDs/);
  });

  it('the reference passes through checkChallenge with its restrictions, within budget, at a margin', () => {
    const ch = capstoneChallenge('cap_mask')!;
    const chips = ch.answer();
    const ws = { ...emptyWorkspace(), chips: Object.fromEntries(chips.map((d) => [d.id, d])) };
    const r = checkChallenge(ch, new UserLibrary(ws).compiled(chips[chips.length - 1].id));
    expect(r.failures).toEqual([]);
    expect(r.restrictionViolations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tested).toBeGreaterThan(60);
    const n = referenceNands('cap_mask')!;
    expect(n).toBe(stats(maskReferenceDef()).nands);
    expect(n).toBeLessThan(MASK_SPEC.budget * 0.85);
  }, 120_000);

  it('the reference meets the mask with margin under every seed, and the seeds do draw different frequencies', async () => {
    const seen = new Set<string>();
    for (const seed of [...SEEDS, maskSeed(maskReferenceDef())]) {
      await tick();
      const r = runMask(maskReferenceDef(), 'gate', { seed });
      expect(r.failures, `seed ${seed}`).toEqual([]);
      expect(Math.abs(r.measure!.passWorst.db), `pass ripple, seed ${seed}`).toBeLessThan(MASK_SPEC.rippleDb - 0.25);
      expect(r.measure!.stopWorst.db, `stop band, seed ${seed}`).toBeLessThan(-MASK_SPEC.stopDb - 5);
      expect(r.measure!.gainSum).toBeGreaterThan(1.3);
      expect(r.measure!.gainSum).toBeLessThan(1.6);
      seen.add(sineLanes(seed).map((l) => l.m).join());
    }
    expect(seen.size).toBeGreaterThan(4);
    for (const seed of SEEDS) {
      const l = sineLanes(seed);
      expect(l.length).toBe(32);
      expect(l.map((x) => x.m)).toContain(20);
      expect(l.map((x) => x.m)).toContain(40);
    }
  }, 120_000);

  it('too few taps misses the stop band, and says where and by how much', async () => {
    const few = maskWords(11);
    const def = maskFir({ words: few, frac: MASK_FRAC, accBits: maskAccBits(few), tag: 'too few' });
    for (const seed of SEEDS) {
      await tick();
      const f = runMask(def, 'gate', { seed }).failures, r = reasons(f);
      expect(r.stop, `seed ${seed}: ${f.join(' | ')}`).toBe(true);
      expect(r.wrap || r.clip || r.cycle || r.budget, f.join(' | ')).toBe(false);
      expect(r.other).toEqual([]);
      expect(f.find((x) => /^stop band/.test(x))).toMatch(/at \d+(\.\d+)? kHz the gain is −\d+\.\d dB; from 9\.6 kHz up it must be −40\.0 dB or lower \(\d+\.\d dB short/);
    }
    expect(MASK_TAPS).toBe(21);
  }, 120_000);

  it('a word one bit too short wraps on the worst-case input, and the mask is still met', async () => {
    const def = maskFir({ words: ref.words, frac: ref.frac, accBits: ref.accBits - 1, tag: 'a bit short' });
    for (const seed of SEEDS) {
      await tick();
      const f = runMask(def, 'gate', { seed }).failures, r = reasons(f);
      expect(r.wrap, `seed ${seed}: ${f.join(' | ')}`).toBe(true);
      expect(r.pass || r.stop || r.cycle || r.budget, f.join(' | ')).toBe(false);
      expect(f.find((x) => /wrapped/.test(x))).toMatch(/worst-case input.*sample \d+: y reads -?\d+ where the impulse response says -?\d+, so a word wrapped: y is off by exactly [\d,\s]+ = 2\^\d+/);
    }
  }, 120_000);

  it('names a clip a clip, never a wrap; an inverted output inverted, not −120 dB; a wrap before the gain it spoils', async () => {
    const inner = maskReferenceDef();
    const clip12 = define({
      id: 't_maskclip12', name: 'clip 12', category: 'arithmetic', summary: '', symbol: { kind: 'box', label: 'CLIP' },
      ports: [{ name: 'x', width: 12, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'y', width: 14, dir: 'out' }],
      netlist: () => {
        const b = new Builder(10, 10, 4);
        b.pins('x', 'clk');
        const f = b.op(inner, ['x', 'clk'], 'fir', 'f'), c = b.op(clampWord(12, 14), [`${f}.y`], 'clamp', 'c');
        b.wire(b.op1(placed(12, 0, 14), [`${c}.y`], 'ext', 'e'), 'y');
        return { pins: { x: [0, 6], clk: [0, 22], y: [b.right, 6] }, instances: b.instances, nets: b.nets() };
      },
    });
    const neg = maskFir({ words: ref.words.map((v) => -v), frac: ref.frac, accBits: ref.accBits, tag: 'negated' });
    const halfUp = maskIir({ sections: maskIirSections(), round: 'half-up' });
    const short3 = maskFir({ words: ref.words, frac: ref.frac, accBits: ref.accBits - 3, tag: 'three short' });
    for (const seed of [1, 2, 3]) {
      await tick();
      const c = runMask(clip12, 'gate', { seed }).failures, rc = reasons(c);
      expect(rc.clip && !rc.wrap, `seed ${seed}: ${c.join(' | ')}`).toBe(true);
      await tick();
      const n = runMask(neg, 'gate', { seed }).failures;
      expect(n.join(' | ')).toMatch(/at 0 Hz \(DC\) an input of \+1800 held steady comes out near −1\d{3}: the gain is negative \(× −1\.0\d\), so the output is inverted/);
      expect(n.join(' | ')).not.toMatch(/−120/);
      await tick();
      // the half-up loop's rounding: a limit cycle, and the worst-case line points at it rather than at a word's width
      const hu = runMask(halfUp, 'gate', { seed, ...OPEN }).failures;
      expect(reasons(hu).wrap, `seed ${seed}`).toBe(false);
      const huw = hu.find((x) => /worst-case|noise/.test(x));
      if (huw) expect(huw).toMatch(/may be the limit cycle above/);
      await tick();
      // a wrap bends the impulse response: no bit count from it, and a small negative DC gain is not called an inversion
      const s = runMask(short3, 'gate', { seed }).failures;
      const wi = s.findIndex((x) => /worst-case|noise/.test(x)), pi = s.findIndex((x) => /^pass band/.test(x));
      expect(wi, s.join(' | ')).toBeGreaterThanOrEqual(0);
      if (pi >= 0) expect(wi).toBeLessThan(pi);
      expect(s[wi]).toMatch(/widen the one that wraps/);
      expect(s[wi]).not.toMatch(/needs \d+ bits/);
      expect(s.join(' | ')).not.toMatch(/inverted/);
    }
  }, 240_000);

  it('an IIR that floors what it feeds back has a limit cycle, named by its period; a good IIR passes everything but the budget', async () => {
    const sections = maskIirSections();
    const floor = maskIir({ sections, round: 'trunc' }), toward = maskIir({ sections, round: 'zero' });
    for (const seed of [1, 2, 3]) {
      await tick();
      const f = runMask(floor, 'gate', { seed, ...OPEN }).failures, r = reasons(f);
      expect(r.cycle, `seed ${seed}: ${f.join(' | ')}`).toBe(true);
      expect(r.pass || r.stop || r.wrap || r.clip || r.budget, f.join(' | ')).toBe(false);
      expect(f.find((x) => /never dies/.test(x))).toMatch(/after (one input|\d inputs) of -?\d+ and then silence the output never dies: from sample \d+ it repeats every \d+ samples? \(/);
      await tick();
      const g = runMask(toward, 'gate', { seed, ...OPEN });
      expect(g.failures, `seed ${seed}`).toEqual([]);
    }
    // the same circuit under the real budget: it is over
    const over = runMask(toward, 'gate', { seed: 1 }).failures;
    expect(reasons(over).budget).toBe(true);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatch(/^[\d,\s]+ NANDs; the budget is 13[,\s]?000 \(/);
    expect(stats(toward).nands).toBeGreaterThan(MASK_SPEC.budget * 2);
  }, 240_000);

  it('a pin of the wrong width is refused before anything runs', () => {
    const wrong = maskFir({ words: ref.words, frac: ref.frac, accBits: ref.accBits });
    const bad = { ...wrong, ports: wrong.ports.map((p) => (p.name === 'y' ? { ...p, width: 12 } : p)) };
    expect(runMask(bad, 'gate').failures[0]).toMatch(/pin y is 12 bits; the sheet says 14 bits/);
    expect(runMask(wrong, 'switch').failures[0]).toMatch(/switch level/);
  });

  it('a circuit that does nothing is told so', () => {
    const dead = define({
      id: 'mask_dead', name: 'dead', category: 'arithmetic', summary: '', symbol: { kind: 'box', label: 'DEAD' },
      ports: [{ name: 'x', width: 12, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'y', width: 14, dir: 'out' }],
      netlist: () => { const b = new Builder(10, 10); b.pins('x', 'clk'); b.wire(b.op1(constWord(14, 0), [], 'zero', 'z'), 'y'); return { pins: { x: [0, 2], clk: [0, 6], y: [b.right, 2] }, instances: b.instances, nets: b.nets() }; },
    });
    const f = runMask(dead, 'gate').failures;
    expect(f.join(' | ')).toMatch(/an impulse of full scale \(2047\) gives an output of zero/);
    expect(reasons(f).pass).toBe(true);
  });
});
