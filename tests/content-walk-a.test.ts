// The walkthroughs and cases of acts 0–7 (walks, walks1, walks2, cases0, cases1) quote numbers their reference
// circuits must keep: each is measured here and looked up in the text that quotes it, so an edit to either fails.
// Also: the prime detector and the 3→8 decoder references are the cheapest known, and the prime detector's are
// proved minimal by exhaustive search.

import { describe, expect, it } from 'vitest';
import { caseOf } from '../src/campaign/cases';
import { NUDGES } from '../src/campaign/nudges';
import { nodeById } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { stepMetrics, walkOf } from '../src/campaign/walk';
import { andN } from '../src/lib/combinational';
import { NOT } from '../src/lib/gates';
import { DEC3, MUX16, PRIME4, PRIMES4, RV16_REG16 } from '../src/lib/rv16/logic';
import { LANEDEC16, VRF16, rv16Lanes } from '../src/lib/rv16/lanes16';
import { EDGE16, RASTER16 } from '../src/lib/rv16/raster16';
import { RV16_WARPS } from '../src/lib/rv16/warps16';
import { resolveComponent } from '../src/lib/resolve';
import { copiesIn } from '../src/lib/usage';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';

const nands = (d: ComponentDef) => stats(d).nands;
const lib = (id: string) => resolveComponent(id)!;
/** A number as the texts write it: 12 038, or 12038 in code-like spots. */
const spelled = (n: number) => [String(n), n >= 1000 ? `${Math.floor(n / 1000)} ${String(n % 1000).padStart(3, '0')}` : String(n)];
const quotes = (text: string, n: number) => spelled(n).some((s) => new RegExp(`(?<!\\d)(?<!\\d )${s}(?!\\d)(?! \\d{3})`).test(text));
const node = (id: string) => nodeById(id)!;
const walk = (id: string) => walkOf(node(id))!;
const step = (id: string, title: string) => {
  const w = walk(id), k = w.steps.findIndex((s) => s.title === title);
  expect(k, `${id}: step '${title}'`).toBeGreaterThanOrEqual(0);
  return { w, k, text: w.steps[k].text };
};
const metric = (id: string, k: number) => stepMetrics(walk(id), k, levelChallenge(node(id))!);
const finalNand = (id: string) => metric(id, walk(id).steps.length - 1).nand;
const walkText = (id: string) => walk(id).steps.map((s) => s.text).join(' ');
const cost = (id: string) => caseOf(id)!.cost!;

// ---- exhaustive search over 2-input NAND circuits of the four inputs a0..a3 -------------------------------
const IN = [0xaaaa, 0xcccc, 0xf0f0, 0xff00];
const M = 0xffff;
/** Is there a circuit of exactly G NANDs computing target? (Gates in a canonical order: each uses its predecessor or has a larger input pair.) */
function circuitOf(target: number, G: number): boolean {
  const f = new Int32Array(4 + G), nt = ~target & M;
  for (let i = 0; i < 4; i++) f[i] = IN[i];
  const rec = (n: number, lastKey: number): boolean => {
    if (n - 4 === G - 1) {
      for (let q = 0; q < n; q++) {
        if ((f[q] & nt) !== nt) continue;
        for (let p = 0; p <= q; p++) if ((f[p] & f[q]) === nt) return true;
      }
      return false;
    }
    for (let q = 0; q < n; q++) for (let p = 0; p <= q; p++) {
      const key = q * 64 + p;
      if (q !== n - 1 && p !== n - 1 && key <= lastKey) continue;
      const v = ~(f[p] & f[q]) & M;
      if (v === 0 || v === M || v === target) continue;
      let dup = false;
      for (let i = 0; i < n && !dup; i++) dup = f[i] === v;
      if (dup) continue;
      f[n] = v;
      if (rec(n + 1, key)) return true;
    }
    return false;
  };
  return G === 1 ? IN.some((x) => IN.some((y) => (~(x & y) & M) === target)) : rec(4, -1);
}
/** Every function of a0..a3 that 2-input NANDs reach within d levels. */
function reachable(d: number): Set<number> {
  let s = new Set(IN);
  for (let k = 0; k < d; k++) {
    const a = [...s], n = new Set(s);
    for (const x of a) for (const y of a) n.add(~(x & y) & M);
    s = n;
  }
  return s;
}
const PRIME_TABLE = PRIMES4.reduce((t, p) => t | (1 << p), 0);

