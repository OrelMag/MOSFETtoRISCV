// Chapter 42's parts: the Schmitt trigger on the switch-level solver, the synchronizers and Gray code on the gate
// simulator, the toggle pulse synchronizer and the asynchronous FIFO against its golden model under seeded random
// interleavings of two clocks (every output after every edge; no word lost, repeated or invented; the flags late,
// never wrong). The same FIFO on the cycle engine, to say whether two clocks run there.

import { describe, expect, it } from 'vitest';
import { AsyncFifoModel, fromGray, grayStep, hamming, interleave, randomInterleave, RATIOS, toGray } from '../src/comm/asyncfifo';
import { asyncFifo, BIN2GRAY, GRAY2BIN, NMOS_WEAK, PULSE_SYNC, SCHMITT, SYNC2, SYNC_BENCH, syncN } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { DualSim } from '../src/sim/dualsim';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1 } from '../src/sim/types';
import { fifo, XOR } from '../src/lib';
import { checkSpec, lcg, out, set } from './util';
import { tick as yieldTick } from './yieldtick';

const edge = (s: Parameters<typeof set>[0], c: string): void => { set(s, { [c]: 1 }); set(s, { [c]: 0 }); };

describe('Schmitt trigger (switch level)', () => {
  const s = new SwitchSim(flatten(SCHMITT, { mode: 'switch' }));
  const bit = (p: string) => s.get(s.design.root.ports[p][0]);
  it('passes 0 and 1 through (a buffer) with the keeper agreeing', () => {
    for (const v of [0, 1, 0, 1, 1, 0]) {
      s.setInput('a', v); s.settle();
      expect(bit('y')).toBe(v ? B1 : B0);
    }
  });
  it('the keeper is weaker than the input devices and never fights to a draw', () => {
    expect(NMOS_WEAK.strength).toBe(2);
    expect(SCHMITT.netlist!().instances.find((i) => i.name === 'pk')!.def.strength).toBe(2);
    expect(s.hasShort ?? false).toBeFalsy();
  });
  it('is six transistors', () => {
    expect(stats(SCHMITT).transistors).toBe(6);
  });
});

describe('Gray code', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    it(`bin2gray / gray2bin ${n} bits match their specs`, () => { checkSpec(BIN2GRAY(n)); checkSpec(GRAY2BIN(n)); });
  }
  it('the two are inverses and consecutive Gray words differ in one bit, wrap-around included', () => {
    for (const n of [2, 3, 4, 5]) {
      for (let b = 0; b < 2 ** n; b++) {
        expect(fromGray(toGray(b))).toBe(b);
        expect(hamming(toGray(b), grayStep(b, n))).toBe(1);
      }
    }
  });
  it('binary counting changes up to n bits at once', () => {
    let worst = 0;
    for (let b = 0; b < 15; b++) worst = Math.max(worst, hamming(b, b + 1));
    expect(worst).toBe(4);
  });
  it('costs: n − 1 XORs each way', () => {
    const x = stats(XOR).nands;
    expect(stats(BIN2GRAY(4)).nands).toBe(3 * x);
    expect(stats(GRAY2BIN(4)).nands).toBe(3 * x);
  });
});

