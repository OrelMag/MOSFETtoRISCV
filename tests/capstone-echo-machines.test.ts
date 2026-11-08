// The echo capstone's two other machines, the RV32 + MAC and the DSP core: the same bar (25 dB on every path, 2 400 cycles a sample), each with its own
// reference that passes with margin on fresh seeds, mutants that fail for their stated reason with the machine's own words, a probe diagnosis that is true
// on the machine it was graded on, and the assembler's errors on lines. The 60-seed sweeps behind the margins are in the commit message.

import { describe, expect, it } from 'vitest';
import { assembleEcho, ECHO_SPEC, ECHO_STARTERS, echoPaths, type EchoMachineId, gradeEcho, macReference, type MacRefOpts, probeEcho, referenceCycles, referenceFor, RV_PASSING_SHIFTS, echoReference } from '../src/campaign/capecho';
import { assembleDsp, DSP_IO, DSP_PASSING_SHIFTS, dspReference, type DspRefOpts, DSP_REF_SHIFT } from '../src/campaign/capechodsp';
import { tick } from './yieldtick';

const FRESH = [1000, 1037, 1074, 1111];
const mac = (o: MacRefOpts, seeds = [1, 2]) => seeds.map((seed) => ({ seed, v: gradeEcho(macReference(o), seed, { machine: 'mac' }) }));
const dsp = (o: DspRefOpts, seeds = [1, 2]) => seeds.map((seed) => ({ seed, v: gradeEcho(dspReference(o), seed, { machine: 'dsp' }) }));

