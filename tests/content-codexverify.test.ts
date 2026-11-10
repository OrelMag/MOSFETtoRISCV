// Verification and test in the codex and the campaign: every number the entries, quizzes and levels print, measured; the
// test-set drill's checker against the fault simulator; t_scan's sequence against its reference.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CODEX_VERIFY } from '../src/campaign/codexverify';
import { MORE10 } from '../src/campaign/codexmore10';
import { CHECK12 } from '../src/campaign/codexcheck12';
import { blockFaults, judgeSet, parseVectors, testset, TEST_BLOCKS, vectorText } from '../src/campaign/drilltest';
import { rng } from '../src/campaign/drills';
import { scanNext, scanSeq } from '../src/campaign/buildt';
import { caseOf } from '../src/campaign/cases';
import { NODES } from '../src/campaign/nodes';
import { VERIFY_FACTS as F } from '../src/chapters/ch-verify';
import { BIST_PATTERNS, bistPatterns, bistSignature, FULL_ADDER, lfsrNext, rca, signatureOf } from '../src/lib';
import { CONSENSUS, SCAN_DFF, scanRegister } from '../src/lib/dft';
import { DFF } from '../src/lib/sequential';
import { MUX2 } from '../src/lib/gates';
import { MARCH_C_MINUS, marchCoverage, marchOps } from '../src/sim/march';
import { allVectors, detect, detectable, exactCover, faultModel, greedyCover, responses, type FaultModel } from '../src/sim/faultsim';
import { stats } from '../src/sim/stats';

const text = (id: string) => [CODEX_VERIFY.find((e) => e.id === id)!.body, JSON.stringify(MORE10[id]), JSON.stringify(CHECK12[id] ?? [])].join(' ').replace(/ /g, ' ');
const has = (id: string, s: string) => expect(text(id), `${id} should say ${s}`).toContain(s);
const model = (d: Parameters<typeof faultModel>[0]) => faultModel(d) as FaultModel;
const node = (id: string) => NODES.find((n) => n.id === id)!;

