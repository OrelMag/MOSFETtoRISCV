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
  BUFFER_FANOUT, activityBand, activityOverlay, loadBand, loadOverlay, overlayRefusal, slackOverlay, unknownOverlay,
} from '../src/view/overlays';

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

  it('says which overlays a scene can show', () => {
    expect(overlayRefusal('activity', { level: 'gate', engine: 'cycle' })).toMatch(/cycle engine/);
    expect(overlayRefusal('slack', { level: 'gate', engine: 'cycle' })).toBe('');
    expect(overlayRefusal('slack', { level: 'switch' })).toMatch(/only Load and Unknown/);
    expect(overlayRefusal('load', { level: 'switch' })).toBe('');
    expect(overlayRefusal('unknown', { level: 'switch', engine: 'nmos' })).toMatch(/NMOS/);
  });
});
