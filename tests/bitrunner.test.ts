// Appendix D: Bit Runner's gates against its reference model, every register and every output at every clock.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BIT_RUNNER, RB_STATE, rbCost } from '../src/lib/bitrunner';
import { BitRunnerModel, RB_CLOCKS, type RbInputs, type RbState } from '../src/runner/model';
import { DualSim } from '../src/sim/dualsim';
import { findNode, flatten } from '../src/sim/flatten';
import { tick as yieldTick } from './yieldtick';

const design = flatten(BIT_RUNNER);

function reader(sim: DualSim) {
  const nets = Object.fromEntries(Object.entries(RB_STATE).map(([k, [path, port]]) => {
    const node = findNode(design.root, path.split('.'));
    if (!node) throw new Error(`no ${path}`);
    return [k, node.ports[port]];
  })) as unknown as Record<keyof typeof RB_STATE, ArrayLike<number>>;
  const val = (k: keyof typeof RB_STATE, n = 4) => { let x = 0; for (let i = 0; i < n; i++) x |= sim.get(nets[k][i]) << i; return x; };
  return (): RbState => {
    const ws = val('wSt'), ps = val('pSt'), r = val('rules');
    return {
      h: val('hLo') | val('hHi', 3) << 4, v: val('vLo') | val('vHi', 2) << 4, f: (ws >> 2) & 1,
      wc: val('wLo') | val('wHi', 2) << 4, w: ws & 1, armed: (ws >> 1) & 1,
      lfsr: val('lfsr', 8), gapA: val('gapA'), gapB: val('gapB'),
      py: val('pLo') | val('pHi', 2) << 4, bit: ps & 1, flipPrev: (ps >> 1) & 1,
      run: r & 1, ghost: (r >> 1) & 1, lives: r >> 2,
      ones: val('ones'), tens: val('tens'),
    };
  };
}

function machine() {
  const sim = new DualSim(design);
  sim.reset('zero');
  for (const p of ['up', 'down', 'flip', 'start']) sim.setInput(p, 0);
  sim.setInput('clk', 0);
  sim.settle();
  sim.preferFast = true;
  sim.prepare();
  return sim;
}

function clock(sim: DualSim, i: RbInputs): void {
  for (const k of ['up', 'down', 'flip', 'start'] as const) sim.setInput(k, i[k]);
  sim.settle();
  sim.setInput('clk', 1);
  sim.settle();
  sim.setInput('clk', 0);
  sim.settle();
}

describe('Bit Runner', () => {
  it('costs what the chapter says', () => {
    const c = rbCost();
    expect(c).toEqual({ chips: 97, nands: 2648 });
  });

  it('follows the model at every clock, on random buttons, with the game restarted', async () => {
    const sim = machine(), read = reader(sim), m = new BitRunnerModel();
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) >>> 8) % n;
    const input: RbInputs = { up: 0, down: 0, flip: 0, start: 0 };
    for (let t = 0; t < RB_CLOCKS * 14; t++) {
      if (t % 512 === 0) { input.up = rnd(3) === 0 ? 1 : 0; input.down = rnd(3) === 0 ? 1 : 0; }
      input.flip = rnd(300) === 0 ? 1 - input.flip : input.flip;
      input.start = t === 40 || t === RB_CLOCKS * 9 ? 1 : 0;
      clock(sim, input);
      m.step(input);
      const got = read();
      if (JSON.stringify(got) !== JSON.stringify(m.s)) expect.fail(`clock ${t}: gates ${JSON.stringify(got)} model ${JSON.stringify(m.s)}`);
      const v = m.video();
      for (const p of ['white', 'amber', 'cyan', 'hsync', 'vsync'] as const) {
        const net = design.root.ports[p][0];
        if (sim.get(net) !== v[p]) expect.fail(`clock ${t} (${m.s.h}, ${m.s.v}): ${p} is ${sim.get(net)}, the model says ${v[p]}`);
      }
      if (t % 4000 === 0) await yieldTick();
    }
    expect(sim.whyNot ?? '').toBe('');
  }, 120000);
});
