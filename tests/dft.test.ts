import { describe, expect, it } from 'vitest';
import {
  BIST_PATTERNS, CONSENSUS, SCAN_DFF, bistAdder, bistPatterns, bistSignature, misr, misrNext, pipelinedCpu, rca, scanCost,
  scanCounter, scanCounterNext, scanRegister, signatureOf,
} from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { simulate } from '../src/sim/harness';
import { allVectors, coverage, coverageCurve, detect, detectable, faultModel, faultName, responses, type FaultModel } from '../src/sim/faultsim';
import { stats } from '../src/sim/stats';
import { checkSpec, lcg, out, set, tick } from './util';

const model = (m: FaultModel | string): FaultModel => { if (typeof m === 'string') throw new Error(m); return m; };

describe('scan', () => {
  it('the scan flip-flop: d with se = 0, si with se = 1; 4 NANDs over the D flip-flop', () => {
    const s = simulate(SCAN_DFF);
    set(s, { d: 0, si: 0, se: 0, clk: 0 });
    for (const [d, si, se] of [[1, 0, 0], [0, 1, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
      set(s, { d, si, se }); tick(s);
      expect(out(s, 'q')).toBe(se ? si : d);
    }
    expect(stats(SCAN_DFF).nands).toBe(15);
  });

  it('the scan register shifts a word through in n clocks and loads like a register', () => {
    const s = simulate(scanRegister(4));
    set(s, { d: 0, si: 0, se: 1, clk: 0 });
    const seen: number[] = [];
    for (const b of [1, 0, 1, 1]) { set(s, { si: b }); tick(s); seen.push(out(s, 'q')); }
    expect(seen).toEqual([1, 2, 5, 11]); // bit 0 takes si, each bit the one below
    expect(out(s, 'so')).toBe(1);
    set(s, { se: 0, d: 6 }); tick(s);
    expect(out(s, 'q')).toBe(6);
  });

  it('the scan counter follows its model: shift a state in, one capture, shift the answer out', () => {
    const s = simulate(scanCounter(4)), rnd = lcg(5);
    set(s, { si: 0, se: 1, clk: 0 });
    for (let i = 0; i < 4; i++) tick(s); // clear by shifting zeros in
    let q = 0;
    for (let k = 0; k < 60; k++) {
      const se = rnd(3) ? 1 : 0, si = rnd(2);
      set(s, { se, si }); tick(s);
      q = scanCounterNext(q, 4, se, si);
      expect(out(s, 'q'), `step ${k}`).toBe(q);
      expect(out(s, 'so')).toBe(q >> 3);
    }
    // the chapter's pattern: shift 0110 in (q3 first), capture, read 0111 at so, q3 first
    for (const b of [0, 1, 1, 0]) { set(s, { se: 1, si: b }); tick(s); }
    expect(out(s, 'q')).toBe(6);
    set(s, { se: 0 }); tick(s);
    expect(out(s, 'q')).toBe(7);
    const read: number[] = [];
    for (let i = 0; i < 4; i++) { read.push(out(s, 'so')); set(s, { se: 1, si: 0 }); tick(s); }
    expect(read).toEqual([0, 1, 1, 1]);
  });

  it('full scan of the pipelined CPU: a multiplexer per flip-flop', () => {
    const c = scanCost(pipelinedCpu(assemble('j .').words));
    expect(c.flipFlops).toBe(2676);
    expect(c.nands).toBe(4 * c.flipFlops);
    expect(scanCost(scanCounter(4))).toEqual({ flipFlops: 4, nands: 16, shift: 4 });
  });
});

describe('an untestable fault', () => {
  it('the consensus circuit: its function, and its b·c term stuck at 1 is the one fault no vector finds', () => {
    checkSpec(CONSENSUS);
    const m = model(faultModel(CONSENSUS)), d = detect(m, allVectors(m));
    const missed = m.faults.map((_, i) => i).filter((i) => !detectable(d, m.faults.length).includes(i));
    expect(missed.map((i) => faultName(m, i))).toEqual(['bc stuck at 1']);
  });
});

describe('built-in self-test', () => {
  it('the MISR folds words as its model', () => {
    const s = simulate(misr(5)), rnd = lcg(9);
    set(s, { d: 0, rst: 1, clk: 0 }); tick(s);
    set(s, { rst: 0 });
    let q = 0;
    for (let k = 0; k < 40; k++) {
      const d = rnd(32);
      set(s, { d }); tick(s);
      q = misrNext(q, d, 5);
      expect(out(s, 'sig')).toBe(q);
    }
  });

  it('the self-testing adder: the gates\' signature is the model\'s, and 32 patterns cover all 90 faults', () => {
    const s = simulate(bistAdder(4));
    set(s, { rst: 1, clk: 0 }); tick(s);
    set(s, { rst: 0 });
    const pats = bistPatterns(4, BIST_PATTERNS);
    for (let k = 0; k < BIST_PATTERNS; k++) {
      expect(out(s, 'pattern')).toBe(pats[k]);
      tick(s);
      expect(out(s, 'sig'), `edge ${k + 1}`).toBe(bistSignature(4, k + 1));
    }
    const m = model(faultModel(rca(4)));
    expect(coverageCurve(m, pats, [4, 8, 16, 32])).toEqual([65, 73, 87, 90]);
    expect(coverage(m, pats).detected).toBe(90);
    // every detected fault changes the signature unless it aliases: count them (the chapter quotes the number)
    const good = signatureOf(responses(m, pats), 5);
    const aliased = m.faults.filter((f) => responses(m, pats, f).some((r, i) => r !== responses(m, pats)[i]) && signatureOf(responses(m, pats, f), 5) === good);
    expect(good).toBe(19);
    expect(aliased).toHaveLength(1); // one of 90 escapes a 5-bit signature (odds about 1 in 32 each)
  });
});