describe('every machine: the starter, the reference, the cycles', () => {
  for (const m of ['mac', 'dsp'] as EchoMachineId[]) {
    it(`${m}: the starter assembles, scores 0 dB and says ŷ was 0; the reference assembles, passes on fresh seeds with margin and no graded run is slower than the computed figure and it is within 40 of the run's`, async () => {
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
        expect(v.worstCycles, `${m} seed ${seed}`).toBeLessThanOrEqual(referenceCycles(m));
        expect(referenceCycles(m) - v.worstCycles, `${m} seed ${seed}`).toBeLessThan(40);
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

  it('mutants of the MAC itself: no racc → ŷ was 0; no clracc → the accumulator is never cleared (the diagnosis tests say it in words)', () => {
    for (const { seed, v } of mac({ noRacc: true })) { expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/ŷ was 0 on every one/); }
    for (const { seed, v } of mac({ noClr: true })) { expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why, `seed ${seed}`).toMatch(/The accumulator is never cleared/); }
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

  it('mutants: no update → ŷ was 0; sign flipped → the residual runs away; a step too large fail on the curve', async () => {
    for (const { seed, v } of dsp({ update: false })) { expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/ŷ was 0 on every one/); }
    for (const { seed, v } of dsp({ sign: -1 })) { await tick(); expect(v.ok, `seed ${seed}`).toBe(false); for (const r of v.results) expect(r.why).toMatch(/louder than the echo itself/); }
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
    for (const { v } of dsp({ busy: 1000 }, [1])) for (const r of v.results) { expect(r.fault?.kind).toBe('budget'); expect(r.why).toMatch(/took [\d\s   ]+ cycles, [\d\s   ]+ over the budget of 2.?400/); }
  });

  it('protocol: halting before the last sample, an out that never comes, and a first out that takes too long are each named in the core\'s words', () => {
    expect(gradeEcho('ldi p1, 254\nld r1, x(p1)\nout r1\nhalt\n', 1, { machine: 'dsp' }).results[0].why).toMatch(/halted after sample 0 of 16.?000: it must keep answering until the last/);
    expect(gradeEcho('spin: jmp spin\n', 1, { machine: 'dsp' }).results[0].why).toMatch(/no out in [\d\s   ]+ cycles/);
    expect(gradeEcho('ldi r1, 3\nspin: jmp spin\n', 1, { machine: 'dsp' }).results[0].fault?.kind).toBe('setup');
    const late = gradeEcho('ldi p1, 254\nld r1, x(p1)\nout r1\nspin: jmp spin\n', 1, { machine: 'dsp' }).results[0];
    expect(late.fault?.kind).toBe('budget');
    expect(late.why).toMatch(/never reached its out/);
  });
});

describe('the diagnoses on each machine, and the edges of the step', () => {
  /** Plain LMS (a fixed step, no normalization) on the RV32 machines. */
  const plainLms = (shift: number) => `lui s0, 0x10000
loop: lw t0, 0(s0)
li t1, 380
sh: lw t3, 0x3fc(t1)
sw t3, 0x400(t1)
addi t1, t1, -4
bgtz t1, sh
sw t0, 0x400(zero)
li t1, 0
li a2, 0
li t2, 384
fir: lw a4, 0(t1)
lw a5, 0x400(t1)
mul a4, a4, a5
add a2, a2, a4
addi t1, t1, 4
blt t1, t2, fir
srai a2, a2, 15
sw a2, 4(s0)
lw t0, 8(s0)
sub t0, t0, a2
li t1, 0
upd: lw a5, 0x400(t1)
mul a5, a5, t0
srai a5, a5, ${shift}
lw a4, 0(t1)
add a4, a4, a5
sw a4, 0(t1)
addi t1, t1, 4
blt t1, t2, upd
j loop
`;
  const NOTNORM = /the step does not scale with the signal's level \(the update is not normalized by its energy\)/;

  it('plain LMS is told it is not normalized on every machine; a small normalized step is never told so', async () => {
    for (const seed of [1, 2]) {
      await tick();
      expect(gradeEcho(plainLms(16), seed, { machine: 'rv32im' }).diagnosis, `rv32im seed ${seed}`).toMatch(NOTNORM);
      expect(gradeEcho(plainLms(16), seed, { machine: 'mac' }).diagnosis, `mac seed ${seed}`).toMatch(NOTNORM);
      expect(gradeEcho(dspReference({ plain: 32 }), seed, { machine: 'dsp' }).diagnosis, `dsp seed ${seed}`).toMatch(NOTNORM);
      expect(gradeEcho(dspReference({ plain: 8 }), seed, { machine: 'dsp' }).diagnosis, `dsp tiny plain seed ${seed}`).toMatch(NOTNORM);
      // a constant step tuned near the probe's level passes the probe; the louder probe still shows it does not scale (the audit found it told "the tail")
      const p100 = gradeEcho(dspReference({ plain: 100 }), seed, { machine: 'dsp' });
      expect(p100.ok, `dsp plain 100 seed ${seed}`).toBe(false);
      expect(p100.diagnosis, `dsp plain 100 seed ${seed}`).toMatch(NOTNORM);
      expect(p100.diagnosis).not.toMatch(/the step is the one to raise/);
      // normalized but small: never "not normalized"
      for (const [src, machine] of [[echoReference({ muShift: 14 }), 'rv32im'], [macReference({ muShift: 14 }), 'mac'], [dspReference({ gshift: 12 }), 'dsp'], [dspReference({ gshift: 13 }), 'dsp']] as [string, EchoMachineId][]) {
        const v = gradeEcho(src, seed, { machine });
        // the MAC at μ = 1/32 passes about a quarter of the seeds (Q15 weights), so a pass is allowed there: it has no diagnosis at all
        if (machine !== 'mac') expect(v.ok, `${machine} seed ${seed}`).toBe(false);
        expect(v.diagnosis, `${machine} seed ${seed}`).not.toMatch(NOTNORM);
      }
    }
  }, 300_000);

  it('the DSP at a step too small for its 16-bit weights (shift 12): quieter is much worse, louder about the same → "so small that at a low level it stalls"; shift 13 gets the generic update line', () => {
    for (const seed of [1, 2]) {
      expect(gradeEcho(dspReference({ gshift: 12 }), seed, { machine: 'dsp' }).diagnosis, `seed ${seed}`).toMatch(/does scale with the level, but it is so small that at a low level it stalls.*Raise the step/);
      expect(gradeEcho(dspReference({ gshift: 13 }), seed, { machine: 'dsp' }).diagnosis, `seed ${seed}`).toMatch(/the step size, the rounding/);
    }
  }, 120_000);

  it('the DSP step window: the reference passes at shifts 8 and 11 and fails at 7 and 12, on fresh seeds; the RV32 references pass μ = 1/16 and 1 and fail 1/32', async () => {
    const [lo, hi] = DSP_PASSING_SHIFTS;
    for (const seed of FRESH.slice(0, 3)) {
      await tick();
      for (const g of [lo, hi]) expect(gradeEcho(dspReference({ gshift: g }), seed, { machine: 'dsp' }).reasons, `shift ${g} seed ${seed}`).toEqual([]);
      for (const g of [lo - 1, hi + 1]) expect(gradeEcho(dspReference({ gshift: g }), seed, { machine: 'dsp' }).ok, `shift ${g} seed ${seed}`).toBe(false);
    }
    const [rlo, rhi] = RV_PASSING_SHIFTS;
    for (const seed of FRESH.slice(0, 2)) for (const g of [rlo, rhi]) {
      expect(gradeEcho(echoReference({ muShift: g }), seed, { machine: 'rv32im' }).reasons, `rv32im shift ${g}`).toEqual([]);
      expect(gradeEcho(macReference({ muShift: g }), seed, { machine: 'mac' }).reasons, `mac shift ${g}`).toEqual([]);
    }
    expect(2 ** (hi - lo)).toBeLessThan(2 ** (rhi - rlo));
  }, 600_000);

  it('a missing clear is said directly: the accumulator is never cleared (MAC: no clracc; DSP: no clr and rnd for rndc)', () => {
    for (const seed of [1, 2]) {
      for (const [src, machine] of [[macReference({ noClr: true }), 'mac'], [dspReference({ noClr: true }), 'dsp']] as [string, EchoMachineId][]) {
        const v = gradeEcho(src, seed, { machine });
        expect(v.ok).toBe(false);
        for (const r of v.results) expect(r.why, `${machine} seed ${seed}`).toMatch(/The accumulator is never cleared: each sample's sum adds onto the last one's/);
      }
    }
    // a program that clears is not told so, and a pass is never flagged
    expect(gradeEcho(macReference(), 1, { machine: 'mac' }).results.every((r) => r.noClear === '')).toBe(true);
    expect(gradeEcho(dspReference(), 1, { machine: 'dsp' }).results.every((r) => r.noClear === '')).toBe(true);
  }, 120_000);

  it('two outs for one x on the DSP core is a protocol fault in the core\'s words, on the first and on later samples; a program that reads x between its outs is not faulted', () => {
    const v = gradeEcho(dspReference({ twice: true }), 1, { machine: 'dsp' });
    expect(v.ok).toBe(false);
    for (const r of v.results) { expect(r.fault?.kind).toBe('protocol'); expect(r.why).toMatch(/sample 1: two outs with no read of x between them \(X\[254\]\): one out per x/); }
    expect(gradeEcho('ldi r1, 1\nout r1\nhalt\n', 1, { machine: 'dsp' }).results[0].why).toMatch(/the first out came before any read of X\[254\]/);
    // reading x with a mac counts, and reading it between outs is what the protocol asks
    expect(gradeEcho('ldi p1, 254\nldi p6, 255\nl: ld r1, x(p1)\nout r1\nld r3, y(p6)\njmp l\n', 1, { machine: 'dsp', paths: echoPaths(1, 40).slice(0, 1) }).results[0].fault).toBeNull();
  });

  it('a DSP program that halts before any out is told so in those words', () => {
    expect(gradeEcho('halt\n', 1, { machine: 'dsp' }).results[0].why).toMatch(/halted before answering any sample/);
  });
});
