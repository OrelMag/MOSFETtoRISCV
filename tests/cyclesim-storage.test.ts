// Storage the cycle engine recognizes by its structure (clusters.ts): the sequential library with
// asynchronous resets and toggles, flip-flops drawn from NANDs in the sandbox (with and without the
// flip-flop mark), clocks through inverters (a register file written at the falling edge, as in the
// campaign's pipelines), a campaign core run on its bench; and the refusals (a ring oscillator, an
// SR latch race, a latch with a glitchy enable, gated and ripple clocks), which stay on GateSim and
// say why. Every net equal to GateSim after every settle.

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { solveChallenge } from '../src/editor/challenges';
import { CHALLENGES } from '../src/editor/challengeset';
import { Rv16Monitor } from '../src/editor/cpu16';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { AND, NOT } from '../src/lib/gates';
import { clockDivider, cycleCounter, D_LATCH_R, DFF_R, JKFF, lfsr, randomSource, ringCounter, shiftRegister, TFF, upDownCounter } from '../src/lib/seqparts';
import { D_LATCH, DFF, SR_LATCH } from '../src/lib/sequential';
import { NAND, TIE1 } from '../src/lib/transistors';
import { CycleSim } from '../src/sim/cyclesim';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { Sim } from '../src/sim/sim';
import type { ComponentDef, PortDef } from '../src/sim/types';
import { lockstep, pair, rng, sameNets } from './cyclekit';
import { breathe } from './setup';

afterEach(() => vi.restoreAllMocks());

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const top = (id: string, ports: PortDef[], netlist: ComponentDef['netlist']): ComponentDef => ({ id, name: id, category: 'custom', ports, symbol: { kind: 'box' }, netlist });
const built = (def: ComponentDef) => CycleSim.build(flatten(def));
const reason = (def: ComponentDef) => {
  const r = built(def);
  return r instanceof CycleSim ? '' : r.reason;
};

describe('the sequential library on the cycle engine ≡ GateSim', () => {
  it('latches and flip-flops with an asynchronous reset, T and JK flip-flops, an SR latch', async () => {
    for (const [def, clk, seed] of [[D_LATCH_R, 'e', 1], [DFF_R, 'clk', 2], [TFF, 'clk', 3], [JKFF, 'clk', 4], [D_LATCH, 'e', 5], [SR_LATCH, 'none', 6], [DFF, 'clk', 7]] as const) {
      expect(built(def), def.id).toBeInstanceOf(CycleSim);
      const share = lockstep(def, 90, seed, ['zero', 'x', 'random'], true, clk);
      expect(share, def.id).toBeGreaterThan(0.4);
      await breathe();
    }
  });

  it('counters, shift registers, LFSRs, ring and Johnson counters', async () => {
    for (const [def, seed] of [[upDownCounter(4), 11], [shiftRegister(4), 12], [lfsr(8), 13], [randomSource(8), 14], [cycleCounter(6), 15], [ringCounter(4), 16], [ringCounter(4, true), 17]] as const) {
      expect(built(def), def.id).toBeInstanceOf(CycleSim);
      expect(lockstep(def, 80, seed, ['zero', 'x'])).toBeGreaterThan(0.5);
      await breathe();
    }
  });

  it('a synchronous counter of T flip-flops with an asynchronous reset pin', () => {
    const def = top('t_tcount', [bit('clk', 'in'), bit('rst_n', 'in'), bit('q0', 'out'), bit('q1', 'out'), bit('q2', 'out')], () => ({
      instances: [{ name: 'one', def: TIE1 }, { name: 't0', def: TFF }, { name: 't1', def: TFF }, { name: 't2', def: TFF }, { name: 'a', def: AND }],
      nets: [
        { ends: ['one.y', 't0.t'] }, { ends: ['clk', 't0.clk', 't1.clk', 't2.clk'] }, { ends: ['rst_n', 't0.rst_n', 't1.rst_n', 't2.rst_n'] },
        { ends: ['t0.q', 't1.t', 'a.a', 'q0'] }, { ends: ['t1.q', 'a.b', 'q1'] }, { ends: ['a.y', 't2.t'] }, { ends: ['t2.q', 'q2'] },
      ],
    }));
    expect(built(def)).toBeInstanceOf(CycleSim);
    expect(lockstep(def, 150, 21)).toBeGreaterThan(0.5);
  });
});

// ---- flip-flops drawn in the sandbox ------------------------------------------------------------

