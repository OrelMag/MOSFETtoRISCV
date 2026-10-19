// Chapters 4–10's numbers that the text cannot compute in place: each is measured here and compared with the number
// the text quotes, read from the text, so a change to either the circuit or the prose fails.

import { describe, expect, it } from 'vitest';
import { nodeById } from '../src/campaign/nodes';
import { chAdders, chRouting } from '../src/chapters/ch-arith';
import { chGates } from '../src/chapters/ch-gates';
import { chLatches, chMemory, chRegisters } from '../src/chapters/ch-memory';
import type { Chapter } from '../src/chapters/types';
import { addSub, DET101_FSM, DFF, DFFE, fsmNext, MUX2, priorityEncoder, ringCounter, RV16_DFF, RV16_DLATCH } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import type { Sim } from '../src/sim/sim';
import { pack } from '../src/sim/values';

const body = (c: Chapter, title: string): string => {
  const s = c.steps.find((x) => x.title === title);
  expect(s, `${c.id}: step '${title}'`).toBeTruthy();
  return s!.body;
};
const num = (html: string, re: RegExp): number => {
  const m = html.match(re);
  expect(m, `${re}`).toBeTruthy();
  return Number(m![1]);
};

/** The flip-flop's timing contract in unit NAND delays, by simulation: d changed k delays before / after the edge. */
function timing(def: typeof DFF) {
  const q = (s: Sim) => pack(s.getBits(s.design.root.ports.q));
  const fresh = (d: number): Sim => {
    const s = simulate(def);
    s.reset('zero');
    for (const [clk, dd] of [[0, d], [1, d], [0, d]]) { s.setInput('d', dd); s.setInput('clk', clk); s.settle(); }
    return s;
  };
  const at = (s: Sim, t: number) => s.runUntil!(t);
  // setup: the smallest k for which d set k delays before the edge is captured, both ways
  const setupOk = (k: number) => [0, 1].every((v) => {
    const s = fresh(1 - v), T = s.time + 5;
    at(s, T); s.setInput('d', v); at(s, T + k); s.setInput('clk', 1); s.settle();
    return q(s) === v;
  });
  // hold: the smallest h for which d changed h delays after the edge leaves the captured value alone
  const holdOk = (h: number) => [0, 1].every((v) => {
    const s = fresh(1 - v);
    s.setInput('d', v); s.settle();
    const T = s.time + 5;
    at(s, T); s.setInput('clk', 1); at(s, T + h); s.setInput('d', 1 - v); s.settle();
    return q(s) === v;
  });
  const clkToQ = (v: number) => {
    const s = fresh(1 - v);
    s.setInput('d', v); s.settle();
    const T = s.time + 5;
    at(s, T); s.setInput('clk', 1);
    while (s.step()) if (q(s) === v) return s.time - T;
    return -1;
  };
  let setup = 0, hold = 0;
  while (!setupOk(setup)) setup++;
  while (!holdOk(hold)) hold++;
  // every larger margin works too
  for (let k = setup; k < setup + 4; k++) expect(setupOk(k)).toBe(true);
  for (let h = hold; h < hold + 4; h++) expect(holdOk(h)).toBe(true);
  return { setup, hold, rise: clkToQ(1), fall: clkToQ(0) };
}

