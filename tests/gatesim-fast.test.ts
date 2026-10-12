// The typed-array GateSim against the object-based version it replaced (tests/ref/gatesim-ref.ts):
// the same changes on every net at the same times, the same values, evaluations, time and unstable
// flag after every operation, the same power-on in every mode (Math.random seeded), the same
// relaxation of races and oscillations, the same saved / restored and carried state.

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib';
import { singleCycleCpu } from '../src/lib/cpu';
import { NOT } from '../src/lib/gates';
import { NAND } from '../src/lib/transistors';
import { ram } from '../src/lib/memory';
import { lfsr, shiftRegister, upDownCounter } from '../src/lib/seqparts';
import { counter, SR_LATCH } from '../src/lib/sequential';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { PowerOnMode, Sim } from '../src/sim/sim';
import type { ComponentDef, PortDef } from '../src/sim/types';
import { RefGateSim } from './ref/gatesim-ref';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });

/** A deterministic Math.random for both simulations (power-on 'random'). */
function seedRandom(seed: number): void {
  let s = seed >>> 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32));
}
afterEach(() => vi.restoreAllMocks());

/** Every change of every net, as a running hash plus a count (the CPU makes too many to keep). */
function tracer(sim: Sim): { h: number; n: number } {
  const t = { h: 0, n: 0 };
  sim.watch(Array.from({ length: sim.design.netCount }, (_, i) => i));
  sim.onTrace = (net, v, time) => {
    t.h = (Math.imul(t.h, 31) + net * 7 + v * 3 + time) | 0;
    t.n++;
  };
  return t;
}

function same(a: Sim, b: Sim, ta: { h: number; n: number }, tb: { h: number; n: number }, at: string): void {
  const all = Array.from({ length: a.design.netCount }, (_, i) => i);
  expect(a.getBits(all), `${at}: values`).toEqual(b.getBits(all));
  expect([a.time, a.unstable, a.evaluations, a.busy(), ta.n, ta.h], `${at}: time, unstable, evaluations, busy, trace`)
    .toEqual([b.time, b.unstable, b.evaluations, b.busy(), tb.n, tb.h]);
}

/** Both engines on one design, driven alike: random inputs, settle / step / runUntil, save / restore. */
function lockstep(def: ComponentDef, ops: number, seed: number, modes: PowerOnMode[] = ['zero', 'x', 'random']): number {
  const d = flatten(def);
  let unstable = 0;
  let r = seed >>> 0;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (const mode of modes) {
    seedRandom(seed);
    const a = new GateSim(d);
    seedRandom(seed);
    const b = new RefGateSim(d);
    seedRandom(seed + 1);
    a.reset(mode);
    seedRandom(seed + 1);
    b.reset(mode);
    const ta = tracer(a), tb = tracer(b);
    same(a, b, ta, tb, `${def.id} ${mode} power-on`);
    const ins = d.root.def.ports.filter((p) => p.dir === 'in');
    let saved: [ReturnType<Sim['saveState']>, ReturnType<Sim['saveState']>] | null = null;
    for (let k = 0; k < ops; k++) {
      const op = rnd();
      if (op < 0.15) {
        // every input at once (an SR latch released 1 / 1 races)
        for (const p of ins) {
          const v = Math.floor(rnd() * 2 ** Math.min(p.width, 30));
          a.setInput(p.name, v);
          b.setInput(p.name, v);
        }
      } else if (op < 0.5) {
        const p = ins[Math.floor(rnd() * ins.length)];
        const clk = p.name === 'clk';
        const v = clk ? 1 - a.getInput('clk') : Math.floor(rnd() * 2 ** Math.min(p.width, 30));
        if (rnd() < 0.1 && !clk) {
          const bits = Array.from({ length: p.width }, () => (rnd() < 0.2 ? 2 : rnd() < 0.5 ? 1 : 0));
          a.setInputBits(p.name, bits);
          b.setInputBits(p.name, bits);
        } else {
          a.setInput(p.name, v);
          b.setInput(p.name, v);
        }
      }
      const how = rnd();
      if (how < 0.6) { a.settle(); b.settle(); }
      else if (how < 0.8) { const t = a.time + 1 + Math.floor(rnd() * 6); a.runUntil(t); b.runUntil(t); }
      else { a.step(); b.step(); }
      if (rnd() < 0.05) {
        if (saved && rnd() < 0.5) {
          a.restoreState(saved[0]);
          b.restoreState(saved[1]);
        } else saved = [a.saveState(), b.saveState()];
      }
      same(a, b, ta, tb, `${def.id} ${mode} op ${k}`);
      if (a.unstable) unstable++;
    }
    // a rebuild carrying the state over (known values only, as the sandbox does)
    const a2 = new GateSim(d), b2 = new RefGateSim(d);
    a2.carry(a, { known: true });
    b2.carry(b, { known: true });
    same(a2, b2, { h: 0, n: 0 }, { h: 0, n: 0 }, `${def.id} ${mode} carried`);
  }
  return unstable;
}