/** The sandbox's D flip-flop answer (master–slave, nine NANDs, in two latch chips) and a register of n of them. */
function userRegister(n: number, marked: boolean): { ws: Workspace; id: string } {
  const ch = CHALLENGES.find((c) => c.id === 's_dff')!;
  const solved = solveChallenge(emptyWorkspace(), ch);
  const ffId = solved.chipId;
  const ff = solved.ws.chips[ffId];
  expect(ff.ff).toBeDefined();
  const ffDoc: ChipDoc = marked ? ff : (({ ff: _ff, ...rest }) => rest)(ff);
  const pin = (name: string, dir: 'in' | 'out', width = 1) => ({ id: name, name, dir, width, at: [0, 0] as [number, number] });
  const end = (s: string) => (s.startsWith('pin:') ? { pin: s.slice(4) } : { part: s.split('.')[0], port: s.split('.')[1] });
  const wires = [['pin:d', 'sd.in'], ['mq.out', 'pin:q']];
  for (let i = 0; i < n; i++) wires.push([`sd.o${i}`, `f${i}.d`], ['pin:clk', `f${i}.clk`], [`f${i}.q`, `mq.i${i}`]);
  const reg: ChipDoc = {
    id: 'u_userreg', name: 'Register', labels: [],
    pins: [pin('d', 'in', n), { ...pin('clk', 'in'), kind: 'clock' }, pin('q', 'out', n)],
    parts: [
      { id: 'sd', ref: { split: Array(n).fill(1) }, at: [4, 0] }, { id: 'mq', ref: { merge: Array(n).fill(1) }, at: [40, 0] },
      ...Array.from({ length: n }, (_, i) => ({ id: `f${i}`, ref: { chip: ffId }, at: [20, 4 * i] as [number, number] })),
    ],
    wires: wires.map(([a, b], i) => ({ id: `w${i}`, a: end(a), b: end(b), pts: [] })),
  };
  return { ws: { ...solved.ws, chips: { ...solved.ws.chips, [ffId]: ffDoc, [reg.id]: reg } }, id: reg.id };
}

describe('flip-flops drawn from NANDs in the sandbox', () => {
  for (const marked of [true, false]) {
    it(`a register of 32 drawn D flip-flops, ${marked ? 'marked' : 'not marked'} as flip-flops`, () => {
      const { ws, id } = userRegister(32, marked);
      const c = new UserLibrary(ws).compiled(id)!;
      expect(c.diags.filter((x) => x.level === 'error')).toEqual([]);
      const d = flatten(c.def);
      const r = CycleSim.build(d);
      expect(r).toBeInstanceOf(CycleSim);
      expect((r as CycleSim).stats.flipFlops).toBe(32);
      expect((r as CycleSim).stats.gates).toBe(0);
      expect(lockstep(d, 120, marked ? 31 : 32)).toBeGreaterThan(0.6);
    });
  }

  it('carried across a rebuild, and under EditorSim', () => {
    const { ws, id } = userRegister(8, false);
    const lib = new UserLibrary(ws);
    const d = flatten(lib.compiled(id)!.def);
    const { dual, ref } = pair(d, 'zero');
    const both = (f: (s: Sim) => void) => { f(dual); f(ref); };
    for (let i = 0; i < 6; i++) {
      both((s) => { s.setInput('d', (i * 37) & 255); s.settle(); });
      for (const v of [1, 0]) both((s) => { s.setInput('clk', v); s.settle(); });
    }
    expect(dual.engine).toBe('cycle');
    const d2 = flatten(lib.compiled(id)!.def);
    const a = new DualSim(d2), b = new GateSim(d2);
    a.carry(dual, { known: true });
    b.carry(ref, { known: true });
    sameNets(a, b, 'carried');
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled(id)!, ws.chips[id].pins);
    es.runCycles(10);
    expect(es.engine).toBe('cycle');
  });
});

// ---- clocks through inverters -------------------------------------------------------------------

