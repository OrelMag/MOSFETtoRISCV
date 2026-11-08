// The echo-canceller capstone: the bench injects echo paths from a seed the learner never sees and holds back what it grades. The reference passes with
// margin under every seed, reasonable designs pass whatever the seed and hopeless ones fail whatever the seed, and each wrong program fails for the
// reason it should (and says so). The 60-seed sweeps behind the edges are in the commit message; these tests pin them on a few seeds each.

import { describe, expect, it } from 'vitest';
import { assembleEcho, probeEcho, BLOCK, ECHO_MACHINES, ECHO_SPEC, ECHO_STARTER, echoPaths, echoReference, gradeEcho, REF_Q, REF_TAPS, referenceCycles, type RefOpts } from '../src/campaign/capecho';
import { capstoneById } from '../src/campaign/capstone';
import { erleDb, Lms } from '../src/dsp/adaptive';
import { DSP_CAPSTONES } from '../src/learn/capstones';
import { tick } from './yieldtick';

const SEEDS = [1, 2, 3, 77];
const MORE = [5, 9, 12, 404, 31337, 2718];
const FRESH = [1000, 1037, 1074, 1111, 1148, 1185];
const ref = echoReference();
const prog = (body: string) => `lui s0, 0x10000\nloop: lw t0, 0(s0)\n${body}\nj loop\n`;

