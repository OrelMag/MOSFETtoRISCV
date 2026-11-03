// Appendix D: Bit Runner's gates against its reference model, every register and every output at every clock.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BIT_RUNNER, RB_DIGITS, RB_GAPS, RB_PLAYER, RB_RULES, RB_SCORE, RB_STATE, RB_SYNC, RB_VIDEO, RB_WALLS, rbCost } from '../src/lib/bitrunner';
import { RB_COST } from '../src/chapters/ch-runner';
import { Crt, pixelOf } from '../src/runner/crt';
import { BitRunnerModel, RB_CLOCKS, RB_FRAME, RB_H, RB_LINE, RB_W, type RbInputs, type RbState } from '../src/runner/model';
import { validateLayout } from '../src/view/bblayout';
import { runnerLayout } from '../src/widgets/runnerlayout';
import { stats } from '../src/sim/stats';
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
    expect(c).toEqual({ chips: RB_COST.chips, nands: RB_COST.nands });
    const parts = { sync: RB_SYNC, walls: RB_WALLS, gaps: RB_GAPS, player: RB_PLAYER, rules: RB_RULES, score: RB_SCORE, digits: RB_DIGITS, video: RB_VIDEO };
    for (const [n, d] of Object.entries(parts)) expect(stats(d).nands, n).toBe(RB_COST[n as keyof typeof parts]);
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

  it('has boards every LED and chip of which is a net of the machine', () => {
    expect(validateLayout(runnerLayout(), BIT_RUNNER)).toEqual([]);
    expect(validateLayout(runnerLayout().narrow!, BIT_RUNNER)).toEqual([]);
  });

  it('shows on a monitor that knows only sync and video exactly what the model draws', () => {
    const m = new BitRunnerModel(), crt = new Crt(), idle = { up: 0, down: 0, flip: 0, start: 0 };
    crt.scan(m.video());
    for (let t = 0; t < RB_CLOCKS * 3; t++) { m.step(idle); crt.scan(m.video()); }
    expect(crt.frames).toBe(3);
    expect(RB_LINE * RB_FRAME).toBe(RB_CLOCKS);
    const seen = new Uint8Array(RB_W * RB_H);
    for (let t = 0; t < RB_CLOCKS; t++) {
      const { h, v } = m.s, p = m.video();
      if (h < RB_W && v < RB_H) seen[v * RB_W + h] = pixelOf(p);
      m.step(idle);
      crt.scan(m.video());
    }
    expect(crt.frames).toBe(4);
    expect([...crt.px.slice(1)]).toEqual([...seen.slice(1)]);
    expect(seen.includes(1)).toBe(true);
  });

  /** One frame of a player who reads the screen: the nearest wall not yet passed, its gate, and where they are. */
  function botFrame(m: BitRunnerModel, level: () => void): RbInputs {
    const look = new BitRunnerModel();
    look.s = { ...m.s };
    const idle = { up: 0, down: 0, flip: 0, start: 0 };
    let best = -1, gate = 0;
    for (let t = 0; t < RB_LINE; t++) {
      if (look.s.wc === 60 && look.s.h >= 8 && look.s.h < RB_W && (best < 0 || look.s.h < best)) { best = look.s.h; gate = look.s.w ? look.s.gapB : look.s.gapA; }
      look.step(idle);
    }
    level();
    if (best < 0) return idle;
    const y = (60 - m.s.py + RB_FRAME * 2) % RB_FRAME, want = (gate & 7) * 4 + 2;
    return { up: y > want ? 1 : 0, down: y < want ? 1 : 0, flip: gate >> 3 !== m.s.bit && best < 44 ? 1 : 0, start: 0 };
  }

  it('can be played: a player who reads the screen gets past 40, with the gates at their narrowest', () => {
    const m = new BitRunnerModel(), idle = { up: 0, down: 0, flip: 0, start: 0 };
    for (let t = 0; t < RB_CLOCKS; t++) m.step(idle);
    m.step({ ...idle, start: 1 });
    expect(m.s.run).toBe(1);
    for (let frame = 0; frame < 6000 && m.s.run && m.s.tens < 5; frame++) {
      while (m.s.h || m.s.v) m.step(idle);
      const i = botFrame(m, () => {});
      for (let t = 0; t < RB_CLOCKS; t++) { m.step(i); if (t === 0) i.flip = 0; }
    }
    expect(m.s.tens).toBeGreaterThanOrEqual(5);
    expect(m.s.lives).toBeLessThan(3);
  });

  it('plays by its rules: a bit that does not move crashes, once a wall, and the game ends at three', () => {
    const m = new BitRunnerModel(), idle = { up: 0, down: 0, flip: 0, start: 0 };
    for (let t = 0; t < 100; t++) m.step(idle);
    m.step({ ...idle, start: 1 });
    let crashes = 0, lives = 0;
    for (let t = 0; t < RB_CLOCKS * 3000 && m.s.run; t++) {
      m.step(idle);
      if (m.s.lives !== lives) { crashes++; lives = m.s.lives; expect(m.s.ghost).toBe(1); }
    }
    expect(m.s.run).toBe(0);
    expect(crashes).toBe(3);
    // a restart clears the game, and not the walls
    const wc = m.s.wc;
    m.step({ ...idle, start: 1 });
    expect([m.s.run, m.s.lives, m.s.ones, m.s.tens, m.s.ghost]).toEqual([1, 0, 0, 0, 0]);
    expect(m.s.wc).not.toBe(wc);
  });
});