describe('clocks through inverters', () => {
  /**
   * A flip-flop at the rising edge feeding one at the falling edge (its clock a NOT of clk), a pin
   * straight into another (the table schedules both), and a NAND of two pins into a third, which a
   * pin reads too (shared logic, outside the table: one delay, as soon as the third's clock).
   */
  const def = top('t_negedge', [bit('clk', 'in'), bit('d', 'in'), bit('e', 'in'), bit('f', 'in'), bit('u', 'in'), bit('q', 'out'), bit('r', 'out'), bit('s', 'out'), bit('t', 'out')], () => ({
    instances: [{ name: 'inv', def: NOT }, { name: 'a', def: DFF }, { name: 'b', def: DFF }, { name: 'c', def: DFF }, { name: 'g', def: NAND }, { name: 'h', def: DFF }, { name: 'k', def: NOT }],
    nets: [
      { ends: ['clk', 'inv.a', 'a.clk'] }, { ends: ['inv.y', 'b.clk', 'c.clk', 'h.clk'] }, { ends: ['d', 'a.d'] },
      { ends: ['a.q', 'b.d'] }, { ends: ['b.q', 'q'] }, { ends: ['e', 'c.d'] }, { ends: ['u', 'g.a'] }, { ends: ['c.q', 'r'] },
      { ends: ['f', 'g.b'] }, { ends: ['g.y', 'h.d', 'k.a'] }, { ends: ['h.q', 's'] }, { ends: ['k.y', 't'] },
    ],
  }));

  it('flip-flops clocked by the inverted pin run on the cycle engine; a pin changing with the clock goes to GateSim', () => {
    expect(built(def)).toBeInstanceOf(CycleSim);
    expect(lockstep(def, 200, 41)).toBeGreaterThan(0.4);
    const { dual, ref } = pair(def, 'zero');
    const both = (fn: (s: Sim) => void) => { fn(dual); fn(ref); };
    for (const v of [1, 0, 1]) both((s) => { s.setInput('clk', v); s.settle(); });
    expect(dual.engine).toBe('cycle');
    // e with the clock: c sees it at once, its clock one NOT later, as its table schedules them
    both((s) => { s.setInput('e', 1); s.setInput('clk', 0); s.settle(); });
    expect(dual.engine).toBe('cycle');
    sameNets(dual, ref, 'e with clk');
    both((s) => { s.setInput('f', 1); s.settle(); });
    for (const v of [1, 0, 1]) both((s) => { s.setInput('clk', v); s.settle(); });
    // f with the clock: through the NAND it reaches h.d as soon as h's clock does: GateSim's
    both((s) => { s.setInput('f', 0); s.setInput('clk', 0); s.settle(); });
    expect(dual.whyNot).toMatch(/shorter path/);
    sameNets(dual, ref, 'f with clk');
  });
});

// ---- a campaign core ----------------------------------------------------------------------------

describe('a campaign core from its reference answers', { timeout: 120000 }, () => {
  it('the five-stage pipeline (register file at the falling edge) runs its bench on the cycle engine, write for write', async () => {
    const { addBench } = await import('../src/campaign/bench');
    const { coreSpecOf } = await import('../src/campaign/corecheck');
    const ch = levelChallenge(nodeById('pi_core3')!)!;
    const spec = coreSpecOf(ch.check)!;
    const coreDoc = ch.answer().at(-1)!;
    let ws: Workspace = { ...emptyWorkspace(), chips: { [coreDoc.id]: coreDoc } };
    const core = new UserLibrary(ws).compiled(coreDoc.id)!.def;
    const t = spec.tests()[0];
    const r = addBench(ws, core, coreDoc.id, t);
    if ('error' in r) throw new Error(r.error);
    ws = r.ws;
    const doc = ws.chips[r.id];
    const lib = new UserLibrary(ws);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled(r.id)!, doc.pins);
    const m = new Rv16Monitor(es, () => doc, () => ws.chips);
    expect(m.checking).toBe(true);
    m.runToHalt(Infinity, 3000);
    expect(es.engine).toBe('cycle');
    expect((es.sim as DualSim).whyNot).toBe('');
    expect(m.mismatch).toBeNull();
    expect(m.done).toBe(true);
    expect(m.retired).toBeGreaterThan(10);
    // and every net, edge by edge, against GateSim
    const d = flatten(lib.compiled(r.id)!.def);
    const { dual, ref } = pair(d, 'zero');
    const clk = d.root.def.ports.find((p) => p.clock)!.name;
    for (let c = 0; c < 60; c++) {
      for (const v of [1, 0]) {
        for (const s of [dual, ref]) { s.setInput(clk, v); s.settle(); }
        expect(dual.engine).toBe('cycle');
        sameNets(dual, ref, `cycle ${c} clk ${v}`);
      }
      if (c % 10 === 9) await breathe();
    }
  });
});

// ---- refusals -----------------------------------------------------------------------------------

