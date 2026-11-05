// lib/firmac.ts, the FIR on one multiplier and its parts, in gates: each against dsp/firdesign.ts's model, every cycle or every input.
import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { directFir, macAccWidth, MacModel, sceneMac, SCENE_MASK, type MacConfig } from '../src/dsp/firdesign';
import { satTo, wrapTo } from '../src/dsp/fixed';
import { clampWide, csdMultiplier, csdWidth, firCosts, firMac, firOut, firRom } from '../src/lib/firmac';
import { treeMul } from '../src/lib/muldiv';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { tick } from './yieldtick';

const lcg = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };

describe('a clamp for more than one guard bit', () => {
  it('21 bits to 16: 20 000 random words and the edges, equal to satTo', () => {
    const n = 21, w = 16, sim = simulate(clampWide(n, w)), rnd = lcg(5);
    const cases = [0, 1, 2 ** 15 - 1, 2 ** 15, 2 ** 15 + 1, 2 ** 20 - 1, 2 ** 20, 2 ** 20 + 2 ** 15, 2 ** 19, 2 ** 19 - 1, 2 ** 20 - 2 ** 15, 2 ** 20 - 2 ** 15 - 1, 2 ** 21 - 1];
    for (let i = 0; i < 20000; i++) cases.push(rnd() % 2 ** n);
    for (const x of cases) {
      const v = signedOf(x, n), [y, sat] = evalOnce(sim, [x]), s = satTo(v, w);
      expect(signedOf(y, w), String(v)).toBe(s); expect(sat, String(v)).toBe(s === v ? 0 : 1);
    }
  });
  it('9 bits to 8: all 512', () => {
    const sim = simulate(clampWide(9, 8));
    for (let x = 0; x < 512; x++) expect(signedOf(evalOnce(sim, [x])[0], 8)).toBe(satTo(signedOf(x, 9), 8));
  });
});

describe('a constant multiplier in shifts and adders', () => {
  for (const c of [0, 1, -1, 2, 3, -3, 7, -5, 12, -100, 100, 127, 255, -255, 64, -64]) {
    it(`× ${c}: every 8-bit input`, () => {
      const ow = csdWidth(c, 8), sim = simulate(csdMultiplier(c, 8));
      for (let a = -128; a < 128; a++) expect(signedOf(evalOnce(sim, [wordOf(a, 8)])[0], ow), `${c} × ${a}`).toBe(c * a + 0);
    });
  }
  it('the scene filter\'s own taps at 16 bits: the extremes and random words', () => {
    const rnd = lcg(9);
    for (const c of sceneMac().words.slice(0, 8)) {
      const sim = simulate(csdMultiplier(c, 16)), ow = csdWidth(c, 16);
      for (const a of [-32768, -1, 0, 1, 32767, ...Array.from({ length: 60 }, () => (rnd() % 65536) - 32768)]) expect(signedOf(evalOnce(sim, [wordOf(a, 16)])[0], ow), `${c} × ${a}`).toBe(c * a + 0);
    }
  });
  it('is far cheaper than a general multiplier, counted from the gates', () => {
    const tree = stats(treeMul(16, true)).nands;
    for (const c of sceneMac().words) expect(stats(csdMultiplier(c, 16)).nands, String(c)).toBeLessThan(tree / 2);
  });
});

describe('the tap rom and the rounder', () => {
  it('each address gives its tap and flags', () => {
    const { words } = sceneMac(), sim = simulate(firRom(words, 16));
    words.forEach((c, i) => {
      const [t, last, first] = evalOnce(sim, [i]);
      expect(signedOf(t, 16)).toBe(c); expect(last).toBe(i === words.length - 1 ? 1 : 0); expect(first).toBe(i === 0 ? 1 : 0);
    });
  });
  it('rounds half up and clamps once, as the model: random sums, the edges and the ties', () => {
    const w = 16, frac = 16, A = 33, sim = simulate(firOut(A, w, frac)), rnd = lcg(3), m = new MacModel({ taps: [0, 0], w, frac, guard: 1 });
    const edges = [0, 1, -1, 2 ** 15, 2 ** 15 - 1, -(2 ** 15), 2 ** 31 - 1, 2 ** 31, 2 ** 31 + 2 ** 15, -(2 ** 31) - 2 ** 15 - 1, 2 ** 32 - 1, -(2 ** 32)];
    const cases = [...edges, ...Array.from({ length: 4000 }, () => wrapTo(rnd() * 2 ** 12 + rnd(), A))];
    for (const v of cases) {
      m.acc = wrapTo(v, A);
      const [y, sat] = evalOnce(sim, [wordOf(m.acc, A)]);
      expect(signedOf(y, w), String(v)).toBe(m.result.y); expect(sat, String(v)).toBe(m.result.sat);
    }
  });
});