describe('content: logic chapters', () => {
  it('the flip-flop step quotes the setup, hold and clock-to-q the scene has', () => {
    const t = timing(DFF);
    const html = body(chLatches, 'The flip-flop: act only on the edge');
    expect(num(html, /<strong>Setup<\/strong> \((\d+) delays? here\)/)).toBe(t.setup);
    expect(num(html, /<strong>Hold<\/strong> \((\d+) delays? here\)/)).toBe(t.hold);
    expect(num(html, /<strong>Clock-to-q<\/strong> \((\d+) delays? here for a rising q/)).toBe(t.rise);
    expect(num(html, /for a rising q, (\d+) for a falling one/)).toBe(t.fall);
    // the campaign's 9-NAND flip-flop keeps the same contract
    expect(timing(RV16_DFF)).toEqual(t);
  });

  it('the 4-NAND latch aside matches the campaign parts and pars', () => {
    const lat = RV16_DLATCH.netlist!();
    const g2 = lat.nets.find((n) => n.ends.includes('g2.a'))!;
    expect(g2.ends).toContain('g1.y'); // r_n = NAND(s_n, e): g2 reads g1's output, not an inverted d
    expect(lat.nets.find((n) => n.ends.includes('g2.b'))!.ends).toContain('e');
    expect(nodeById('s_dlatch')!.par).toEqual({ nand: stats(RV16_DLATCH).nands });
    expect(nodeById('s_dff')!.par).toEqual({ nand: stats(RV16_DFF).nands });
    expect(body(chLatches, 'The D latch: store what you are told')).toContain('r_n = NAND(NAND(d, e), e)');
  });

  it('the mux aside lists the minterms of MUX2', () => {
    const minterms: string[] = [];
    for (let v = 0; v < 8; v++) {
      const s = (v >> 2) & 1, a = (v >> 1) & 1, b = v & 1;
      if (MUX2.spec!([a, b, s])[0]) minterms.push(`${s}${a}${b}`);
    }
    expect(body(chGates, 'The multiplexer: a digital switch')).toContain(`(s a b = ${minterms.join(', ')})`);
  });

  it('the subtractor names its overflow gate on the right carries', () => {
    const net = addSub(8).netlist!().nets;
    expect(net.find((n) => n.name === 'c7')!.ends).toContain('vx.a');
    expect(net.find((n) => n.name === 'c8')!.ends).toContain('vx.b');
    expect(body(chAdders, 'Subtraction for free')).toContain('v = c7 XOR c8');
  });

  it('the priority encoder has log2 n − 1 levels of multiplexers', () => {
    const levels = (n: number): number => {
      const sub = priorityEncoder(n).netlist!().instances.find((i) => i.name === 'lo');
      return sub ? 1 + levels(n / 2) : 0;
    };
    expect(levels(8)).toBe(2);
    expect(levels(32)).toBe(4);
    expect(body(chRouting, 'Priority: the highest request wins')).toContain('log₂ n − 1 levels of multiplexers');
  });

  it('the Johnson counter reaches the state its Try asks for once init = 0', () => {
    const s = simulate(ringCounter(4, true));
    s.reset('zero');
    const q = () => pack(s.getBits(s.design.root.ports.q));
    const edge = () => { s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); };
    s.setInput('init', 1); s.setInput('clk', 0); s.settle(); edge();
    expect(q()).toBe(0);
    edge();
    expect(q()).toBe(0); // init = 1 holds it at 0000
    s.setInput('init', 0); s.settle();
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) { edge(); seen.push(q()); }
    expect(seen).toEqual([0b0001, 0b0011, 0b0111, 0b1111, 0b1110, 0b1100, 0b1000, 0b0000]);
  });

  it('the one-hot equations follow the 101 detector\'s state diagram', () => {
    for (let st = 0; st < 3; st++) for (const x of [0, 1]) {
      const [S0, S1, S2] = [st === 0, st === 1, st === 2].map(Number);
      const next = [x ? 0 : S0 | S2, x, x ? 0 : S1]; // S0' = ¬x·(S0 + S2), S1' = x, S2' = ¬x·S1
      expect(next.indexOf(1), `S${st}, x = ${x}`).toBe(fsmNext(DET101_FSM, st, { x, rst: 0 }));
    }
    const html = body(chRegisters, 'State machines');
    for (const e of ["S1' = x", "S2' = ¬x·S1", "S0' = ¬x·(S0 + S2)", 'y = x·S2']) expect(html).toContain(e);
  });

  it('the memory-size paragraph prices DRAM bits in flip-flops correctly', () => {
    const bits = 16 * 2 ** 30 * 8;
    const html = body(chMemory, 'Scale it up');
    expect(num(html, /16 GB of DRAM is ([\d.]+) × 10¹¹ bits/)).toBeCloseTo(bits / 1e11, 1);
    expect(num(html, /it would take (\d+) × 10¹² transistors/)).toBe(Math.floor((bits * stats(DFFE).transistors) / 1e12));
  });

  it('the synchronizer aside\'s factor e^(T/τ) is the power of ten it quotes', () => {
    const html = body(chRegisters, 'Asynchronous reset');
    expect(html).toContain('τ = 10 ps and a 1 ns clock, e^100 ≈ 10⁴³');
    expect(Math.floor(100 / Math.LN10)).toBe(43);
  });
});