describe('what stays on GateSim, and why', () => {
  it('a ring oscillator: the cycle engine refuses the change that starts it', () => {
    const def = top('t_ring', [bit('en', 'in'), bit('y', 'out')], () => ({
      instances: [{ name: 'g', def: NAND }, { name: 'n1', def: NOT }, { name: 'n2', def: NOT }],
      nets: [{ ends: ['en', 'g.a'] }, { ends: ['g.y', 'n1.a'] }, { ends: ['n1.y', 'n2.a'] }, { ends: ['n2.y', 'g.b', 'y'] }],
    }));
    expect(built(def)).toBeInstanceOf(CycleSim);
    const { dual, ref } = pair(def, 'zero');
    expect(dual.engine).toBe('cycle');
    for (const s of [dual, ref]) { s.setInput('en', 1); s.settle(); }
    expect(dual.engine).toBe('gate');
    expect(dual.whyNot).toMatch(/settle|oscillat/);
    sameNets(dual, ref, 'oscillating');
  });

  it('an SR latch released from both inputs at once: a race, GateSim\'s', () => {
    const { dual, ref } = pair(SR_LATCH, 'zero');
    const both = (f: (s: Sim) => void) => { f(dual); f(ref); };
    both((s) => { s.setInput('s_n', 1); s.setInput('r_n', 1); s.settle(); });
    both((s) => { s.setInput('s_n', 0); s.settle(); });
    both((s) => { s.setInput('s_n', 1); s.settle(); });
    expect(dual.engine).toBe('cycle');
    both((s) => { s.setInput('s_n', 0); s.setInput('r_n', 0); s.settle(); });
    both((s) => { s.setInput('s_n', 1); s.setInput('r_n', 1); s.settle(); });
    expect(dual.whyNot).toMatch(/race|oscillat|settle/);
    sameNets(dual, ref, 'released together');
    both((s) => { s.setInput('r_n', 0); s.settle(); });
    sameNets(dual, ref, 'after');
  });

  /** A latch enabled by AND(a, NOT a): a pulse when a rises. shared: the AND's output also drives a pin through a NOT. */
  const glitchy = (shared: boolean) => top(`t_glitch${shared ? '_s' : ''}`, [bit('d', 'in'), bit('a', 'in'), bit('q', 'out'), ...(shared ? [bit('z', 'out')] : [])], () => ({
    instances: [{ name: 'n', def: NOT }, { name: 'g', def: AND }, { name: 'l', def: D_LATCH }, ...(shared ? [{ name: 'm', def: NOT }] : [])],
    nets: [
      { ends: ['a', 'n.a', 'g.a'] }, { ends: ['n.y', 'g.b'] }, { ends: ['g.y', 'l.e', ...(shared ? ['m.a'] : [])] }, { ends: ['d', 'l.d'] }, { ends: ['l.q', 'q'] },
      ...(shared ? [{ ends: ['m.y', 'z'] }] : []),
    ],
  }));
  const poke = (def: ComponentDef) => {
    const { dual, ref } = pair(def, 'zero');
    const rnd = rng(51);
    for (let k = 0; k < 40; k++) {
      const p = rnd() < 0.5 ? 'a' : 'd', v = rnd() < 0.5 ? 1 : 0;
      for (const s of [dual, ref]) { s.setInput(p, v); s.settle(); }
      sameNets(dual, ref, `${def.id} op ${k}`);
    }
    return dual;
  };

  it('a latch whose enable is a glitch of logic only it reads: the pulse is inside its table, exactly', () => {
    expect(built(glitchy(false))).toBeInstanceOf(CycleSim);
    expect(poke(glitchy(false)).engine).toBe('cycle');
  });

  it('a latch enabled by shared logic: refused where a pulse on its enable would show', () => {
    const def = glitchy(true);
    expect(built(def)).toBeInstanceOf(CycleSim);
    const { dual } = pair(def, 'zero');
    // d changing as e pulses would be caught: the power-on state is refused already
    expect(dual.engine).toBe('gate');
    expect(dual.whyNot).toMatch(/^l: a glitch on e /);
    poke(def);
  });

  it('gated and ripple clocks are refused when the design is built, naming the clock', () => {
    const gated = top('t_gated2', [bit('clk', 'in'), bit('en', 'in'), bit('d', 'in'), bit('q', 'out')], () => ({
      instances: [{ name: 'g', def: AND }, { name: 'f', def: DFF }],
      nets: [{ ends: ['clk', 'g.a'] }, { ends: ['en', 'g.b'] }, { ends: ['g.y', 'f.clk'] }, { ends: ['d', 'f.d'] }, { ends: ['f.q', 'q'] }],
    }));
    expect(reason(gated)).toMatch(/^f: its clock clk is made by logic/);
    expect(reason(clockDivider(3))).toMatch(/^t1\.ff: its clock clk comes from the flip-flop t0\.ff \(a ripple clock\)/);
    // DualSim stays on GateSim for them, and is GateSim
    expect(lockstep(gated, 60, 61, ['zero'])).toBe(0);
    expect(lockstep(clockDivider(3), 60, 62, ['zero'])).toBe(0);
  });
});