describe('g_sop: the prime detector', () => {
  it('is 8 NANDs, depth 5, and both are the minimum', () => {
    expect([nands(PRIME4), logicDepth(PRIME4)]).toEqual([8, 5]);
    for (let G = 1; G <= 7; G++) expect(circuitOf(PRIME_TABLE, G), `${G} NANDs`).toBe(false);
    expect(circuitOf(PRIME_TABLE, 8)).toBe(true);
    expect(reachable(4).has(PRIME_TABLE)).toBe(false);
    expect(reachable(5).has(PRIME_TABLE)).toBe(true);
    expect(node('g_sop').par).toEqual({ nand: 8, depth: 5 });
  });

  it('the alternatives its texts quote: SoP 20 / depth 7, shared pairs 16 / depth 7, with three essential primes and a choice for 7', () => {
    // A tiny NAND netlist evaluator: gates as [a, b] signal indices after the four inputs.
    const run = (gates: [number, number][], out: number) => {
      let t = 0;
      for (let r = 0; r < 16; r++) {
        const v = [r & 1, (r >> 1) & 1, (r >> 2) & 1, (r >> 3) & 1];
        for (const [a, b] of gates) v.push(1 - (v[a] & v[b]));
        t |= v[out] << r;
      }
      return t;
    };
    const depth = (gates: [number, number][], out: number) => {
      const d = [0, 0, 0, 0];
      for (const [a, b] of gates) d.push(1 + Math.max(d[a], d[b]));
      return d[out];
    };
    // inputs 0..3 = a0..a3; 4 ¬a3, 5 ¬a2, 6 ¬a1
    const sop: [number, number][] = [[3, 3], [2, 2], [1, 1],
      [4, 5], [7, 7], [4, 2], [9, 9], [5, 1], [11, 11], [2, 6], [13, 13], // pairs: ¬a3¬a2, ¬a3a2, ¬a2a1, a2¬a1 (AND = NAND, NOT)
      [8, 1], [10, 0], [12, 0], [14, 0], // the inverted products
      [15, 16], [19, 19], [17, 18], [21, 21], [20, 22]]; // AND, AND, NAND
    expect([sop.length, depth(sop, 23), run(sop, 23)]).toEqual([20, 7, PRIME_TABLE]);
    const shared: [number, number][] = [[3, 3], [2, 2], [1, 1],
      [5, 1], [7, 7], [2, 0], [9, 9], // p = ¬a2·a1, q = a2·a0
      [8, 4], [8, 0], [10, 4], [10, 6], // (p·¬a3)', (p·a0)', (q·¬a3)', (q·¬a1)'
      [11, 12], [15, 15], [13, 14], [17, 17], [16, 18]];
    expect([shared.length, depth(shared, 19), run(shared, 19)]).toEqual([16, 7, PRIME_TABLE]);
    // Three essential primes (each the only cover of one of its minterms) and two equal choices for 7.
    const term = (care: number, val: number) => Array.from({ length: 16 }, (_, r) => r).filter((r) => (r & care) === val);
    const primes = { '¬a3¬a2a1': term(0b1110, 0b0010), '¬a2a1a0': term(0b0111, 0b0011), 'a2¬a1a0': term(0b0111, 0b0101), '¬a3a2a0': term(0b1101, 0b0101), '¬a3a1a0': term(0b1011, 0b0011) };
    for (const cells of Object.values(primes)) for (const r of cells) expect(PRIMES4).toContain(r);
    const covers = (r: number) => Object.entries(primes).filter(([, c]) => c.includes(r)).map(([k]) => k);
    expect(covers(2)).toEqual(['¬a3¬a2a1']);
    expect(covers(11)).toEqual(['¬a2a1a0']);
    expect(covers(13)).toEqual(['a2¬a1a0']);
    expect(covers(7)).toEqual(['¬a3a2a0', '¬a3a1a0']);
    const t = walk('g_sop').steps[0].text;
    expect(t).toContain('three essential prime implicants');
    expect(t).toContain('20 NANDs, depth 7');
    expect(t).toContain(', 16.');
    expect(cost('g_sop')).toContain('20 NANDs, depth 7');
    expect(cost('g_sop')).toContain('Par is 8, depth 5');
    expect(caseOf('g_sop')!.alts!.slice(0, 2).map((a) => [a.nand, a.depth])).toEqual([[20, 7], [16, 7]]);
  });

  it('the walk ends on par, as the text says', () => {
    const w = walk('g_sop'), m = metric('g_sop', w.steps.length - 1);
    expect([m.nand, m.depth]).toEqual([8, 5]);
    expect(w.steps[w.steps.length - 1].text).toContain('8 NANDs, depth 5');
    expect(NUDGES.g_sop).toContain('share');
  });
});