describe('GateSim (typed arrays) ≡ the reference GateSim', () => {
  it('sequential parts: counters, shift register, LFSR, RAM', () => {
    lockstep(counter(4), 120, 1);
    lockstep(upDownCounter(4), 120, 2);
    lockstep(shiftRegister(4), 120, 3);
    lockstep(lfsr(8), 120, 4);
    lockstep(ram(2, 3), 120, 5);
  });

  it('an SR latch released 1 / 1 (a race relax() resolves) and a ring oscillator (unstable)', () => {
    expect(lockstep(SR_LATCH, 60, 6)).toBeGreaterThan(0);
    const ring: ComponentDef = {
      id: 't_ring3', name: 'ring', category: 'gate', ports: [bit('en', 'in'), bit('y', 'out')], symbol: { kind: 'box' },
      netlist: () => ({
        instances: [{ name: 'n0', def: NAND }, { name: 'n1', def: NOT }, { name: 'n2', def: NOT }],
        nets: [{ ends: ['en', 'n0.a'] }, { ends: ['n0.y', 'n1.a'] }, { ends: ['n1.y', 'n2.a'] }, { ends: ['n2.y', 'n0.b', 'y'] }],
      }),
    };
    expect(lockstep(ring, 40, 7)).toBeGreaterThan(0);
  });

  it('behavioural leaves: a stateful one poked from outside, and a slow one (delay 5)', () => {
    const acc: ComponentDef = {
      id: 't_acc', name: 'acc', category: 'gate', ports: [{ name: 'a', width: 4, dir: 'in' }, { name: 'y', width: 4, dir: 'out' }], symbol: { kind: 'box' },
      behavior: { delay: 5, init: () => ({ k: 3 }), eval: ([a], s) => [a < 0 ? -1 : (a + (s as { k: number }).k) & 15] },
    };
    const top: ComponentDef = {
      id: 't_acc_top', name: 'top', category: 'gate', ports: [{ name: 'a', width: 4, dir: 'in' }, { name: 'y', width: 4, dir: 'out' }], symbol: { kind: 'box' },
      netlist: () => ({ instances: [{ name: 'b', def: acc }, { name: 'c', def: acc }], nets: [{ ends: ['a', 'b.a'] }, { ends: ['b.y', 'c.a'] }, { ends: ['c.y', 'y'] }] }),
    };
    lockstep(top, 80, 8);
    const d = flatten(top);
    const a = new GateSim(d), b = new RefGateSim(d);
    for (const s of [a, b]) {
      s.setInput('a', 2);
      s.settle();
      s.poke(0, { k: 9 });
      s.settle();
    }
    expect(a.getBits(d.root.ports.y)).toEqual(b.getBits(d.root.ports.y));
    expect(a.leafState(0)).toEqual({ k: 9 });
  });

  it('the single-cycle CPU running a program: every change of every net, at the same time', () => {
    const d = flatten(singleCycleCpu(assemble(PROGRAMS.find((p) => p.id === 'sum')!.source).words));
    const a = new GateSim(d), b = new RefGateSim(d);
    const ta = tracer(a), tb = tracer(b);
    for (let c = 0; c < 24; c++) {
      for (const v of [1, 0]) {
        a.setInput('clk', v);
        b.setInput('clk', v);
        a.settle();
        b.settle();
      }
      expect([a.time, a.evaluations, ta.n, ta.h], `cycle ${c}`).toEqual([b.time, b.evaluations, tb.n, tb.h]);
    }
    same(a, b, ta, tb, 'cpu');
  }, 60000);
});
