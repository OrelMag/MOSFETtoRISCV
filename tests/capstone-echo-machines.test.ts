// The echo capstone's two other machines, the RV32 + MAC and the DSP core: the same bar (25 dB on every path, 2 400 cycles a sample), each with its own
// reference that passes with margin on fresh seeds, mutants that fail for their stated reason with the machine's own words, a probe diagnosis that is true
// on the machine it was graded on, and the assembler's errors on lines. The 60-seed sweeps behind the margins are in the commit message.

import { describe, expect, it } from 'vitest';
import { assembleEcho, ECHO_SPEC, ECHO_STARTERS, echoPaths, type EchoMachineId, gradeEcho, macReference, type MacRefOpts, probeEcho, referenceCycles, referenceFor } from '../src/campaign/capecho';
import { assembleDsp, DSP_IO, dspReference, type DspRefOpts, DSP_REF_SHIFT } from '../src/campaign/capechodsp';
import { tick } from './yieldtick';

const FRESH = [1000, 1037, 1074, 1111];
const mac = (o: MacRefOpts, seeds = [1, 2]) => seeds.map((seed) => ({ seed, v: gradeEcho(macReference(o), seed, { machine: 'mac' }) }));
const dsp = (o: DspRefOpts, seeds = [1, 2]) => seeds.map((seed) => ({ seed, v: gradeEcho(dspReference(o), seed, { machine: 'dsp' }) }));

describe('every machine: the starter, the reference, the cycles', () => {
  for (const m of ['mac', 'dsp'] as EchoMachineId[]) {
    it(`${m}: the starter assembles, scores 0 dB and says ŷ was 0; the reference assembles, passes on fresh seeds with margin and its cycles are the computed figure`, async () => {
      expect(assembleEcho(ECHO_STARTERS[m], m).errors).toEqual([]);
      for (const r of gradeEcho(ECHO_STARTERS[m], 4, { machine: m }).results) { expect(r.erle).toBeCloseTo(0, 1); expect(r.why).toMatch(/ŷ was 0 on every one/); }
      expect(assembleEcho(referenceFor(m), m).errors).toEqual([]);
      for (const seed of FRESH) {
        await tick();
        const v = gradeEcho(referenceFor(m), seed, { machine: m });
        expect(v.reasons, `${m} seed ${seed}`).toEqual([]);
        expect(v.minErle, `${m} seed ${seed}`).toBeGreaterThan(30);
        expect(v.worstCycles, `${m} seed ${seed}`).toBeLessThan(ECHO_SPEC.budget * 0.85);
        // the figure the page shows beside the learner's is measured, and is the run's own up to the data-dependent branches (the ring's wrap, the bit-length loop)
        expect(Math.abs(v.worstCycles - referenceCycles(m)), `${m} seed ${seed}`).toBeLessThan(20);
      }
    }, 300_000);
  }

  it('the MAC pays: its reference takes fewer cycles than the RV32IM\'s, the DSP core\'s fewer still, all under the same bar', () => {
    expect(referenceCycles('mac')).toBeLessThan(referenceCycles('rv32im'));
    expect(referenceCycles('dsp')).toBeLessThan(referenceCycles('mac'));
    expect(referenceCycles('rv32im')).toBeLessThan(ECHO_SPEC.budget);
  });

  it('the MAC rolled (a plain loop, the way the chapter first writes it) passes with 30 dB too', async () => {
    for (const { seed, v } of mac({ unroll: 1, updUnroll: 1 }, FRESH.slice(0, 2))) {
      await tick();
      expect(v.reasons, `seed ${seed}`).toEqual([]);
      expect(v.minErle).toBeGreaterThan(30);
      expect(v.worstCycles).toBeGreaterThan(referenceCycles('mac'));
    }
  }, 120_000);
});

