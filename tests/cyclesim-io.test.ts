// A sandbox computer on the cycle engine: a counter addressing a 256 × 8 RAM (a large, behavioural
// RAM), switches feeding it, its words printed on a console and painted on a screen with vsync.
// Every net, and the RAM's, console's and screen's states, equal GateSim's after every settle.

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { PowerOnMode, Sim } from '../src/sim/sim';
import { chip, compileLib, part, pin, wire } from './editorkit';

afterEach(() => vi.restoreAllMocks());

function computer() {
  return chip('u_io_computer', 'IO computer', {
    pins: [{ ...pin('clk', 'in', [0, 20]), kind: 'clock' }, pin('we', 'in', [0, 24]), pin('vs', 'out', [80, 2])],
    parts: [
      part('one', { const: { width: 1, value: 1 } }, [2, 2]), part('cnt', { lib: 'counter8' }, [8, 4]),
      part('xy', { split: [4, 4] }, [24, 0]), part('sw', { switches: 8 }, [8, 16]),
      part('ram', { ram: { k: 8, w: 8 } }, [30, 10]), part('dq', { split: [4, 4] }, [48, 12]),
      part('con', { console: { cols: 16, rows: 4 } }, [60, 14]),
      part('scr', { screen: { mode: 'write', size: 16, color: 'pal16', vsync: 5 } }, [60, 0]),
    ],
    wires: [
      wire('c1', 'pin:clk', 'cnt.clk'), wire('c2', 'pin:clk', 'ram.clk'), wire('c3', 'pin:clk', 'con.clk'), wire('c4', 'pin:clk', 'scr.clk'),
      wire('e1', 'one.y', 'cnt.en'), wire('e2', 'one.y', 'con.we'), wire('e3', 'one.y', 'scr.we'),
      wire('q1', 'cnt.q', 'xy.in'), wire('q2', 'cnt.q', 'ram.addr'), wire('x', 'xy.o0', 'scr.x'), wire('y', 'xy.o1', 'scr.y'),
      wire('d', 'sw.q', 'ram.din'), wire('w', 'pin:we', 'ram.we'),
      wire('o1', 'ram.dout', 'dq.in'), wire('o2', 'ram.dout', 'con.data'), wire('col', 'dq.o0', 'scr.color'),
      wire('v', 'scr.vsync', 'pin:vs'),
    ],
  });
}

function sameNets(a: Sim, b: Sim, at: string): void {
  for (let net = 0; net < a.design.netCount; net++) {
    if (a.get(net) !== b.get(net)) expect.fail(`${at}: net ${net} is ${a.get(net)} on the cycle engine, ${b.get(net)} on GateSim`);
  }
}

describe('a sandbox computer with a large RAM, a console and a screen', () => {
  for (const mode of ['zero', 'x'] as PowerOnMode[]) {
    it(`on the cycle engine ≡ GateSim (power-on ${mode})`, () => {
      const c = compileLib(computer());
      expect(c.diags.filter((x) => x.level === 'error')).toEqual([]);
      const d = flatten(c.def);
      const dual = new DualSim(d), ref = new GateSim(d);
      dual.reset(mode);
      ref.reset(mode);
      dual.preferFast = true;
      dual.prepare();
      expect(dual.whyNot).toBe('');
      const sw = d.leaves.findIndex((l) => l.node.path.join('.') === 'sw');
      const leaves = ['ram', 'con', 'scr'].map((p) => d.leaves.findIndex((l) => l.node.path.join('.') === p));
      expect([sw, ...leaves].every((i) => i >= 0)).toBe(true);
      let r = 7;
      const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      let fast = 0;
      for (let k = 0; k < 400; k++) {
        if (rnd() < 0.2) { const v = Math.floor(rnd() * 256); for (const s of [dual, ref]) { s.poke(sw, { v }); s.settle(); } }
        if (rnd() < 0.1) { const v = rnd() < 0.6 ? 1 : 0; for (const s of [dual, ref]) { s.setInput('we', v); s.settle(); } }
        for (const v of [1, 0]) {
          for (const s of [dual, ref]) { s.setInput('clk', v); s.settle(); }
          if (dual.engine === 'cycle') fast++;
          sameNets(dual, ref, `${mode} cycle ${k}`);
        }
      }
      expect(fast).toBe(800);
      for (const li of leaves) expect(dual.leafState(li), d.leaves[li].node.path.join('.')).toEqual(ref.leafState(li));
    });
  }
});