describe('synchronizers', () => {
  it('SYNC2 delivers a level two edges later, SYNC3 three', () => {
    for (const n of [2, 3]) {
      const s = simulate(syncN(n));
      set(s, { d: 0, clk: 0 });
      set(s, { d: 1 });
      for (let i = 1; i <= n; i++) {
        edge(s, 'clk');
        expect(out(s, 'q'), `${n} flops, edge ${i}`).toBe(i === n ? 1 : 0);
      }
    }
  });
  it('the bus synchronizer moves every bit with the same latency', () => {
    const s = simulate(syncN(2, 4));
    set(s, { d: 0, clk: 0 });
    set(s, { d: 0b1010 });
    edge(s, 'clk'); expect(out(s, 'q')).toBe(0);
    edge(s, 'clk'); expect(out(s, 'q')).toBe(0b1010);
  });
  it('SYNC_BENCH: a one-cycle pulse on a fast clock A is lost by a clock B three times slower, a level held for three A cycles is not', () => {
    // A runs three edges for each B edge; send is applied before A edge i
    const run = (pattern: (i: number) => number): number => {
      const s = simulate(SYNC_BENCH);
      set(s, { send: 0, aclk: 0, bclk: 0 });
      let seen = 0, i = 0;
      for (let g = 0; g < 6; g++) {
        for (let j = 0; j < 3; j++) { set(s, { send: pattern(i++) }); edge(s, 'aclk'); }
        edge(s, 'bclk');
        seen += out(s, 'q');
      }
      return seen;
    };
    expect(run((i) => (i === 1 ? 1 : 0))).toBe(0);
    expect(run((i) => (i >= 1 && i <= 3 ? 1 : 0))).toBe(1);
  });
  it('SYNC2 alone: a pulse between two edges is never seen; one spanning an edge is, for one cycle', () => {
    const s = simulate(SYNC2);
    set(s, { d: 0, clk: 0 });
    set(s, { d: 1 }); set(s, { d: 0 });            // up and down between edges
    for (let i = 0; i < 4; i++) { edge(s, 'clk'); expect(out(s, 'q')).toBe(0); }
    set(s, { d: 1 }); edge(s, 'clk'); set(s, { d: 0 });  // spans one edge
    edge(s, 'clk'); expect(out(s, 'q')).toBe(1);
    edge(s, 'clk'); expect(out(s, 'q')).toBe(0);
  });
});

describe('toggle pulse synchronizer', () => {
  it('one pulse in the sender domain is one pulse of one receiver cycle, whatever the clock ratio', () => {
    for (const [fa, fb] of [[1, 1], [3, 1], [1, 3], [2, 5]] as const) {
      const s = simulate(PULSE_SYNC);
      set(s, { pulse: 0, aclk: 0, bclk: 0 });
      let na = 0, ones = 0, lastOut = 0, high = 0;
      for (const e of interleave(fa, fb, 80)) {
        if (e === 'w') { set(s, { pulse: na === 4 ? 1 : 0 }); na++; edge(s, 'aclk'); } else {
          edge(s, 'bclk');
          const o = out(s, 'out');
          if (o && !lastOut) ones++;
          if (o) high++;
          lastOut = o;
        }
      }
      expect(ones, `${fa}:${fb}`).toBe(1);
      expect(high, `${fa}:${fb}`).toBe(1);
    }
  });
  it('two pulses spaced far enough give two; the receiver cannot tell a pulse from a double toggle closer than its latency', () => {
    const s = simulate(PULSE_SYNC);
    set(s, { pulse: 0, aclk: 0, bclk: 0 });
    let count = 0;
    const clkA = (p: number) => { set(s, { pulse: p }); edge(s, 'aclk'); set(s, { pulse: 0 }); };
    const clkB = () => { edge(s, 'bclk'); if (out(s, 'out')) count++; };
    clkA(1); for (let i = 0; i < 5; i++) clkB();
    clkA(1); for (let i = 0; i < 5; i++) clkB();
    expect(count).toBe(2);
    // two sender pulses with no receiver edge between: the level toggles twice and returns, nothing crosses
    clkA(1); clkA(1); for (let i = 0; i < 5; i++) clkB();
    expect(count).toBe(2);
  });
});

// ---- the FIFO -------------------------------------------------------------------------------------------------------

interface Run { edges: number; written: number[]; read: number[]; fullSeen: number; emptySeen: number; staleFull: number; staleEmpty: number }