describe('g_dec: the predecoded 3→8 decoder', () => {
  it('is 30 NANDs, depth 5, against 51 for eight 4-input ANDs', () => {
    expect([nands(DEC3), logicDepth(DEC3)]).toEqual([30, 5]);
    const and4 = andN(4);
    expect([nands(and4), logicDepth(and4)]).toEqual([6, 4]);
    const textbook = 8 * nands(and4) + 3 * nands(NOT);
    expect(textbook).toBe(51);
    expect(node('g_dec').par).toEqual({ nand: 30, depth: 5 });
    const w = walk('g_dec');
    expect(finalNand('g_dec')).toBe(30);
    expect(w.steps[0].text).toContain(`cost ${textbook} NANDs`);
    expect(w.steps[w.steps.length - 1].text).toContain(`= 30 NANDs, depth 5`);
    expect(w.steps[w.steps.length - 1].text).toContain(`${textbook - 30} fewer`);
    expect(cost('g_dec')).toContain('30 NANDs, depth 5');
    expect(caseOf('g_dec')!.alts![0]).toMatchObject({ nand: textbook, depth: 5 });
  });
});

describe('numbers the walks quote', () => {
  it('each core walk names its reference\'s total', () => {
    for (const id of ['c_core1', 'c_core2', 'c_core3', 'c_computer', 'pi_core0', 'pi_core1', 'pi_core2', 'pi_core3', 'y_trap', 'y_irq', 'y_final', 'm_rf']) {
      expect(quotes(walkText(id), finalNand(id)), `${id}: ${finalNand(id)}`).toBe(true);
    }
  });

  it('y_trap: system decode is 439 NANDs', () => {
    const { k, text } = step('y_trap', 'System decode');
    const d = metric('y_trap', k).nand - metric('y_trap', k - 1).nand;
    expect(d).toBe(439);
    expect(quotes(text, d)).toBe(true);
    expect(cost('y_trap')).toContain(`system decode ${d}`);
  });

  it('a_shift16: one 49-NAND mux per level, 98 for the reversal against 196 for a second shifter', () => {
    const m = nands(MUX16);
    expect(m).toBe(49);
    expect(step('a_shift16', 'Reverse for left shifts').text).toContain(`two ${m}-NAND muxes (${2 * m}) instead of a second four-level shifter (4 × ${m} = ${4 * m})`);
    expect(step('a_shift16', 'Shift by 1, then by 2').text).toContain(`Each level costs ${m} NANDs`);
    expect(cost('a_shift16')).toContain(`${4 * m} NANDs, depth 9 (the library's, with 64-NAND muxes, ${nands(lib('shl16_4'))})`);
  });

  it('m_rf: the decoder, the registers\' share of the file', () => {
    const rf = finalNand('m_rf'), regs = 7 * nands(RV16_REG16);
    expect(step('m_rf', 'Write select').text).toContain(`${nands(DEC3)} NANDs`);
    expect(step('m_rf', 'Registers x2 to x7').text).toContain(`${regs} NANDs, ${Math.round((100 * regs) / rf)}% of the file`);
    expect(cost('m_rf')).toContain(`the decoder (${nands(DEC3)}): ${rf} NANDs`);
    expect(caseOf('m_rf')!.alts![0].nand).toBe(rf + nands(RV16_REG16));
  });

  it('pi_reg: sixteen pipeline registers are a third of the finished RV16', () => {
    const share = (16 * finalNand('pi_reg')) / finalNand('y_final');
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.37);
    expect(walkText('pi_reg')).toContain('4 160 NANDs, a third of the chip');
    expect(16 * finalNand('pi_reg')).toBe(4160);
  });
});