describe('the echo capstone', () => {
  it('is routed on My path in the DSP group, and the other groups are as they were', () => {
    expect(DSP_CAPSTONES.find((x) => x.id === 'cap_echo')!.route).toBe('#/campaign/play/cap_echo');
    expect(DSP_CAPSTONES.map((x) => x.id)).toContain('cap_tune');
    expect(capstoneById('cap_echo')?.title).toBe('An echo canceller');
  });

  it('offers RV32IM, RV32 + MAC and the DSP core, all graded (tests/capstone-echo-machines.test.ts)', () => {
    expect(ECHO_MACHINES.map((m) => [m.id, m.ready])).toEqual([['rv32im', true], ['mac', true], ['dsp', true]]);
  });

  it('draws four paths from the seed: one short, two medium, one long (96 taps) tail, of different gains, and different ones for other seeds', () => {
    const a = echoPaths(1), b = echoPaths(2);
    expect(a.map((p) => p.cls).sort()).toEqual(['long', 'medium', 'medium', 'short']);
    expect(a.find((p) => p.cls === 'long')!.taps).toBe(ECHO_SPEC.maxTaps);
    expect(echoPaths(1).map((p) => `${p.taps}:${p.erlDb}:${p.d[777]}`)).toEqual(a.map((p) => `${p.taps}:${p.erlDb}:${p.d[777]}`));
    expect(a.map((p) => `${p.taps}:${p.erlDb.toFixed(2)}`)).not.toEqual(b.map((p) => `${p.taps}:${p.erlDb.toFixed(2)}`));
    for (const p of [...a, ...b]) {
      expect(p.erlDb).toBeGreaterThanOrEqual(6);
      expect(p.erlDb).toBeLessThanOrEqual(16);
      expect(p.taps).toBeLessThanOrEqual(ECHO_SPEC.maxTaps);
      expect(p.x.length).toBe(ECHO_SPEC.samples);
    }
    expect(new Set([...a, ...b].map((p) => p.taps)).size).toBeGreaterThan(4);
    expect(a.map((p) => p.source).sort()).toEqual(['noise', 'noise', 'speech', 'speech']);
  });

  it('the microphone is the echo plus noise, and the echo is what the far end made through the path', () => {
    for (const p of echoPaths(3)) {
      let noise = 0;
      for (let i = 0; i < p.d.length; i++) noise += (p.d[i] - p.echo[i]) ** 2;
      expect(Math.sqrt(noise / p.d.length)).toBeGreaterThan(ECHO_SPEC.noiseLsb * 0.8);
      expect(Math.sqrt(noise / p.d.length)).toBeLessThan(ECHO_SPEC.noiseLsb * 1.2);
      for (let i = 0; i < p.delay; i++) expect(p.echo[i]).toBe(0);
    }
  });

  it('the numbers the page types are the program\'s and the bench\'s: taps, Q format, cycles, block size', () => {
    expect(ref).toContain(`li    a3, ${REF_TAPS}`);
    expect(ref).toContain(`${REF_TAPS} taps, weights in Q${REF_Q}`);
    expect(ref).toContain(`srai  a2, a2, ${REF_Q}`);
    expect(REF_TAPS).toBe(ECHO_SPEC.maxTaps);
    expect(referenceCycles()).toBe(gradeEcho(ref, 2).worstCycles);
    expect(ECHO_SPEC.samples % BLOCK).toBe(0);
    expect(ECHO_SPEC.window % BLOCK).toBe(0);
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
  }, 300_000);

  it('the starter (ŷ = 0) scores 0 dB, and the message is from the values written', () => {
    const v = gradeEcho(ECHO_STARTER, 4);
    expect(v.ok).toBe(false);
    for (const r of v.results) { expect(r.erle).toBeCloseTo(0, 1); expect(r.nonzero).toBe(0); expect(r.why).toMatch(/ŷ was 0 on every one of the 16.?000 samples/); }
  });

  it('the cycle budget is a hard edge: 400 idle cycles still pass, 600 do not, and the message says by how much', () => {
    const ok = gradeEcho(echoReference({ busy: 200 }), 2);
    expect(ok.ok).toBe(true);
    expect(ok.worstCycles).toBeLessThanOrEqual(ECHO_SPEC.budget);
    const over = gradeEcho(echoReference({ busy: 300 }), 2);
    expect(over.ok).toBe(false);
    for (const r of over.results) {
      expect(r.fault?.kind).toBe('budget');
      const m = /took (\d[\d   ]*) cycles, (\d[\d   ]*) over the budget of 2.?400/.exec(r.why)!;
      expect(m).toBeTruthy();
      expect(Number(m[1].replace(/\D/g, '')) - Number(m[2].replace(/\D/g, ''))).toBe(ECHO_SPEC.budget);
    }
  });

  it('a program that never reads x again is stopped, and one that stops early at a jump to itself is told so', () => {
    const spin = gradeEcho('lui s0, 0x10000\nlw t0, 0(s0)\nsw zero, 4(s0)\nspin: j spin\n', 2);
    expect(spin.ok).toBe(false);
    expect(spin.reasons[0]).toMatch(/stopped|never reached the next x/);
    const slow = gradeEcho('lui s0, 0x10000\nlw t0, 0(s0)\nsw zero, 4(s0)\nli t1, 1\nl: addi t1, t1, 1\nj l\n', 2);
    expect(slow.reasons[0]).toMatch(/never reached the next x|budget/);
    const halt = (n: number) => `lui s0, 0x10000\nli s1, ${n}\nloop: lw t0, 0(s0)\nsw zero, 4(s0)\nlw t1, 8(s0)\naddi s1, s1, -1\nbnez s1, loop\ndone: j done\n`;
    const early = gradeEcho(halt(100), 2);
    expect(early.results[0].fault?.kind).toBe('protocol');
    expect(early.results[0].why).toMatch(/stopped \(a jump to itself\) after sample 99 of 16.?000/);
  });

  it('a program that answers all the samples and then halts is accepted: it fails only on what it did, not on stopping', () => {
    const v = gradeEcho(`lui s0, 0x10000\nli s1, ${ECHO_SPEC.samples}\nloop: lw t0, 0(s0)\nsw zero, 4(s0)\nlw t1, 8(s0)\naddi s1, s1, -1\nbnez s1, loop\ndone: j done\n`, 2);
    for (const r of v.results) { expect(r.fault).toBeNull(); expect(r.answered).toBe(ECHO_SPEC.samples); expect(r.why).toMatch(/ŷ was 0/); }
    // and the reference followed by a halt after the last sample still passes
    const limited = ref.replace('        j     loop\n', '        addi  s7, s7, 1\n        li    s8, 16000\n        blt   s7, s8, loop\ndone:   j     done\n');
    expect(limited).not.toBe(ref);
    expect(ECHO_SPEC.samples).toBe(16000);
    const w = gradeEcho(limited, 3);
    expect(w.reasons).toEqual([]);
  }, 60_000);

  // ---- the machine's edges: no aliasing, whole words only at the port ----

  it('RAM does not alias: stores or loads outside 0 … 0x3fff, and port addresses past +8, are faults with the address', () => {
    const cases: [string, RegExp][] = [
      ['lui t1, 4\nsw t0, 0(t1)\nsw zero, 4(s0)\nlw t2, 8(s0)', /store at 0x4000 \(sample 0\): outside the RAM \(0 … 0x3fff\)/],
      ['lui t1, 0x20000\nsw t0, 0(t1)\nsw zero, 4(s0)', /store at 0x20000000/],
      ['lui t1, 0x40000\nlw t2, 0(t1)\nsw zero, 4(s0)', /load at 0x40000000/],
      ['sw zero, 12(s0)', /store at 0x1000000c/],
      ['lw t2, 4(s0)\nsw zero, 4(s0)', /load at 0x10000004/],
    ];
    for (const [body, re] of cases) {
      const v = gradeEcho(prog(body), 2);
      expect(v.ok).toBe(false);
      for (const r of v.results) { expect(r.fault?.kind).toBe('memory'); expect(r.why).toMatch(re); }
    }
    // the last RAM word is fine
    const edge = gradeEcho(prog('li t1, 0x3ffc\nsw t0, 0(t1)\nsw zero, 4(s0)\nlw t2, 8(s0)'), 2);
    for (const r of edge.results) expect(r.fault).toBeNull();
  });

  it('the port takes whole words: sb or sh to ŷ and lb, lh, lbu from x are refused with a message', () => {
    for (const [body, re] of [['sb t0, 4(s0)', /sb to ŷ: the port takes whole words/], ['sh t0, 4(s0)', /sh to ŷ/], ['lb t1, 0(s0)\nsw zero, 4(s0)', /lb from the sample port/], ['lh t1, 0(s0)\nsw zero, 4(s0)', /lh from the sample port/]] as [string, RegExp][]) {
      const v = gradeEcho(prog(body).replace('lw t0, 0(s0)\n', body.startsWith('l') ? '' : 'lw t0, 0(s0)\n'), 2);
      expect(v.ok).toBe(false);
      for (const r of v.results) { expect(r.fault?.kind).toBe('memory'); expect(r.why).toMatch(re); }
    }
  });

  // ---- the diagnoses say what the curve shows, and only that ----

  it('a constant ŷ is wrong from the start (not "ran away"), and the message does not blame the sign alone', () => {
    const v = gradeEcho(prog('li t1, 1000\nsw t1, 4(s0)\nlw t2, 8(s0)'), 2);
    expect(v.ok).toBe(false);
    for (const r of v.results.filter((x) => x.erle < -3)) expect(r.why).toMatch(/louder than the echo itself\. It was wrong from the start and stayed so.*not an estimate of the echo/);
  });

  it('ŷ = last sample\'s d (a microphone copy, a sample late) cannot pass, and is not called a weight problem', () => {
    const v = gradeEcho('lui s0, 0x10000\nli s1, 0\nl: lw t0, 0(s0)\nsw s1, 4(s0)\nlw s1, 8(s0)\nj l\n', 3);
    expect(v.ok).toBe(false);
    for (const r of v.results) { expect(r.erle).toBeLessThan(5); expect(r.why).not.toMatch(/ŷ was 0 on every/); }
  });

  // ---- stability: a reasonable design passes whatever the seed, a hopeless one fails whatever the seed ----

  const verdicts = (o: RefOpts, seeds = SEEDS) => seeds.map((seed) => ({ seed, v: gradeEcho(echoReference(o), seed) }));

  it('stable passes: μ from 1/16 to 1, on 96 taps, pass on fresh seeds with margin', async () => {
    for (const muShift of [15, 16, 17, 19]) for (const { seed, v } of verdicts({ muShift }, FRESH.slice(0, 3))) {
      await tick();
      expect(v.reasons, `μ shift ${muShift} seed ${seed}`).toEqual([]);
      expect(v.minErle, `μ shift ${muShift} seed ${seed}`).toBeGreaterThan(ECHO_SPEC.erleDb + 1);
    }
  }, 300_000);

  it('stable failures: μ of 1/32 or less fails every seed, as do 80 taps and fewer on the 96-tap tail', async () => {
    for (const o of [{ muShift: 14 }, { taps: 80 }, { taps: 64 }, { taps: 32 }] as RefOpts[]) for (const { seed, v } of verdicts(o, FRESH.slice(0, 4))) {
      await tick();
      expect(v.ok, `${JSON.stringify(o)} seed ${seed}`).toBe(false);
      for (const r of v.results.filter((x) => !x.pass)) expect(r.fault).toBeNull();
    }
    // the long path is the one that fails for want of taps, and the short path still passes
    for (const { seed, v } of verdicts({ taps: 32 })) {
      const long = v.results.find((r) => r.path.cls === 'long')!, short = v.results.find((r) => r.path.cls === 'short')!;
      expect(long.pass, `seed ${seed}`).toBe(false);
      expect(long.erle, `seed ${seed}`).toBeLessThan(ECHO_SPEC.erleDb - 5);
      expect(long.why).toMatch(/ERLE [-\d.]+ dB over the last 4.?000 samples, 25.0 dB needed/);
      expect(short.pass, `seed ${seed}`).toBe(true);
    }
  }, 300_000);

  // ---- the mutants: each fails for its stated reason, on every path or the paths it should, under several seeds ----

  it('mutant: no weight update → ŷ was 0 on every sample, 0 dB on every path', async () => {
    for (const { seed, v } of verdicts({ update: false })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      expect(v.results.every((r) => /ŷ was 0 on every one/.test(r.why) && Math.abs(r.erle) < 0.1), `seed ${seed}`).toBe(true);
    }
  }, 120_000);

  it('mutant: the update\'s sign flipped → residual louder than the echo, getting worse, on every path', async () => {
    for (const { seed, v } of verdicts({ sign: -1 })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      for (const r of v.results) { expect(r.why, `seed ${seed}`).toMatch(/louder than the echo itself\. It ran away/); expect(r.erle).toBeLessThan(-10); }
    }
  }, 120_000);

  it('mutant: μ too large (4) → runaway on every path', async () => {
    for (const { seed, v } of verdicts({ muShift: 21 })) {
      await tick();
      expect(v.ok, `seed ${seed}`).toBe(false);
      for (const r of v.results) expect(r.why, `seed ${seed}`).toMatch(/It ran away.*the update's sign is wrong or the step is too large/);
      expect(v.diagnosis).toBe('');
    }
  }, 120_000);

  // The curve alone cannot tell these faults apart, so a message never guesses: the path's line says what the curve shows, and the diagnosis is the result of
  // running the program again on two paths the bench controls (a 16-tap tail, steady noise, the usual level and 20 dB quieter).
  const curve = /ERLE [-\d.]+ dB over the last 4.?000 samples, 25.0 dB needed\. (It was still rising: [-\d.]+ dB over the first blocks of the graded stretch, [-\d.]+ dB over the last\.|It had levelled off there, within [\d.]+ dB from block to block\.)$/;

  it('the path lines say only what the curve shows: no cause, no "step too small", no jitter hint', async () => {
    for (const o of [{ muShift: 20 }, { muShift: 14 }, { truncate: true }, { taps: 64 }] as RefOpts[]) for (const { seed, v } of verdicts(o, [1, 2])) {
      await tick();
      for (const r of v.results.filter((x) => !x.pass && x.erle >= -3)) { expect(r.why, `${JSON.stringify(o)} seed ${seed}`).toMatch(curve); expect(r.why).not.toMatch(/too small|too large|jitter|rounds away|truncat|too few taps/); }
    }
  }, 120_000);

  it('the probes: the reference reaches 35 dB or more on both, and a verdict that passes has no diagnosis', () => {
    const w = assembleEcho(ref).words, p = probeEcho(w);
    expect(p.loud).toBeGreaterThan(35);
    expect(p.quiet).toBeGreaterThan(30);
    expect(gradeEcho(ref, 2).diagnosis).toBe('');
  });

  it('diagnosis: μ of 2 → falls short on the probe, and better when quieter: "the step is too large at the usual level"', async () => {
    for (const { seed, v } of verdicts({ muShift: 20 }, [1, 2, 3])) {
      await tick();
      expect(v.ok).toBe(false);
      expect(v.diagnosis, `seed ${seed}`).toMatch(/falls short even there.*does better when the signal is quieter: the step is too large at the usual level/);
    }
  }, 120_000);

  it('diagnosis: μ of 1/32 and a truncating update → the fault is in the update, not the tail, and neither is named for what the probe cannot show', async () => {
    for (const o of [{ muShift: 14 }, { truncate: true }] as RefOpts[]) for (const { seed, v } of verdicts(o, [1, 2])) {
      await tick();
      expect(v.diagnosis, `${JSON.stringify(o)} seed ${seed}`).toMatch(/falls short even there, so the fault is in what the program computes from x and d, not the tail length: the step size, the rounding \(a truncating update biases the weights\), or a ŷ that is not the filter's output/);
      expect(v.diagnosis).not.toMatch(/normalized|too large|a tail up to/);
    }
  }, 120_000);

  it('diagnosis: too few taps (80, 64) → the update works on the probe, and the tail is named as what the path adds', async () => {
    for (const taps of [80, 64]) for (const { seed, v } of verdicts({ taps }, [1, 2, 3])) {
      await tick();
      expect(v.ok).toBe(false);
      expect(v.diagnosis, `${taps} taps seed ${seed}`).toMatch(/So the update works there\. What the failing paths? adds? is a tail up to \d+ taps/);
      expect(v.diagnosis).toMatch(/fewer taps than that tail.*a step too small/);
      expect(v.diagnosis).not.toMatch(/falls short/);
    }
  }, 120_000);

  it('diagnosis: 96 taps with a step of 5/128 also passes the probe, so the step is named beside the taps (the audit found it told "the tail")', async () => {
    const src = ref.replace('        slli  t0, t0, 18', '        slli  t0, t0, 12\n        li    t6, 5\n        mul   t0, t0, t6');
    expect(src).not.toBe(ref);
    for (const seed of [1, 2]) {
      await tick();
      const v = gradeEcho(src, seed);
      expect(v.ok, `seed ${seed}`).toBe(false);
      expect(v.diagnosis, `seed ${seed}`).toMatch(/a step too small still finishes a short tail but not a long one within the run\. If your filter covers 96 taps, the step is the one to raise/);
    }
  }, 120_000);

  /** Plain LMS (no normalization): the step is a fixed shift, so it scales with the signal's energy. */
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

  it('diagnosis: plain LMS (fixed step, no normalization) → much worse when quieter: "the step does not scale with the signal\'s level"', async () => {
    for (const { seed, v } of [1, 2].map((seed) => ({ seed, v: gradeEcho(plainLms(16), seed) }))) {
      await tick();
      expect(v.ok).toBe(false);
      expect(v.diagnosis, `seed ${seed}`).toMatch(/and the answer changes with the level \(-?[\d.]+ dB quieter, -?[\d.]+ dB louder\): the step does not scale with the signal's level \(the update is not normalized by its energy\)/);
    }
  }, 120_000);

  it('a ŷ that is last sample\'s d is never blamed on the tail or on normalization', () => {
    const v = gradeEcho('lui s0, 0x10000\nli s1, 0\nl: lw t0, 0(s0)\nsw s1, 4(s0)\nlw s1, 8(s0)\nj l\n', 2);
    expect(v.ok).toBe(false);
    expect(v.diagnosis).not.toMatch(/a tail up to|normalized|too large/);
    for (const r of v.results) expect(r.why).not.toMatch(/too small|too large|jitter|too few taps/);
  });

  it('the page\'s level claim holds: speech about −27 to −30 dBFS rms with peaks near −13, white noise −26 dBFS rms', () => {
    const db = (x: Int32Array) => 20 * Math.log10(Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) / 32768);
    for (const seed of [1, 2, 3, 77, 5, 9]) for (const p of echoPaths(seed)) {
      const peak = 20 * Math.log10(p.x.reduce((m, v) => Math.max(m, Math.abs(v)), 0) / 32768);
      if (p.source === 'speech') { expect(db(p.x)).toBeGreaterThan(-30.5); expect(db(p.x)).toBeLessThan(-26.5); } else { expect(db(p.x)).toBeGreaterThan(-26.5); expect(db(p.x)).toBeLessThan(-25.5); }
      expect(peak).toBeGreaterThan(-15);
      expect(peak).toBeLessThan(-12);
    }
  });

  it('mutant: over the cycle budget → every path stops on the budget with its overshoot, before any ERLE counts', () => {
    for (const { seed, v } of verdicts({ busy: 300 }, [1, 2, 3])) {
      expect(v.ok, `seed ${seed}`).toBe(false);
      for (const r of v.results) { expect(r.fault?.kind).toBe('budget'); expect(r.why).toMatch(/over the budget of 2.?400/); }
    }
  });

  it('mutants of the protocol: two ŷ per x, a skipped ŷ, and reading the microphone first (or before any x) are each named', () => {
    for (const seed of [1, 2]) {
      expect(gradeEcho(echoReference({ twice: true }), seed).reasons[0], `seed ${seed}`).toMatch(/ŷ written twice/);
      expect(gradeEcho(echoReference({ skipY: true }), seed).reasons[0], `seed ${seed}`).toMatch(/no ŷ was written for this one/);
      expect(gradeEcho(echoReference({ peek: true }), seed).reasons[0], `seed ${seed}`).toMatch(/microphone was read before ŷ/);
    }
    expect(gradeEcho('lui s0, 0x10000\nlw t0, 8(s0)\n', 1).reasons[0]).toMatch(/d read before any x/);
  });
});