/** Drive a gate-level asynchronous FIFO and the model through the same edges; compare every output after every edge. */
async function drive(k: number, w: number, fw: number, fr: number, edges: number, seed: number, pw: number, pr: number, random = false): Promise<Run> {
  const def = asyncFifo(k, w);
  const sim = simulate(def);
  const m = new AsyncFifoModel(k, w);
  const rnd = lcg(seed);
  set(sim, { we: 0, re: 0, wdata: 0, wclk: 0, rclk: 0 });
  const run: Run = { edges, written: [], read: [], fullSeen: 0, emptySeen: 0, staleFull: 0, staleEmpty: 0 };
  const same = (where: string) => {
    expect(out(sim, 'full'), `full ${where}`).toBe(m.full ? 1 : 0);
    expect(out(sim, 'empty'), `empty ${where}`).toBe(m.empty ? 1 : 0);
    expect(out(sim, 'rdata'), `rdata ${where}`).toBe(m.rdata);
    // conservative: a flag low is true; a flag high may be stale
    if (!m.full) expect(m.occupancy, `full low ${where}`).toBeLessThan(m.N);
    if (!m.empty) expect(m.occupancy, `empty low ${where}`).toBeGreaterThan(0);
    if (m.full) { run.fullSeen++; if (m.occupancy < m.N) run.staleFull++; }
    if (m.empty) { run.emptySeen++; if (m.occupancy > 0) run.staleEmpty++; }
    // what each domain has seen of the other pointer is old: it never believes in more words, or more room, than there are
    expect((m.writeSeenByReader - m.s.rb) & m.mask, `words believed ${where}`).toBeLessThanOrEqual(m.occupancy);
    expect((m.s.wb - m.readSeenByWriter) & m.mask, `room believed ${where}`).toBeGreaterThanOrEqual(m.occupancy);
  };
  same('power-on');
  let n = 0;
  for (const e of random ? randomInterleave(fw, fr, edges, seed) : interleave(fw, fr, edges)) {
    n++;
    if (e === 'w') {
      const we = rnd(100) < pw ? 1 : 0, wd = rnd(2 ** w);
      set(sim, { we, wdata: wd });
      const r = m.wEdge(!!we, wd);
      edge(sim, 'wclk');
      if (r.did) run.written.push(wd);
    } else {
      const re = rnd(100) < pr ? 1 : 0;
      set(sim, { re });
      const r = m.rEdge(!!re);
      edge(sim, 'rclk');
      if (r.did) run.read.push(r.word!);
    }
    same(`edge ${n} (${e}) seed ${seed}`);
    if (n % 400 === 0) await yieldTick();
  }
  return run;
}

