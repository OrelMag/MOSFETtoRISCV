// Appendix E: the Baby's golden model on Kilburn's routine (the sources' "about 2.1 million instructions"), and the
// gate-level machine in lock step with it, beat by beat; the Williams tube's leak with regeneration off.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { babyComputer, BABY_ACC, BABY_CONTROL, BABY_DECODE, BABY_TIMING, BEAT_US, HOLD_BEATS, isTubeState, REFRESH_BEATS } from '../src/lib/baby';
import { ssemWords, assembleSsem } from '../src/ssem/asm';
import { disasm, encode, FN, lsbFirst, notebook } from '../src/ssem/isa';
import { SsemISS } from '../src/ssem/iss';
import { kilburnSource, KILBURN_ANSWER_LINE } from '../src/ssem/programs';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { Sim } from '../src/sim/sim';
import { stats } from '../src/sim/stats';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

describe('the golden model', () => {
  it('runs Kilburn\'s routine on 2^18: 2 097 154 instructions, 131 072 in line 27', () => {
    const iss = new SsemISS(ssemWords(kilburnSource()));
    iss.run();
    expect(iss.halted).toBe(true);
    expect(iss.store[KILBURN_ANSWER_LINE]).toBe(131072);
    expect(iss.instrs).toBe(2_097_154);
    expect(iss.accesses).toBe(3_801_090);
    expect(iss.ci & 31).toBe(13); // the Stop on line 13
  });

  it('assembles the notebook line for line (digits 0–4, 13–15 least significant first)', () => {
    const r = assembleSsem(kilburnSource());
    expect(r.errors).toEqual([]);
    const w = r.words;
    // the notebook's own binary columns
    expect([lsbFirst(w[1] & 31, 5), lsbFirst((w[1] >>> 13) & 7, 3)]).toEqual(['00011', '010']); // -24 to C
    expect([lsbFirst(w[8] & 31, 5), lsbFirst((w[8] >>> 13) & 7, 3)]).toEqual(['00101', '100']); // Add 20 to Cl
    expect([lsbFirst(w[16] & 31, 5), lsbFirst((w[16] >>> 13) & 7, 3)]).toEqual(['11011', '110']); // c to 27
    expect(lsbFirst((w[13] >>> 13) & 7, 3)).toBe('111');
    expect(w[20]).toBe(-3);
    expect(notebook(2, 24)).toBe('−24 to C');
    expect(disasm(encode(FN.JRP, 20))).toBe('JRP 20');
  });

  it('a prime has 1 as its highest factor', () => {
    const iss = new SsemISS(ssemWords(kilburnSource(97)));
    iss.run();
    expect(iss.store[27]).toBe(1);
  });
});

const read = (sim: Sim, port: string) => pack(sim.getBits(sim.design.root.ports[port]));

function boot(words: number[], regen = 1, fast = false): Sim {
  const d = flatten(babyComputer(words));
  const sim: Sim = fast ? new DualSim(d) : new GateSim(d);
  if (fast) (sim as DualSim).preferFast = true;
  sim.reset('zero');
  sim.setInput('clk', 0);
  sim.setInput('regen', regen);
  sim.settle();
  return sim;
}

function edge(sim: Sim): void {
  sim.setInput('clk', 1); sim.settle();
  sim.setInput('clk', 0); sim.settle();
}

/** Beats until the stop lamp, comparing every finished instruction with the golden model. */
async function lockStep(sim: Sim, iss: SsemISS, maxBeats: number): Promise<number> {
  let beats = 0;
  while (beats < maxBeats) {
    const retiring = read(sim, 'retire') === 1;
    edge(sim);
    beats++;
    if (retiring) {
      iss.step();
      // CMP's skip: the hardware keeps it in T and adds it at the next S1
      expect(((read(sim, 'ci') + read(sim, 't')) | 0) >>> 0).toBe(iss.ci >>> 0);
      expect(read(sim, 'a')).toBe(iss.a >>> 0);
      expect(read(sim, 'stop')).toBe(iss.halted ? 1 : 0);
      if (iss.halted) return beats;
    }
    if (beats % 2000 === 0) await tick();
  }
  throw new Error(`no stop in ${maxBeats} beats`);
}

describe('the Baby in gates', () => {
  it('runs Kilburn\'s routine on 60 in lock step: four beats an instruction, 30 in line 27', async () => {
    const words = ssemWords(kilburnSource(60));
    const sim = boot(words), iss = new SsemISS(words);
    const beats = await lockStep(sim, iss, 20000);
    expect(beats).toBe(4 * iss.instrs);
    expect(iss.store[27]).toBe(30);
    // the stopped machine keeps beating and regenerating; nothing else moves
    const a = read(sim, 'a'), ci = read(sim, 'ci');
    for (let i = 0; i < 300; i++) edge(sim);
    expect([read(sim, 'a'), read(sim, 'ci'), read(sim, 'stop')]).toEqual([a, ci, 1]);
  });

  it('runs on the cycle engine too (a prime: 1)', async () => {
    const words = ssemWords(kilburnSource(13));
    const sim = boot(words, 1, true), iss = new SsemISS(words);
    await lockStep(sim, iss, 20000);
    expect((sim as DualSim).engine).toBe('cycle');
    expect(iss.store[27]).toBe(1);
  });

  it('without regeneration the tube forgets: a long run goes wrong', async () => {
    const words = ssemWords(kilburnSource(1000));
    const sim = boot(words, 0), iss = new SsemISS(words);
    await expect(lockStep(sim, iss, 40 * HOLD_BEATS)).rejects.toThrow();
  });

  it('keeps every line fresh with regeneration on: no line older than the refresh period', () => {
    const words = ssemWords(kilburnSource(60));
    const sim = boot(words);
    const li = sim.design.leaves.findIndex((l) => isTubeState(sim.leafState(sim.design.leaves.indexOf(l))));
    let worst = 0;
    for (let i = 0; i < 1000; i++) {
      edge(sim);
      const s = sim.leafState(li);
      if (isTubeState(s)) worst = Math.max(worst, ...s.age);
    }
    expect(worst).toBeLessThanOrEqual(REFRESH_BEATS);
    // the sources' numbers: a 306 µs beat, 0.2 s of charge = 654 beats, the store every 16 instructions = 19.6 ms
    expect([BEAT_US, HOLD_BEATS, REFRESH_BEATS / 4, +(REFRESH_BEATS * BEAT_US / 1000).toFixed(1)]).toEqual([306, 654, 16, 19.6]);
  });

  it('costs (NANDs per block, the whole machine with its 1024-digit store)', () => {
    const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
    expect({ timing: n(BABY_TIMING), decode: n(BABY_DECODE), control: n(BABY_CONTROL), acc: n(BABY_ACC), all: n(babyComputer([])) })
      .toEqual({ timing: 151, decode: 57, control: 1036, acc: 1068, all: 22697 });
  });
});