describe('numbers the cases quote', () => {
  it('each level\'s case names its reference\'s total', () => {
    for (const id of ['g_dec', 'm_rf', 'c_core1', 'c_core2', 'c_core3', 'c_computer', 'c_fast', 'pi_core0', 'pi_core1', 'pi_core2', 'pi_core3', 'o_bpred', 'y_trap', 'y_irq', 'y_final', 'o_mcore', 'o_dcore', 'o_mc', 'k_vrf', 'k_simd', 'k_simt', 'k_warps', 'k_edge', 'k_raster', 'k_frame']) {
      expect(quotes(cost(id), finalNand(id)), `${id}: ${finalNand(id)}`).toBe(true);
    }
  });

  it('t_inv and t_nand: the single-cycle core\'s NOTs and totals', () => {
    const cpu = lib('rv16_cpu'), pipe = lib('rv16_pipe_111s'), nots = copiesIn(cpu, NOT);
    expect(cost('t_inv')).toContain(`${nots} NOT gates cost ${4 * nots} transistors where CMOS inverters would need ${2 * nots}`);
    expect(cost('t_nand')).toContain(`${stats(cpu).nands} NANDs (${stats(cpu).transistors} transistors), the pipeline with traps ${stats(pipe).nands} (${stats(pipe).transistors})`);
    expect(stats(pipe).nands).toBe(finalNand('y_final'));
  });

  it('Kogge–Stone: the level\'s adder and the library\'s', () => {
    const m = metric('o_fastadd', walk('o_fastadd').steps.length - 1), ks = lib('ks16');
    const both = `${m.nand} NANDs, depth ${m.depth}`;
    expect(cost('a_add16')).toContain(`is ${both} as its level builds it (the library's, listed below, ${nands(ks)} and ${logicDepth(ks)})`);
    expect(cost('o_fastadd')).toContain(`Kogge–Stone: ${both} (the library's version ${nands(ks)}, depth ${logicDepth(ks)})`);
    expect(cost('o_fastadd')).toContain(`makes it ${nands(lib('rv16_cpu_ks'))} NANDs instead of ${nands(lib('rv16_cpu'))}`);
  });

  it('floating point: binary32 adder, the comparator alternative', () => {
    expect(cost('o_fpadd')).toContain(`binary32 (8-bit exponent, 23-bit fraction) is ${spelled(nands(lib('fpadd8_23')))[1]} NANDs, depth ${logicDepth(lib('fpadd8_23'))}`);
    const cmp = lib('cmp16');
    expect(caseOf('o_fpcmp')!.alts![0].lib).toBe('cmp16');
    expect(cost('o_fpcmp')).toContain(`16-bit integer magnitude comparator alone (listed below) is ${nands(cmp)} NANDs, depth ${logicDepth(cmp)}`);
  });

  it('act 9: the lane cores\' parts', () => {
    const vrf = nands(VRF16), rf = nands(lib('rv16_rf')), simd = nands(rv16Lanes(false)), simt = nands(rv16Lanes(true));
    const warps = nands(RV16_WARPS), edge = nands(EDGE16), raster = nands(RASTER16), cpu = nands(lib('rv16_cpu'));
    const n = (x: number) => spelled(x)[1];
    expect(cost('k_vrf')).toContain(`${n(vrf)} NANDs, period 11: four ${n(rf)}-NAND register files`);
    expect(cost('k_vrf')).toContain(`a ${nands(DEC3)}-NAND write decoder. ${Math.round((100 * vrf) / simd)}% of the SIMD core`);
    const lane = rf + 1149 + 147, shared = simd - 4 * lane;
    expect(cost('k_simd')).toContain(`Per lane ${n(lane)} (registers ${n(rf)},`);
    expect(cost('k_simd')).toContain(`shared ${n(shared)} (`);
    expect(cost('k_simd')).toContain(`lane decoder ${nands(LANEDEC16)},`);
    expect(cost('k_simd')).toContain(`Four single-cycle cores are ${n(4 * cpu)} NANDs: the lane core saves ${n(4 * cpu - simd)} (${Math.round((100 * (4 * cpu - simd)) / (4 * cpu))}%)`);
    expect(caseOf('k_simd')!.alts![0]).toMatchObject({ nand: 4 * cpu, note: `4 × ${n(cpu)}: the measured rv16_cpu` });
    expect(cost('k_simt')).toContain(`+${n(simt - simd)} over the SIMD core`);
    expect(cost('k_warps')).toContain(`+${n(warps - simt)} over the SIMT core, ${n(vrf)} of them`);
    expect(cost('k_edge')).toContain(`the command decoder ${nands(DEC3)}.`);
    expect(cost('k_raster')).toContain(`the three steppers ${n(3 * edge)},`);
    const frame = finalNand('k_frame');
    expect(cost('k_frame')).toContain(`the two-warp core's ${n(warps)}, the rasterizer's ${n(raster)}, and ${n(frame - warps - raster)} for the device`);
  });
});