describe('verification codex numbers', () => {
  it('golden, selfcheck, fuzzing, coverage: the chapter\'s measurements', () => {
    has('golden', '7 in the gates, 14 in the model');
    has('selfcheck', `${F.sltFails.length} of the ${F.rvTests} fail, ${F.sltFails.join(' and ')}, both at case ${F.sltCase}`);
    has('selfcheck', `${F.rvTests} rv32ui tests`);
    has('selfcheck', `tohost = 9`.replace('9', String((F.sltCase << 1) | 1)));
    has('fuzzing', `${F.fuzzFails64.length} of the first 64 seeds`);
    has('fuzzing', `${F.fuzzFails64.length} fail (${F.fuzzFails64.join(', ')})`);
    has('fuzzing', `from ${F.shrinkFrom} instructions to ${F.shrinkTo}`);
    const miss = (n: number) => (1 - F.fuzzFails64.length / 64) ** n;
    expect((miss(32) * 100).toFixed(0)).toBe('22');
    expect(miss(256)).toBeLessThan(1e-4);
    has('coverage', `all ${F.primerEvents} events but uses ${F.primerInstrs} of ${F.rv32iWord} instructions`);
    has('coverage', `reach all ${F.randomInstrs}`);
    has('coverage', `${F.primerInstrs} / ${F.rv32iWord}`);
  });

  it('stuckat, faultcov, atpg: the adders and the consensus circuit', () => {
    const fa = model(FULL_ADDER), r4 = model(rca(4)), cons = model(CONSENSUS);
    expect([fa.sites.length, fa.faults.length, r4.sites.length, r4.faults.length]).toEqual([12, 24, 45, F.rcaFaults]);
    has('stuckat', '12 nets and 24 faults');
    has('stuckat', `the 4-bit ripple adder ${F.rcaFaults}`);
    const dfa = detect(fa, allVectors(fa));
    expect([greedyCover(dfa, 24).length, exactCover(dfa, 24)!.length]).toEqual([4, 3]);
    has('faultcov', '3 vectors catch all 24');
    has('faultcov', `${F.rcaRandom.join(', ')} after 1, 2, 4, 8, 16`);
    has('faultcov', `${F.rcaSmallest} of the ripple adder's ${F.rcaVectors} catch all ${F.rcaFaults}`);
    const dc = detect(cons, allVectors(cons));
    expect([cons.faults.length, detectable(dc, cons.faults.length).length]).toEqual([20, 19]);
    has('atpg', '1 of the consensus circuit\'s 20');
  });

  it('scan, lfsr, bist: costs, periods, escapes', () => {
    expect([stats(SCAN_DFF).nands, stats(DFF).nands, stats(MUX2).nands]).toEqual([15, 11, 4]);
    expect(stats(scanRegister(4)).nands).toBe(60);
    has('scan', '15 NANDs against 11');
    const added = F.pipeFlipFlops * 4;
    expect(added).toBe(10704);
    expect(((100 * added) / F.pipeNands).toFixed(1)).toBe('15.5');
    has('scan', '2 676 flip-flops and 10 704 NANDs more, 15.5 %');
    has('scan', '335 (2 676 / 8');
    expect(Math.ceil(F.pipeFlipFlops / 8)).toBe(335);
    const period = (n: number) => { let q = 1, k = 0; do { q = lfsrNext(q, n); k++; } while (q !== 1); return k; };
    expect([period(4), period(9)]).toEqual([15, 511]);
    let q = 1; const seq = [q];
    for (let i = 0; i < 15; i++) seq.push((q = lfsrNext(q, 4)));
    expect(MORE10.lfsr.example!.body).toContain(seq.map((v) => v.toString(2).padStart(4, '0')).slice(0, 8).join(' → '));
    has('lfsr', 'runs 511');
    const m = model(rca(4)), pats = bistPatterns(4, BIST_PATTERNS), good = bistSignature(4, BIST_PATTERNS), gr = responses(m, pats);
    const shown = m.faults.filter((f) => responses(m, pats, f).some((x, i) => x !== gr[i]));
    const esc = shown.filter((f) => signatureOf(responses(m, pats, f), 5) === good);
    expect([BIST_PATTERNS, shown.length, esc.length]).toEqual([32, 90, F.bistEscapes]);
    has('bist', `in ${BIST_PATTERNS} clocks; ${F.bistEscapes} of its ${F.rcaFaults} faults escapes`);
    has('bist', `89 change the signature`);
    const mc = marchCoverage(MARCH_C_MINUS, 8);
    expect(marchOps(MARCH_C_MINUS, 8)).toBe(80);
    expect(Object.values(mc).every((x) => x.found === x.total)).toBe(true);
    has('bist', '10 operations a word');
  });
});

describe('the test levels', () => {
  it('t_tests: every block\'s answer passes, a missing vector names an escaping fault, a larger set is refused', () => {
    for (const { def } of TEST_BLOCKS) {
      const b = blockFaults(def);
      const ans = parseVectors(b, b.smallest.map((v) => vectorText(b, v)).join(' '));
      expect(ans, def.id).toEqual(b.smallest);
      expect(judgeSet(b, ans as number[]), def.id).toBeUndefined();
      expect(judgeSet(b, b.smallest.slice(1)), def.id).toMatch(/escape/);
      expect(judgeSet(b, allVectors(b.m)), def.id).toMatch(/are enough/);
    }
    const r = rng(5);
    for (let i = 0; i < 40; i++) { const q = testset.make(r); expect(q.check(q.answer).ok, q.prompt).toBe(true); }
    expect(parseVectors(blockFaults(FULL_ADDER), '01')).toMatch(/3 bits/);
  });

  it('t_tests and t_scan quote the measured numbers', () => {
    expect(node('t_tests').why).toContain(`${F.rcaFaults} such faults, and ${F.rcaSmallest} of its ${F.rcaVectors} input vectors`);
    expect(caseOf('t_tests')!.cost).toContain(`${F.rcaRandom.join(', ')}`);
    expect(node('t_scan').par).toEqual({ nand: 4 * (stats(MUX2).nands + 9) });
    expect(caseOf('t_scan')!.cost).toContain('15 a bit, 60');
  });

  it('t_scan: the sequence follows the model and the directed shifts are not palindromes', () => {
    let q = 0;
    for (const s of scanSeq()) {
      q = scanNext(q, s.set!.d, s.set!.si, s.set!.se);
      expect(s.expect).toEqual({ q, so: q >> 3 });
    }
    expect(scanSeq()[4].expect.q).toBe(0b0011);
  });
});