describe('asynchronous FIFO against its golden model', () => {
  it('has the ports of the write and read domains', () => {
    const d = asyncFifo(2, 4);
    expect(d.ports.map((p) => p.name)).toEqual(['we', 'wdata', 'wclk', 'full', 're', 'rclk', 'rdata', 'empty']);
    expect(d.ports.filter((p) => p.clock).map((p) => p.name)).toEqual(['wclk', 'rclk']);
  });
  it('model: words come out in order, none lost or invented, any interleaving', async () => {
    for (const [fw, fr] of RATIOS) {
      for (const seed of [1, 2, 3]) {
        const m = new AsyncFifoModel(3, 8);
        const rnd = lcg(seed * 977 + fw * 13 + fr);
        const written: number[] = [], read: number[] = [];
        for (const e of interleave(fw, fr, 6000)) {
          if (e === 'w') { const we = rnd(100) < 60, wd = rnd(256); if (m.wEdge(we, wd).did) written.push(wd); } else { const r = m.rEdge(rnd(100) < 60); if (r.did) read.push(r.word!); }
          if (!m.full) expect(m.occupancy).toBeLessThan(m.N);
          if (!m.empty) expect(m.occupancy).toBeGreaterThan(0);
          expect(m.occupancy).toBeLessThanOrEqual(m.N);
        }
        expect(read).toEqual(written.slice(0, read.length));
        expect(written.length - read.length).toBe(m.occupancy);
        expect(read.length).toBeGreaterThan(100);
      }
      await yieldTick();
    }
  });
  it('gates equal the model every output after every edge, at every ratio, with full and empty reached', async () => {
    let fulls = 0, empties = 0;
    for (const [fw, fr] of RATIOS) {
      const bias = fw > fr ? [90, 30] : fw < fr ? [30, 90] : [60, 60];
      const r = await drive(2, 4, fw, fr, 1200, 100 + fw * 7 + fr, bias[0], bias[1]);
      expect(r.read).toEqual(r.written.slice(0, r.read.length));
      expect(r.read.length).toBeGreaterThan(20);
      fulls += r.fullSeen; empties += r.emptySeen;
    }
    expect(fulls).toBeGreaterThan(50);
    expect(empties).toBeGreaterThan(50);
  }, 120000);
  it('random interleavings: jittered edges in bursts, seeded, several seeds per ratio, gates equal the model', async () => {
    let longestRun = 0;
    for (const [fw, fr] of RATIOS) {
      for (const seed of [21, 22]) {
        const bias = fw > fr ? [90, 30] : fw < fr ? [30, 90] : [60, 60];
        const r = await drive(2, 4, fw, fr, 700, seed * 31 + fw * 7 + fr, bias[0], bias[1], true);
        expect(r.read).toEqual(r.written.slice(0, r.read.length));
      }
      const ev = randomInterleave(fw, fr, 3000, 99);
      let run = 1;
      for (let i = 1; i < ev.length; i++) { run = ev[i] === ev[i - 1] ? run + 1 : 1; longestRun = Math.max(longestRun, run); }
    }
    expect(longestRun).toBeGreaterThanOrEqual(8);
  }, 240000);
  it('random interleavings, model only: many seeds, no word lost, repeated or invented, flags never wrong', async () => {
    for (const [fw, fr] of RATIOS) {
      for (let seed = 1; seed <= 6; seed++) {
        const m = new AsyncFifoModel(3, 8), rnd = lcg(seed * 1315 + fw);
        const written: number[] = [], read: number[] = [];
        for (const e of randomInterleave(fw, fr, 4000, seed * 7 + fr, 0.5 + seed / 12)) {
          if (e === 'w') { const wd = rnd(256); if (m.wEdge(rnd(100) < 70, wd).did) written.push(wd); } else { const r = m.rEdge(rnd(100) < 50); if (r.did) read.push(r.word!); }
          if (!m.full) expect(m.occupancy).toBeLessThan(m.N);
          if (!m.empty) expect(m.occupancy).toBeGreaterThan(0);
        }
        expect(read).toEqual(written.slice(0, read.length));
      }
      await yieldTick();
    }
  }, 120000);
  it('a deeper FIFO: 8 words, several seeds', async () => {
    for (const seed of [11, 12]) {
      const r = await drive(3, 3, 5, 3, 1500, seed, 70, 50);
      expect(r.read).toEqual(r.written.slice(0, r.read.length));
      expect(r.read.length).toBeGreaterThan(50);
    }
  }, 120000);
  it('the flags are late, not wrong: some are stale, none ahead of the truth', async () => {
    const r = await drive(2, 4, 3, 2, 2000, 5, 80, 40);
    expect(r.staleFull + r.staleEmpty).toBeGreaterThan(0);
  }, 60000);
  it('latency: a word written on a lone wclk edge is visible (empty low) after exactly two rclk edges', () => {
    const sim = simulate(asyncFifo(2, 4));
    set(sim, { we: 1, re: 0, wdata: 9, wclk: 0, rclk: 0 });
    edge(sim, 'wclk');
    set(sim, { we: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) { seen.push(out(sim, 'empty')); edge(sim, 'rclk'); }
    expect(seen).toEqual([1, 1, 0, 0]);
    expect(out(sim, 'rdata')).toBe(9);
  });
  it('and the freed slot reaches the writer after two wclk edges', () => {
    const sim = simulate(asyncFifo(1, 2));   // 2 words
    set(sim, { we: 1, re: 0, wdata: 1, wclk: 0, rclk: 0 });
    edge(sim, 'wclk'); edge(sim, 'wclk');
    expect(out(sim, 'full')).toBe(1);
    for (let i = 0; i < 3; i++) edge(sim, 'rclk');
    set(sim, { re: 1 }); edge(sim, 'rclk'); set(sim, { re: 0 });
    set(sim, { we: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) { seen.push(out(sim, 'full')); edge(sim, 'wclk'); }
    expect(seen).toEqual([1, 1, 0, 0]);
  });
  it('costs: the pointers and synchronizers on top of the same storage as a synchronous FIFO', () => {
    const a = stats(asyncFifo(2, 8)).nands, s = stats(fifo(2, 8)).nands;
    expect(a).toBeGreaterThan(s);
    expect(a).toBeLessThan(2 * s);
  });
});

describe('two clocks on the cycle engine', () => {
  it('DualSim on the cycle engine gives the gate simulator\'s outputs at every edge of either clock', async () => {
    const def = asyncFifo(2, 4);
    const g = simulate(def);
    const d = new DualSim(flatten(def, { mode: 'gate' }));
    d.preferFast = true;
    const both = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) { g.setInput(k, x); d.setInput(k, x); } g.settle(); d.settle(); };
    both({ we: 0, re: 0, wdata: 0, wclk: 0, rclk: 0 });
    const rnd = lcg(42);
    let n = 0, onFast = 0;
    for (const e of interleave(3, 2, 1500)) {
      const v: Record<string, number> = e === 'w' ? { we: rnd(100) < 70 ? 1 : 0, wdata: rnd(16) } : { re: rnd(100) < 50 ? 1 : 0 };
      both(v);
      both({ [e === 'w' ? 'wclk' : 'rclk']: 1 });
      both({ [e === 'w' ? 'wclk' : 'rclk']: 0 });
      for (const p of ['full', 'empty', 'rdata']) expect(out(d, p), `${p} edge ${n}`).toBe(out(g, p));
      if (d.engine === 'cycle') onFast++;
      if (++n % 300 === 0) await yieldTick();
    }
    expect(onFast).toBeGreaterThan(1000);
  }, 120000);
});

