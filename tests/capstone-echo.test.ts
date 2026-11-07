// The echo-canceller capstone: the bench injects echo paths from a seed the learner never sees and holds back what it grades. The reference passes with
// margin under every seed, and each wrong program fails for the reason it should (and says so), whatever the seed.

import { describe, expect, it } from 'vitest';
import { assembleEcho, ECHO_MACHINES, ECHO_SPEC, ECHO_STARTER, echoPaths, echoReference, gradeEcho, type RefOpts } from '../src/campaign/capecho';
import { capstoneById } from '../src/campaign/capstone';
import { erleDb, Lms } from '../src/dsp/adaptive';
import { DSP_CAPSTONES } from '../src/learn/capstones';
import { tick } from './yieldtick';

const SEEDS = [1, 2, 3, 77];
const MORE = [5, 9, 12, 404, 31337, 2718];
const ref = echoReference();

describe('the echo capstone', () => {
  it('is routed on My path in the DSP group, and the other groups are as they were', () => {
    const c = DSP_CAPSTONES.find((x) => x.id === 'cap_echo')!;
    expect(c.route).toBe('#/campaign/play/cap_echo');
    expect(DSP_CAPSTONES.map((x) => x.id)).toEqual(['cap_mask', 'cap_echo', 'cap_tune']);
    expect(DSP_CAPSTONES.find((x) => x.id === 'cap_tune')!.route).toBeNull();
    expect(capstoneById('cap_echo')?.title).toBe('An echo canceller');
  });

  it('offers RV32IM, and the MAC and DSP machines only as coming soon', () => {
    expect(ECHO_MACHINES.map((m) => [m.id, m.ready])).toEqual([['rv32im', true], ['mac', false], ['dsp', false]]);
  });

  it('draws four paths from the seed: one short, two medium, one long tail, of different gains, and different ones for other seeds', () => {
    const a = echoPaths(1), b = echoPaths(2);
    expect(a.map((p) => p.cls).sort()).toEqual(['long', 'medium', 'medium', 'short']);
    expect(echoPaths(1).map((p) => `${p.taps}:${p.erlDb}:${p.d[777]}`)).toEqual(a.map((p) => `${p.taps}:${p.erlDb}:${p.d[777]}`));
    expect(a.map((p) => `${p.taps}:${p.erlDb.toFixed(2)}`)).not.toEqual(b.map((p) => `${p.taps}:${p.erlDb.toFixed(2)}`));
    for (const p of [...a, ...b]) {
      expect(p.erlDb).toBeGreaterThanOrEqual(6);
      expect(p.erlDb).toBeLessThanOrEqual(16);
      expect(p.taps).toBeLessThanOrEqual(ECHO_SPEC.maxTaps);
      expect(p.x.length).toBe(ECHO_SPEC.samples);
    }
    expect(new Set([...a, ...b].map((p) => p.taps)).size).toBeGreaterThan(5);
    expect(a.map((p) => p.source).sort()).toEqual(['noise', 'noise', 'speech', 'speech']);
  });

  it('the microphone is the echo plus noise, and the echo is what the far end made through the path', () => {
    for (const p of echoPaths(3)) {
      let noise = 0;
      for (let i = 0; i < p.d.length; i++) noise += (p.d[i] - p.echo[i]) ** 2;
      expect(Math.sqrt(noise / p.d.length)).toBeGreaterThan(ECHO_SPEC.noiseLsb * 0.8);
      expect(Math.sqrt(noise / p.d.length)).toBeLessThan(ECHO_SPEC.noiseLsb * 1.2);
      // nothing before the delay: the echo cannot lead the far end
      for (let i = 0; i < p.delay; i++) expect(p.echo[i]).toBe(0);
    }
  });

  it('the reference assembles inside the limits and the starter assembles', () => {
    expect(assembleEcho(ref).errors).toEqual([]);
    expect(assembleEcho(ref).words.length).toBeLessThan(ECHO_SPEC.codeWords / 2);
    expect(assembleEcho(ECHO_STARTER).errors).toEqual([]);
    expect(assembleEcho('  bogus x1, x2\n').errors[0].line).toBe(1);
  });

  it('the reference passes under every seed with margin on ERLE and on cycles, and tracks the float NLMS model within 3 dB', async () => {
    for (const seed of [...SEEDS, ...MORE]) {
      await tick();
      const v = gradeEcho(ref, seed);
      expect(v.reasons, `seed ${seed}`).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.minErle, `seed ${seed}`).toBeGreaterThan(ECHO_SPEC.erleDb + 5);
      expect(v.worstCycles, `seed ${seed}`).toBeLessThan(ECHO_SPEC.budget * 0.85);
      if (seed > 3) continue;
      echoPaths(seed).forEach((p, i) => {
        const f = new Lms(96, 0.5, true, 1), echo: number[] = [], res: number[] = [];
        for (let n = 0; n < p.x.length; n++) { const r = f.step(p.x[n], p.d[n]); echo.push(p.echo[n]); res.push(p.echo[n] - r.y); }
        const model = erleDb(echo.slice(ECHO_SPEC.window), res.slice(ECHO_SPEC.window));
        expect(Math.abs(v.results[i].erle - model), `seed ${seed} path ${i}`).toBeLessThan(3);
      });
    }
  }, 120_000);

  it('the starter (ŷ = 0) scores 0 dB and says nothing is being subtracted', () => {
    const v = gradeEcho(ECHO_STARTER, 4);
    expect(v.ok).toBe(false);
    for (const r of v.results) { expect(r.erle).toBeCloseTo(0, 1); expect(r.why).toMatch(/ŷ stayed at 0/); }
  });

  it('the cycle budget is a hard edge: 400 idle cycles still pass, 600 do not, and the message says by how much', () => {
    const ok = gradeEcho(echoReference({ busy: 200 }), 2);
    expect(ok.ok).toBe(true);
    expect(ok.worstCycles).toBeLessThanOrEqual(ECHO_SPEC.budget);
    const over = gradeEcho(echoReference({ busy: 300 }), 2);
    expect(over.ok).toBe(false);
    for (const r of over.results) {
      expect(r.fault?.kind).toBe('budget');
      const m = /took ([\d,]+) cycles, ([\d,]+) over the budget of 2,400/.exec(r.why)!;
      expect(m).toBeTruthy();
      expect(Number(m[1].replace(/,/g, '')) - Number(m[2].replace(/,/g, ''))).toBe(ECHO_SPEC.budget);
    }
  });

  it('a program that never reads x again is stopped, and one that stops at a jump to itself is told so', () => {
    const spin = gradeEcho('lui s0, 0x10000\nlw t0, 0(s0)\nsw zero, 4(s0)\nspin: j spin\n', 2);
    expect(spin.ok).toBe(false);
    expect(spin.reasons[0]).toMatch(/stopped|never reached the next x/);
    const slow = gradeEcho('lui s0, 0x10000\nlw t0, 0(s0)\nsw zero, 4(s0)\nli t1, 1\nl: addi t1, t1, 1\nj l\n', 2);
    expect(slow.reasons[0]).toMatch(/never reached the next x|budget/);
  });

  // ---- the mutants: each fails for its stated reason, on every path or the paths it should, under several seeds ----

  const verdicts = (o: RefOpts, seeds = SEEDS) => seeds.map((seed) => ({ seed, v: gradeEcho(echoReference(o), seed) }));

  it('mutant: no weight update → ŷ stays 0, 0 dB on every path', async () => {
    for (const { seed, v } of verdicts({ update: false })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      expect(v.results.every((r) => /ŷ stayed at 0/.test(r.why) && Math.abs(r.erle) < 0.1), `seed ${seed}`).toBe(true);
    }
  }, 120_000);

  it('mutant: the update\'s sign flipped → diverging, residual louder than the echo, on every path', async () => {
    for (const { seed, v } of verdicts({ sign: -1 })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      for (const r of v.results) { expect(r.why, `seed ${seed}`).toMatch(/diverging/); expect(r.erle).toBeLessThan(-10); }
    }
  }, 120_000);

  it('mutant: μ too large (4) → diverging on every path; μ of 2 is no better than not learning', async () => {
    for (const { seed, v } of verdicts({ muShift: 21 })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      for (const r of v.results) expect(r.why, `seed ${seed}`).toMatch(/diverging/);
    }
    for (const { seed, v } of verdicts({ muShift: 20 }, [1, 2])) expect(v.ok, `seed ${seed}`).toBe(false);
  }, 120_000);

  it('mutant: μ too small (1/32) → not converged: still rising when the window ends, on at least three of four paths', async () => {
    for (const { seed, v } of verdicts({ muShift: 14 })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      expect(v.results.filter((r) => /not converged/.test(r.why)).length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
      for (const r of v.results) expect(r.fault).toBeNull();
    }
  }, 120_000);

  it('mutant: 32 taps → the long tail fails on its ERLE (never a protocol or budget fault), the short tail still passes', async () => {
    for (const { seed, v } of verdicts({ taps: 32 })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      const long = v.results.find((r) => r.path.cls === 'long')!, short = v.results.find((r) => r.path.cls === 'short')!;
      expect(long.pass, `seed ${seed}`).toBe(false);
      expect(long.fault).toBeNull();
      expect(long.erle, `seed ${seed}`).toBeLessThan(ECHO_SPEC.erleDb - 5);
      expect(long.why).toMatch(/ERLE [\d.]+ dB over the last 4000 samples, 25.0 dB needed/);
      expect(short.pass, `seed ${seed}`).toBe(true);
      expect(v.worstCycles).toBeLessThan(ECHO_SPEC.budget / 2);
    }
  }, 120_000);

  it('mutant: over the cycle budget → every path stops on the budget with its overshoot, before any ERLE counts', () => {
    for (const { seed, v } of verdicts({ busy: 300 }, [1, 2, 3])) {
      expect(v.ok, `seed ${seed}`).toBe(false);
      for (const r of v.results) { expect(r.fault?.kind).toBe('budget'); expect(r.why).toMatch(/over the budget of 2,400/); }
    }
  });

  it('mutants of the protocol: two ŷ per x, a skipped ŷ, and reading the microphone first are each named', () => {
    for (const seed of [1, 2]) {
      expect(gradeEcho(echoReference({ twice: true }), seed).reasons[0], `seed ${seed}`).toMatch(/ŷ written twice/);
      expect(gradeEcho(echoReference({ skipY: true }), seed).reasons[0], `seed ${seed}`).toMatch(/no ŷ was written for this one/);
      expect(gradeEcho(echoReference({ peek: true }), seed).reasons[0], `seed ${seed}`).toMatch(/microphone was read before ŷ/);
    }
  });

  it('what is graded is the estimate against the true echo: copying the microphone into ŷ is refused, and outputting 0 as the error scores nothing', () => {
    // d read before ŷ is refused (above); the only way left is ŷ from the past, which cannot be the echo of this sample
    const lag = gradeEcho('lui s0, 0x10000\nli s1, 0\nl: lw t0, 0(s0)\nsw s1, 4(s0)\nlw s1, 8(s0)\nj l\n', 3);
    expect(lag.ok).toBe(false);
    for (const r of lag.results) expect(r.erle).toBeLessThan(5);
  });
});