describe('the RV32 + MAC', () => {
  it('refuses the MAC instructions on the RV32IM machine, and takes them here', () => {
    expect(assembleEcho('clracc\n', 'rv32im').errors[0].message).toMatch(/MAC instruction/);
    expect(assembleEcho('clracc\nmac a0, a1\nmac2 a0, a1\nracc a2, a1\n', 'mac').errors).toEqual([]);
  });

  it('mutants: no update → ŷ was 0; sign flipped → ran away; μ of 4 → ran away; over the budget → the budget with its overshoot', async () => {
    for (const { seed, v } of mac({ update: false })) { expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/ŷ was 0 on every one/); }
    for (const o of [{ sign: -1 }, { muShift: 21 }] as MacRefOpts[]) for (const { seed, v } of mac(o)) { await tick(); expect(v.ok, `${JSON.stringify(o)} seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/louder than the echo itself/); }
    for (const { v } of mac({ busy: 800 }, [1])) for (const r of v.results) { expect(r.fault?.kind).toBe('budget'); expect(r.why).toMatch(/over the budget of 2.?400/); }
  }, 120_000);

  it('mutants of the MAC itself: no racc → ŷ was 0; no clracc → the accumulator grows across samples and the residual runs away', () => {
    for (const { seed, v } of mac({ noRacc: true })) { expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/ŷ was 0 on every one/); }
    for (const { seed, v } of mac({ noClr: true })) { expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why, `seed ${seed}`).toMatch(/louder than the echo itself/); }
  });

  it('too few taps fails the long path on ERLE with the probe passing, and the probe was run on the MAC (it would not assemble otherwise)', async () => {
    for (const { seed, v } of mac({ taps: 64 }, [1, 2, 3])) {
      await tick();
      expect(v.ok).toBe(false);
      const long = v.results.find((r) => r.path.cls === 'long')!;
      expect(long.pass).toBe(false);
      expect(long.fault).toBeNull();
      expect(v.diagnosis, `seed ${seed}`).toMatch(/So the update works there/);
    }
    const p = probeEcho(assembleEcho(macReference(), 'mac').words, 'mac');
    expect(p.loud).toBeGreaterThan(35);
    expect(p.quiet).toBeGreaterThan(30);
  }, 120_000);

  it('μ of 2 on the MAC: the probe falls short at the usual level and does better quieter: "the step is too large"', () => {
    for (const { seed, v } of mac({ muShift: 20 })) { expect(v.ok).toBe(false); expect(v.diagnosis, `seed ${seed}`).toMatch(/the step is too large at the usual level/); }
  });
});

describe('the DSP core', () => {
  it('the assembler\'s errors come back on lines, and a program past the ROM says so', () => {
    expect(assembleDsp('ldi r1, 1\nfrob r1\n').errors[0]).toMatchObject({ line: 2 });
    expect(assembleDsp(`${'nop\n'.repeat(257)}`).errors[0].message).toMatch(/does not fit in 256 words/);
    expect(assembleEcho('ldi r1, 1\nout r1\n', 'dsp').errors).toEqual([]);
  });

  it('the bench owns X[254] and Y[255]: x arrives in X[254] and d in Y[255] only after the out, and a read of Y[255] before it gives the last d', () => {
    // out the x just read, then read d: the next loop's early read of Y[255] must equal the d of the sample before
    const src = `ldi p1, ${DSP_IO.x}\nldi p6, ${DSP_IO.d}\nloop: ld r1, y(p6)\nld r2, x(p1)\nout r2\njmp loop\n`;
    const path = echoPaths(2, 40)[0];
    const v = gradeEcho(src, 2, { machine: 'dsp', paths: [path] });
    expect(v.results[0].answered).toBe(40);
    expect(v.results[0].fault).toBeNull();
    // ŷ[n] = x[n]: far from the echo, a real failure of ERLE, never a protocol one
    expect(DSP_IO).toEqual({ x: 254, d: 255 });
  });

  it('mutants: no update → ŷ was 0; sign flipped → the residual runs away; two outs per x and a step too large fail on the curve', async () => {
    for (const { seed, v } of dsp({ update: false })) { expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/ŷ was 0 on every one/); }
    for (const { seed, v } of dsp({ sign: -1 })) { await tick(); expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/louder than the echo itself/); }
    for (const { seed, v } of dsp({ twice: true })) { expect(v.ok, `seed ${seed}`).toBe(false); expect(v.reasons.length).toBeGreaterThan(0); for (const r of v.results) expect(r.fault).toBeNull(); }
  }, 120_000);

  it(`mutant: a step too large (rndc shift 7 instead of ${DSP_REF_SHIFT}) is stable on steady noise and unstable on speech: only speech paths fail, none is called wrong from the start, and the probe says the update works on noise`, async () => {
    for (const { seed, v } of dsp({ gshift: 7 }, [1, 2, 3])) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      for (const r of v.results.filter((x) => !x.pass)) expect(r.path.source, `seed ${seed}`).toBe('speech');
      // none of the curves is called wrong from the start, and the probe, run on steady noise, says the update works and names speech's bursts
      for (const r of v.results.filter((x) => !x.pass)) expect(r.why).not.toMatch(/wrong from the start|ŷ was 0/);
      expect(v.diagnosis, `seed ${seed}`).toMatch(/So the update works there.*speech's bursts and colour.*the update is unstable.*Do not raise the step/);
      expect(v.diagnosis).not.toMatch(/the step is the one to raise/);
    }
  }, 120_000);

  it('mutant: 32 taps fails the long path on ERLE, and the probe (run on the DSP core) passes: the tail is what the path adds', async () => {
    for (const { seed, v } of dsp({ taps: 32 }, [1, 2])) {
      await tick();
      expect(v.ok).toBe(false);
      expect(v.results.find((r) => r.path.cls === 'long')!.pass).toBe(false);
      expect(v.diagnosis, `seed ${seed}`).toMatch(/So the update works there/);
    }
    const p = probeEcho(assembleDsp(dspReference()).words, 'dsp');
    expect(p.loud).toBeGreaterThan(35);
    expect(p.quiet).toBeGreaterThan(30);
  }, 120_000);

  it('mutant: over the cycle budget → every path stops on the budget with its overshoot', () => {
    for (const { v } of dsp({ busy: 1000 }, [1])) for (const r of v.results) { expect(r.fault?.kind).toBe('budget'); expect(r.why).toMatch(/took [\d\s  ]+ cycles, [\d\s  ]+ over the budget of 2.?400/); }
  });

  it('protocol: halting before the last sample, an out that never comes, and a first out that takes too long are each named in the core\'s words', () => {
    expect(gradeEcho('ldi r1, 1\nout r1\nhalt\n', 1, { machine: 'dsp' }).results[0].why).toMatch(/halted after sample 0 of 16.?000: it must keep answering until the last/);
    expect(gradeEcho('spin: jmp spin\n', 1, { machine: 'dsp' }).results[0].why).toMatch(/no out in [\d\s  ]+ cycles/);
    expect(gradeEcho('ldi r1, 3\nspin: jmp spin\n', 1, { machine: 'dsp' }).results[0].fault?.kind).toBe('setup');
    const late = gradeEcho('ldi r1, 1\nout r1\nspin: jmp spin\n', 1, { machine: 'dsp' }).results[0];
    expect(late.fault?.kind).toBe('budget');
    expect(late.why).toMatch(/never reached its out/);
  });
});