describe('chapter claims measured on the circuits and the model', () => {
  it('sustained throughput at 1 : 1 is min(1, depth / 5) words per edge; deeper or faster-ratio FIFOs reach 1', async () => {
    const { sustained, CREDIT_EDGES } = await import('../src/comm/asyncfifo');
    expect(CREDIT_EDGES).toBe(5);
    expect(sustained(1, 1, 1)).toBeCloseTo(0.4, 2);
    expect(sustained(2, 1, 1)).toBeCloseTo(0.8, 2);
    expect(sustained(3, 1, 1)).toBeCloseTo(1, 2);
    expect(sustained(2, 2, 1)).toBeCloseTo(1, 2);
    expect(sustained(2, 1, 2)).toBeCloseTo(1, 2);
  });
  it('the synchronizer delivers a level at the second B edge after the sender changes it, at every ratio and under jitter', () => {
    for (const [fa, fb] of RATIOS) for (const seed of [3, 4]) {
      const s = simulate(SYNC_BENCH);
      set(s, { send: 0, aclk: 0, bclk: 0 });
      let phase: 'idle' | 'wait' | 'drain' = 'idle', bAfter = 0, quiet = 0, ok = 0, nA = 0;
      for (const e of randomInterleave(fa, fb, 600, seed)) {
        if (e === 'w') {
          nA++;
          if (phase === 'idle' && nA % 4 === 0) set(s, { send: 1 });
          edge(s, 'aclk');
          if (phase === 'idle' && out(s, 'a') === 1) { phase = 'wait'; bAfter = 0; }
        } else {
          edge(s, 'bclk');
          if (phase === 'wait') {
            bAfter++;
            if (out(s, 'q') === 1) { expect(bAfter, `${fa}:${fb}`).toBe(2); ok++; set(s, { send: 0 }); phase = 'drain'; quiet = 0; }
          } else if (phase === 'drain') {
            quiet = out(s, 'a') === 0 && out(s, 'q') === 0 ? quiet + 1 : 0;
            if (quiet >= 3) phase = 'idle';
          }
        }
      }
      expect(ok, `${fa}:${fb}`).toBeGreaterThan(3);
    }
  });
  it('a six-word one-bit cycle exists (001 011 010 110 111 101), so the power-of-two depth is about the full rule, not the code', () => {
    const c = [1, 3, 2, 6, 7, 5];
    for (let i = 0; i < 6; i++) expect(hamming(c[i], c[(i + 1) % 6])).toBe(1);
  });
});
