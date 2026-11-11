// The overlay bar's quantities (view/overlays.ts) on a 4-bit adder, a counter and the single-cycle CPU, against values
// worked out by hand.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { rca } from '../src/lib/combinational';
import { counter } from '../src/lib/sequential';
import { singleCycleCpu } from '../src/lib/cpu';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { slackHeat, slackOf } from '../src/sim/slack';
import {
  BUFFER_FANOUT, activityBand, activityOverlay, costOverlay, depthBand, depthOverlay, energyOverlay, loadBand, loadOverlay, overlayRefusal, shareBand,
  slackOverlay, unknownOverlay,
} from '../src/view/overlays';
import { stats } from '../src/sim/stats';
import { timingGraph } from '../src/sim/timing';
import { driverOf, netCaps } from '../src/sim/netcap';

const netIndex = (def: ReturnType<typeof rca>, name: string) => def.netlist!().nets.findIndex((n) => n.name === name);

describe('overlays', () => {
  it('Slack is the heatmap, unchanged, with a count per band', () => {
    const d = flatten(rca(4));
    const o = slackOverlay(d, [], 'unit')!;
    const heat = slackHeat(slackOf(d)!, []);
    expect([...o.inst].map(([k, v]) => [k, v.band, v.tip])).toEqual([...heat].map(([k, v]) => [k, v.band, v.tip]));
    // a ripple adder: every full adder is on the longest path
    expect(['fa0', 'fa1', 'fa2', 'fa3'].map((n) => o.inst.get(n)!.band)).toEqual([0, 0, 0, 0]);
    expect(o.legend.rows[0].count).toBe('4 parts');
  });

  it('Activity on a counter: bit i changes C / 2^i times over C cycles, the clock twice a cycle, en never', () => {
    const def = counter(4), d = flatten(def), sim = new GateSim(d);
    sim.setInput('en', 1); sim.setInput('clk', 0); sim.reset('zero'); sim.settle();
    sim.countToggles();
    const base = new Uint32Array(sim.toggles!);
    const C = 16;
    for (let c = 0; c < C; c++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
    const o = activityOverlay(d.root, sim.toggles!, base, C, true);
    const at = (n: string) => o.net.get(netIndex(def, n))!;
    // q: (16 + 8 + 4 + 2) changes over 4 bits and 16 cycles
    expect(at('q').tip).toContain('0.47 changes per bit per clock');
    expect(at('q').band).toBe(activityBand(30 / 4 / 16));
    expect(at('q').band).toBe(2);
    expect(at('clk').tip).toContain('2.0 changes');
    expect(at('clk').band).toBe(0);
    expect(at('en').band).toBe(4);
    expect(o.legend.note).toContain('16 clocks');
  });

  it('Activity before anything ran says what to do', () => {
    const d = flatten(rca(4));
    const z = new Uint32Array(d.netCount);
    const o = activityOverlay(d.root, z, z, 0, false);
    expect(o.net.size).toBe(0);
    expect(o.legend.note).toContain('change an input');
  });

  it('Load: fan-out per wire, banded around the buffer threshold', () => {
    expect(BUFFER_FANOUT).toBeGreaterThan(1);
    expect(loadBand(1)).toBe(4);
    expect(loadBand(BUFFER_FANOUT)).toBe(2);
    expect(loadBand(4 * BUFFER_FANOUT + 1)).toBe(0);
    const def = rca(4), o = loadOverlay(flatten(def), flatten(def).root);
    // each bit of a feeds one full adder's two-NAND input stage (the 13-NAND full adder reads a twice), and an output pin counts one
    expect(o.net.get(netIndex(def, 's'))!.tip).toContain('drives 1 NAND input');
    expect(o.net.get(netIndex(def, 'a'))!.band).toBeGreaterThanOrEqual(3);
  });

  it('Unknown: b left unset on the adder; on the CPU at an X power-on the X starts at its storage', () => {
    const def = rca(4), d = flatten(def), sim = new GateSim(d);
    sim.setInput('a', 5); sim.setInput('cin', 0); sim.setInputBits('b', [2, 2, 2, 2]); sim.settle();
    const o = unknownOverlay(sim, d.root);
    expect(o.net.has(netIndex(def, 'b'))).toBe(true);
    expect(o.net.has(netIndex(def, 'a'))).toBe(false);
    expect(o.legend.rows.find((r) => r.count === 'an input left X')?.label).toBe('b');

    const fib = PROGRAMS.find((p) => p.id === 'fib') ?? PROGRAMS[0];
    const cpu = singleCycleCpu(assemble(fib.source).words), cd = flatten(cpu), cs = new GateSim(cd, { powerOn: 'x' } as never);
    cs.reset('x'); cs.settle();
    const co = unknownOverlay(cs, cd.root);
    const srcs = [...co.inst].filter(([, v]) => v.src).map(([k]) => k).sort();
    expect(srcs).toEqual(['dm', 'pc', 'rf']);
    expect(co.net.size).toBeGreaterThan(cpu.netlist!().nets.length / 2);
  }, 60000);

  it('Cost: each part’s NANDs as a share of the level, the shares adding up to the whole', () => {
    const def = rca(4), d = flatten(def), o = costOverlay(d.root, 'gate');
    const total = stats(def).nands;
    let sum = 0;
    for (const i of def.netlist!().instances) sum += stats(i.def).nands;
    expect(sum).toBe(total);
    // four equal full adders: a quarter each, the largest band
    expect(['fa0', 'fa1', 'fa2', 'fa3'].map((n) => o.inst.get(n)!.band)).toEqual([0, 0, 0, 0]);
    expect(o.inst.get('fa0')!.tip).toBe(`fa0: ${stats(def.netlist!().instances.find((i) => i.name === 'fa0')!.def).nands} NANDs, 25 % of this level`);
    expect(o.legend.unit).toBe(`share of this level's ${total} NANDs`);
    // the CPU: shares of every costing part add up to 100 %
    const cpu = singleCycleCpu(assemble(PROGRAMS[0].source).words), cd = flatten(cpu);
    const co = costOverlay(cd.root, 'gate');
    const pct = [...co.inst.values()].reduce((a, m) => a + Number(/, ([\d.]+) % of this level/.exec(m.tip)![1]), 0);
    expect(pct).toBeGreaterThan(97);
    expect(pct).toBeLessThan(103);
    expect(co.inst.get('rf')!.band).toBe(0);
    expect([shareBand(0.3), shareBand(0.1), shareBand(0.05), shareBand(0.02), shareBand(0.001)]).toEqual([0, 1, 2, 3, 4]);
  }, 60000);

  it('Depth: each part\'s latest output arrival, the timing graph\'s; the last full adder ends the longest path', () => {
    const def = rca(4), d = flatten(def), o = depthOverlay(d, d.root, 'unit');
    const g = timingGraph(d, { delay: 'unit', outputs: true }), s = slackOf(d)!;
    for (const [name, ch] of d.root.children!) {
      const outs = ch.def.ports.filter((p) => p.dir === 'out').flatMap((p) => ch.ports[p.name]);
      const worst = Math.max(...outs.map((n) => g.arr(n)));
      expect(o.inst.get(name)!.tip).toContain(`settles ${Math.round(worst)} NAND delays after the inputs change`);
      expect(o.inst.get(name)!.band).toBe(depthBand(worst / s.period));
    }
    expect(o.inst.get('fa3')!.band).toBe(0);
    expect(o.inst.get('fa0')!.band).toBeGreaterThan(0);
    // a counter is clocked: arrivals count from the edge
    const cd = flatten(counter(4)), co = depthOverlay(cd, cd.root, 'unit');
    expect([...co.inst.values()].every((m) => m.tip.includes('after the clock edge'))).toBe(true);
  });

  it('Energy: C × toggles of the nets each part drives, as power.ts charges them; nothing before a cycle', () => {
    const def = counter(4), d = flatten(def), sim = new GateSim(d);
    sim.setInput('en', 1); sim.setInput('clk', 0); sim.reset('zero'); sim.settle();
    sim.countToggles();
    const base = new Uint32Array(sim.toggles!);
    expect(energyOverlay(d, d.root, sim.toggles!, base, 0, true).inst.size).toBe(0);
    for (let c = 0; c < 8; c++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
    const o = energyOverlay(d, d.root, sim.toggles!, base, 8, true);
    // by hand: every net's C × toggles charged to the part driving it at this level
    const caps = netCaps(d), dr = driverOf(d), by = new Map<string, number>();
    for (let i = 0; i < caps.length; i++) {
      const t = sim.toggles![i] - base[i];
      if (t > 0 && dr[i] >= 0) { const p = d.leaves[dr[i]].node.path[0]; by.set(p, (by.get(p) ?? 0) + t * caps[i]); }
    }
    const all = [...by.values()].reduce((a, b) => a + b, 0);
    expect(o.inst.size).toBe(by.size);
    for (const [n, sw] of by) expect(o.inst.get(n)!.band).toBe(shareBand(sw / all));
    expect(o.legend.note).toMatch(/over the last 8 clock cycles/);
  });

  it('says which overlays a scene can show', () => {
    expect(overlayRefusal('activity', { level: 'gate', engine: 'cycle' })).toMatch(/cycle engine/);
    expect(overlayRefusal('slack', { level: 'gate', engine: 'cycle' })).toBe('');
    expect(overlayRefusal('slack', { level: 'switch' })).toMatch(/only Load, Unknown and Cost/);
    expect(overlayRefusal('energy', { level: 'gate', engine: 'cycle' })).toMatch(/cycle engine/);
    expect(overlayRefusal('energy', { level: 'gate', sub: true })).toMatch(/simulation of its own/);
    expect(overlayRefusal('energy', { level: 'switch' })).toMatch(/switch-level/);
    expect(overlayRefusal('depth', { level: 'switch' })).toMatch(/switch-level/);
    expect(overlayRefusal('depth', { level: 'gate', engine: 'cycle' })).toBe('');
    expect(overlayRefusal('cost', { level: 'switch' })).toBe('');
    expect(overlayRefusal('cost', { level: 'gate', engine: 'cycle' })).toBe('');
    expect(overlayRefusal('cost', { level: 'gate', engine: 'nmos' })).toMatch(/NMOS/);
    expect(overlayRefusal('load', { level: 'switch' })).toBe('');
    expect(overlayRefusal('unknown', { level: 'switch', engine: 'nmos' })).toMatch(/NMOS/);
  });
});

describe('O / Shift O', () => {
  it('cycles through the overlays that apply, from the last one used; Shift O turns it off', async () => {
    const { nextOverlay } = await import('../src/view/overlaybar');
    const none = {};
    expect(nextOverlay('slack', none, false)).toBe('activity');
    expect(nextOverlay('unknown', none, false)).toBe('cost');
    expect(nextOverlay('depth', none, false)).toBe('slack');
    expect(nextOverlay('slack', none, true)).toBe(null);
    // a switch-level scene: Slack and Activity do not apply
    const sw = { slack: 'x', activity: 'x', energy: 'x', depth: 'x' };
    expect(nextOverlay('load', sw, false)).toBe('unknown');
    expect(nextOverlay('unknown', sw, false)).toBe('cost');
    expect(nextOverlay('cost', sw, false)).toBe('load');
    expect(['load', 'unknown', 'cost']).toContain(nextOverlay(null, sw, false));
    expect(nextOverlay(null, { slack: 'x', activity: 'x', load: 'x', unknown: 'x', cost: 'x', energy: 'x', depth: 'x' }, false)).toBe(null);
  });
});