/** Gates and model together, one sample every N clocks: y, sat, take, k and the accumulator compared after every clock edge. */
async function lockstep(cfg: MacConfig, samples: number[]): Promise<{ sats: number; frames: number[] }> {
  const N = cfg.taps.length, A = macAccWidth(cfg), sim = simulate(firMac(cfg)), m = new MacModel(cfg), frames: number[] = [];
  let sats = 0, cycle = 0;
  sim.setInput('x', 0); sim.setInput('clk', 0); sim.reset('zero'); sim.settle();
  const port = (n: string): number => pack(sim.getBits(sim.design.root.ports[n]));
  for (const s of samples) {
    for (let c = 0; c < N; c++, cycle++) {
      const x = c === N - 1 ? s : 0; // read at the end of the cycle in which take is 1
      sim.setInput('x', wordOf(x, cfg.w)); sim.settle();
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      m.edge(x);
      expect(signedOf(port('y'), cfg.w), `y at cycle ${cycle}`).toBe(m.y);
      expect(port('sat'), `sat at ${cycle}`).toBe(m.sat);
      expect(port('take'), `take at ${cycle}`).toBe(m.last ? 1 : 0);
      expect(port('k'), `k at ${cycle}`).toBe(m.k);
      expect(signedOf(port('acc'), A), `acc at ${cycle}`).toBe(m.acc);
      if (cycle % 64 === 0) await tick();
    }
    frames.push(m.y); sats += m.sat;
  }
  return { sats, frames };
}

describe('the filter on one multiplier, against its model every cycle', () => {
  it('a 4-tap filter at 8 bits, with samples at the ends of the range and a clamp', async () => {
    const cfg: MacConfig = { taps: [90, -45, 100, 120], w: 8, frac: 6, guard: 2 };
    const r = await lockstep(cfg, [0, 127, -128, -128, 127, 100, -100, 3, 0, 0, 0, 55, -1, 127, 127, 127, 127]);
    expect(r.sats, 'the clamp acted at least once').toBeGreaterThan(0);
  });
  it('the scene filter: 16 taps at 16 bits, a tone, random samples, and full scale', async () => {
    const { cfg } = sceneMac(), rnd = lcg(17);
    const tone = Array.from({ length: 24 }, (_, i) => Math.round(20000 * Math.sin(2 * Math.PI * 0.05 * i)));
    const noise = Array.from({ length: 12 }, () => (rnd() % 65536) - 32768);
    await lockstep(cfg, [...tone, ...noise, 32767, 32767, -32768, -32768, 32767, -32768, 0, 0]);
  }, 120000);
  it('the model is the filter: the finished sum of frame n + 1, rounded and clamped, is the direct form on the sample taken at the end of frame n', () => {
    const { cfg } = sceneMac(), N = 16, rnd = lcg(31);
    const xs = Array.from({ length: 40 }, () => (rnd() % 20001) - 10000), direct = directFir(cfg.taps, xs), m = new MacModel(cfg);
    [...xs, 0].forEach((s, f) => {
      for (let c = 0; c < N; c++) m.edge(c === N - 1 ? s : 0);
      if (f >= 1) expect(m.result.y, `frame ${f}`).toBe(satTo(Math.floor((direct[f - 1] + 2 ** (cfg.frac - 1)) / 2 ** cfg.frac), cfg.w));
    });
  });
  it('counted from the gates: one multiplier is a fraction of N, and the folded form halves the multiplications', () => {
    const { cfg } = sceneMac(), rows = firCosts(cfg), one = rows.find((r) => r.cycles === cfg.taps.length)!, direct = rows[0];
    expect(one.nands).toBe(stats(firMac(cfg)).nands);
    expect(one.nands).toBeLessThan(direct.nands / 3);
    expect(rows[1].mults).toBe(8); expect(rows[1].nands).toBeLessThan(direct.nands); expect(rows[2].nands, 'constants in shifts and adders beat the general multipliers').toBeLessThan(rows[1].nands);
  });
});

describe('the drawings', () => {
  const reach = (root: ComponentDef): ComponentDef[] => {
    const seen = new Set<ComponentDef>(), visit = (d: ComponentDef) => { if (seen.has(d)) return; seen.add(d); for (const i of netlistOf(d)?.instances ?? []) visit(i.def); };
    visit(root);
    return [...seen].filter((d) => netlistOf(d));
  };
  it('no two nets on one line, no symbol on another, no label hiding one: the filter and everything inside it', () => {
    const defs = [...new Set([...reach(firMac(sceneMac().cfg)), ...reach(csdMultiplier(sceneMac().words[0], 16))])];
    for (const d of defs) {
      const nl = netlistOf(d)!;
      expect(wireOverlaps(routeNetlist(d, nl).nets), d.id).toEqual([]);
      expect(symbolOverlaps(nl), d.id).toEqual([]);
      expect(labelOverlaps(d, nl), d.id).toEqual([]);
    }
  }, 120000);
  it('the scene mask is the one the text states', () => { expect(SCENE_MASK.pass).toBe(0.1); expect(sceneMac().report.passRippleDb).toBeLessThan(1); });
});
