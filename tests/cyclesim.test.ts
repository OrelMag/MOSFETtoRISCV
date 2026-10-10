// The cycle engine (CycleSim, FfTable) and DualSim against GateSim: every net equal after every
// settle, on sequential parts, the three CPUs running random programs, designs with stateful and
// poked behavioural leaves; and the fall-backs (loops, derived clocks, X clocks, a latch passed off
// as a flip-flop), where DualSim keeps or hands the work to GateSim and stays equal.

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib';
import { bigRam } from '../src/lib/bigmem';
import { incrementer } from '../src/lib/combinational';
import { KEYBOARD, keyPart } from '../src/editor/parts';
import { singleCycleCpu } from '../src/lib/cpu';
import { splitter } from '../src/lib/define';
import { NOT } from '../src/lib/gates';
import { ram } from '../src/lib/memory';
import { pipelinedCpu } from '../src/lib/pipeline';
import { lfsr, shiftRegister, upDownCounter } from '../src/lib/seqparts';
import { counter, D_LATCH, DFF, DFFE, register, SR_LATCH } from '../src/lib/sequential';
import { systemCpu } from '../src/lib/system';
import { TIE1 } from '../src/lib/transistors';
import { assemble } from '../src/riscv/asm';
import { CycleSim } from '../src/sim/cyclesim';
import { DualSim } from '../src/sim/dualsim';
import { FfTable } from '../src/sim/ffmacro';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { PowerOnMode, Sim } from '../src/sim/sim';
import type { ComponentDef, PortDef } from '../src/sim/types';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

function rng(seed: number): () => number {
  let r = seed >>> 0;
  return () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function seedRandom(seed: number): void {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(r);
}
afterEach(() => vi.restoreAllMocks());

/** Every net of a and b equal (the cycle engine reads flip-flop insides from its tables). */
function sameNets(a: Sim, b: Sim, at: string): void {
  const n = a.design.netCount;
  for (let net = 0; net < n; net++) {
    if (a.get(net) !== b.get(net)) expect.fail(`${at}: net ${net} is ${a.get(net)} on the cycle engine, ${b.get(net)} on GateSim`);
  }
}

/** A DualSim allowed to use the cycle engine, next to a GateSim, both powered on alike. */
function pair(def: ComponentDef, mode: PowerOnMode, seed = 1): { dual: DualSim; ref: GateSim } {
  const d = flatten(def);
  const dual = new DualSim(d), ref = new GateSim(d);
  seedRandom(seed);
  dual.reset(mode);
  seedRandom(seed);
  ref.reset(mode);
  vi.restoreAllMocks();
  dual.preferFast = true;
  dual.prepare();
  return { dual, ref };
}

/**
 * Random stimulus on both: data inputs (sometimes X, sometimes all at once with the clock), clock
 * toggles (sometimes X), save / restore, a trace listener on and off. Returns the share of settles
 * the cycle engine did.
 */
function lockstep(def: ComponentDef, ops: number, seed: number, modes: PowerOnMode[] = ['zero', 'x', 'random'], xClock = true): number {
  let fast = 0, total = 0;
  for (const mode of modes) {
    const { dual, ref } = pair(def, mode, seed);
    sameNets(dual, ref, `${def.id} ${mode} power-on`);
    const rnd = rng(seed * 7 + 1);
    const ins = def.ports.filter((p) => p.dir === 'in');
    const clk = ins.find((p) => p.name === 'clk');
    const data = ins.filter((p) => p !== clk);
    let saved: [ReturnType<Sim['saveState']>, ReturnType<Sim['saveState']>] | null = null;
    const both = (f: (s: Sim) => void) => { f(dual); f(ref); };
    for (let k = 0; k < ops; k++) {
      const r = rnd();
      const value = (p: PortDef) => Math.floor(rnd() * 2 ** Math.min(p.width, 30));
      if (r < 0.45 && clk) both((s) => s.setInput('clk', 1 - Math.max(0, s.getInput('clk'))));
      else if (r < 0.75 && data.length) {
        const p = data[Math.floor(rnd() * data.length)];
        if (rnd() < 0.1) {
          const bits = Array.from({ length: p.width }, () => (rnd() < 0.3 ? 2 : rnd() < 0.5 ? 1 : 0));
          both((s) => s.setInputBits(p.name, bits));
        } else {
          const v = value(p);
          both((s) => s.setInput(p.name, v));
        }
      } else if (r < 0.85) {
        // everything at once, the clock too
        const vs = data.map(value);
        const c = rnd() < 0.5 ? 1 : 0;
        both((s) => { data.forEach((p, i) => s.setInput(p.name, vs[i])); if (clk) s.setInput('clk', c); });
      } else if (r < 0.88 && clk && xClock) both((s) => s.setInputBits('clk', [2]));
      else if (r < 0.93) {
        if (saved && rnd() < 0.5) { dual.restoreState(saved[0]); ref.restoreState(saved[1]); } else saved = [dual.saveState(), ref.saveState()];
      }
      // now and then a trace listener for one settle: GateSim takes over, gives back after
      const traced = r >= 0.93 && r < 0.95;
      if (traced) dual.onTrace = () => {};
      if (dual.engine === 'cycle') fast++;
      total++;
      both((s) => s.settle());
      if (traced) dual.onTrace = undefined;
      sameNets(dual, ref, `${def.id} ${mode} op ${k}`);
    }
  }
  return fast / total;
}

describe('FfTable', () => {
  it('tabulates the library flip-flops from their power-on states, and refuses a latch', () => {
    for (const def of [DFF, DFFE]) {
      const t = FfTable.of(def)!;
      expect(t, def.id).not.toBeNull();
      for (const mode of ['zero', 'x'] as const) {
        const g = new GateSim(t.flat);
        g.reset(mode);
        const id = t.intern(Uint8Array.from({ length: t.flat.netCount }, (_, i) => g.get(i)));
        expect(id).toBeGreaterThanOrEqual(0);
        expect(t.good(id), `${def.id} ${mode}`).toBe(true);
      }
    }
    // A transparent latch marked as a flip-flop: its output follows d while e = 1.
    const fake: ComponentDef = { ...D_LATCH, id: 't_fake_ff', ports: D_LATCH.ports.filter((p) => p.name !== 'q_n'), ff: { d: 'd', q: 'q', clk: 'e' } };
    const fakeDef: ComponentDef = {
      ...fake, netlist: () => ({ instances: [{ name: 'l', def: D_LATCH }], nets: [{ ends: ['d', 'l.d'] }, { ends: ['e', 'l.e'] }, { ends: ['l.q', 'q'] }] }),
    };
    const t = FfTable.of(fakeDef)!;
    const g = new GateSim(t.flat);
    g.setInput('e', 1);
    g.settle();
    const id = t.intern(Uint8Array.from({ length: t.flat.netCount }, (_, i) => g.get(i)));
    expect(t.good(id)).toBe(false);
  });
});

describe('cycle engine ≡ GateSim on sequential parts', () => {
  it('counters, shift register, LFSR, RAM: every net after every settle', () => {
    for (const [def, seed] of [[counter(4), 1], [upDownCounter(4), 2], [shiftRegister(4), 3], [lfsr(8), 4], [ram(3, 4), 5], [register(8), 6]] as const) {
      const share = lockstep(def, 160, seed);
      expect(share, def.id).toBeGreaterThan(0.5);
    }
  });
});

// ---- CPUs on random programs --------------------------------------------------------------------

/** A random RV32I program: ALU work, loads and stores to the first 32 words, branches both ways. */
function randomProgram(seed: number, n = 40): number[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const reg = () => `x${1 + Math.floor(r() * 7)}`;
  const lines: string[] = [];
  for (let i = 1; i <= 7; i++) lines.push(`li x${i}, ${Math.floor(r() * 4096) - 2048}`);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.35) lines.push(`${pick(['add', 'sub', 'and', 'or', 'xor', 'slt', 'sltu', 'sll', 'srl', 'sra'])} ${reg()}, ${reg()}, ${reg()}`);
    else if (k < 0.55) lines.push(`${pick(['addi', 'andi', 'ori', 'xori', 'slti', 'sltiu'])} ${reg()}, ${reg()}, ${Math.floor(r() * 4096) - 2048}`);
    else if (k < 0.62) lines.push(`${pick(['slli', 'srli', 'srai'])} ${reg()}, ${reg()}, ${Math.floor(r() * 32)}`);
    else if (k < 0.66) lines.push(`lui ${reg()}, ${Math.floor(r() * 1048576)}`);
    else if (k < 0.78) lines.push(`sw ${reg()}, ${4 * Math.floor(r() * 32)}(x0)`);
    else if (k < 0.9) lines.push(`lw ${reg()}, ${4 * Math.floor(r() * 32)}(x0)`);
    else lines.push(`${pick(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'])} ${reg()}, ${reg()}, ${4 * (r() < 0.7 ? 1 + Math.floor(r() * 3) : -Math.floor(r() * 6))}`);
  }
  lines.push('j 0');
  // branch offsets are relative: assemble resolves numbers as byte offsets from the instruction
  return assemble(lines.map((l) => l.replace(/, (-?\d+)$/, (m, o) => (/^b/.test(l) ? `, . + ${o}` : m))).join('\n')).words;
}

/** Run a CPU on both engines, clock edge by clock edge, other inputs changed now and then. */
function cpuLockstep(def: ComponentDef, cycles: number, seed: number): number {
  const { dual, ref } = pair(def, 'zero');
  const rnd = rng(seed);
  const extra = def.ports.filter((p) => p.dir === 'in' && p.name !== 'clk');
  let fast = 0;
  for (let c = 0; c < cycles; c++) {
    if (extra.length && rnd() < 0.2) {
      const p = extra[Math.floor(rnd() * extra.length)];
      const v = Math.floor(rnd() * 2 ** p.width);
      for (const s of [dual, ref]) { s.setInput(p.name, v); s.settle(); }
    }
    for (const v of [1, 0]) {
      for (const s of [dual, ref]) { s.setInput('clk', v); s.settle(); }
      if (dual.engine === 'cycle') fast++;
      sameNets(dual, ref, `${def.id} cycle ${c} clk ${v}`);
    }
  }
  return fast / (2 * cycles);
}

describe('cycle engine ≡ GateSim on the CPUs, every net after every edge', () => {
  it('single-cycle RV32I, two random programs', () => {
    for (const seed of [11, 12]) expect(cpuLockstep(singleCycleCpu(randomProgram(seed)), 30, seed)).toBe(1);
  }, 60000);
  it('pipelined RV32I', () => {
    expect(cpuLockstep(pipelinedCpu(randomProgram(13)), 30, 13)).toBe(1);
  }, 60000);
  it('system RV32I with the switches and irq changing', () => {
    expect(cpuLockstep(systemCpu(randomProgram(14)), 30, 14)).toBe(1);
  }, 60000);
});

// ---- behavioural leaves -------------------------------------------------------------------------

/** A RAM as the big-memory parts are: state in a typed array, written at the rising edge of clk. */
const CLOCKED_RAM: ComponentDef = {
  id: 't_clocked_ram', name: 'clocked RAM', category: 'memory',
  ports: [bit('clk', 'in'), bit('we', 'in'), bus('addr', 4, 'in'), bus('din', 4, 'in'), bus('dout', 4, 'out')],
  symbol: { kind: 'box' },
  behavior: {
    init: () => ({ mem: new Uint8Array(16), clk: 0 }),
    eval: ([clk, we, addr, din], s) => {
      const st = s as { mem: Uint8Array; clk: number };
      if (clk === 1 && st.clk === 0 && we === 1 && addr >= 0 && din >= 0) st.mem[addr] = din;
      if (clk >= 0) st.clk = clk;
      return [addr < 0 ? -1 : st.mem[addr]];
    },
  },
};

/** A counter addressing the RAM, a keyboard feeding it (ready = write), a key acknowledging, a register after it. */
function computer(ramClock: 'clk' | 'inverted' = 'clk'): ComponentDef {
  const KEY = keyPart('a');
  return {
    id: `t_computer_${ramClock}`, name: 'computer', category: 'custom',
    ports: [bit('clk', 'in'), bus('q', 4, 'out'), bus('addr', 4, 'out')],
    symbol: { kind: 'box' },
    netlist: () => ({
      instances: [
        { name: 'one', def: TIE1 }, { name: 'c', def: counter(4) }, { name: 'kb', def: KEYBOARD }, { name: 'k', def: KEY },
        { name: 'sp', def: splitter([4, 4]) }, { name: 'm', def: CLOCKED_RAM }, { name: 'r', def: register(4) }, { name: 'inv', def: NOT },
      ],
      nets: [
        { ends: ['one.y', 'c.en', 'r.en'] },
        { ends: ramClock === 'clk' ? ['clk', 'c.clk', 'r.clk', 'm.clk', 'inv.a'] : ['clk', 'c.clk', 'r.clk', 'inv.a'] },
        ...(ramClock === 'inverted' ? [{ ends: ['inv.y', 'm.clk'] }] : []),
        { ends: ['c.q', 'm.addr', 'addr'] },
        { ends: ['kb.code', 'sp.in'] }, { ends: ['sp.o0', 'm.din'] },
        { ends: ['kb.ready', 'm.we'] }, { ends: ['k.q', 'kb.ack'] },
        { ends: ['m.dout', 'r.d'] }, { ends: ['r.q', 'q'] },
      ],
    }),
  };
}

describe('behavioural leaves on the cycle engine', () => {
  it('a clocked RAM, a keyboard and a key poked from outside: every net after every settle', () => {
    const { dual, ref } = pair(computer(), 'zero');
    const d = dual.design;
    const kb = d.leaves.findIndex((l) => l.def === KEYBOARD), key = d.leaves.findIndex((l) => l.def === keyPart('a'));
    expect(kb).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThanOrEqual(0);
    const rnd = rng(21);
    let fast = 0;
    for (let c = 0; c < 80; c++) {
      if (rnd() < 0.3) {
        const q = Array.from({ length: Math.floor(rnd() * 3) }, () => Math.floor(rnd() * 256));
        for (const s of [dual, ref]) s.poke(kb, { q });
      }
      if (rnd() < 0.3) {
        const v = rnd() < 0.5 ? 1 : 0;
        for (const s of [dual, ref]) s.poke(key, { v });
      }
      for (const v of [1, 0]) {
        for (const s of [dual, ref]) { s.setInput('clk', v); s.settle(); }
        if (dual.engine === 'cycle') fast++;
        sameNets(dual, ref, `cycle ${c}`);
      }
    }
    expect(fast).toBe(160);
    // the RAM's state went through the same writes
    const ramLeaf = d.leaves.findIndex((l) => l.def === CLOCKED_RAM);
    expect((dual.leafState(ramLeaf) as { mem: Uint8Array }).mem).toEqual((ref.leafState(ramLeaf) as { mem: Uint8Array }).mem);
  });
});

describe('a large RAM (Behavior.seq) on the cycle engine', () => {
  it('counter-addressed 128 × 8 RAM writing dout + 1 back (a loop through its sampled inputs)', () => {
    const top: ComponentDef = {
      id: 't_bigmem_loop', name: 'bigmem loop', category: 'custom',
      ports: [bit('clk', 'in'), bit('we', 'in'), bus('q', 8, 'out')], symbol: { kind: 'box' },
      netlist: () => ({
        instances: [
          { name: 'one', def: TIE1 }, { name: 'c', def: counter(7) }, { name: 'm', def: bigRam(7, 8) },
          { name: 'inc', def: incrementer(8) }, { name: 'r', def: register(8) },
        ],
        nets: [
          { ends: ['one.y', 'c.en', 'r.en'] }, { ends: ['clk', 'c.clk', 'm.clk', 'r.clk'] }, { ends: ['we', 'm.we'] },
          { ends: ['c.q', 'm.addr'] }, { ends: ['m.dout', 'inc.a', 'r.d'] }, { ends: ['inc.y', 'm.din'] }, { ends: ['r.q', 'q'] },
        ],
      }),
    };
    expect(CycleSim.build(flatten(top))).toBeInstanceOf(CycleSim);
    for (const mode of ['zero', 'x', 'random'] as const) {
      const { dual, ref } = pair(top, mode, 41);
      const rnd = rng(42);
      let fast = 0;
      for (let c = 0; c < 300; c++) {
        if (rnd() < 0.2) { const v = rnd() < 0.7 ? 1 : 0; for (const s of [dual, ref]) { s.setInput('we', v); s.settle(); } }
        for (const v of [1, 0]) {
          for (const s of [dual, ref]) { s.setInput('clk', v); s.settle(); }
          if (dual.engine === 'cycle') fast++;
          sameNets(dual, ref, `${mode} cycle ${c}`);
        }
      }
      expect(fast, mode).toBe(600);
      const li = dual.design.leaves.findIndex((l) => l.def === bigRam(7, 8));
      expect(dual.leafState(li)).toEqual(ref.leafState(li));
    }
  });
});

// ---- fall-backs ---------------------------------------------------------------------------------

describe('fall-backs to GateSim', () => {
  it('refuses loops that are not flip-flops, derived clocks, and behaviours on a derived clock', () => {
    const latch = flatten(SR_LATCH);
    expect((CycleSim.build(latch) as { reason: string }).reason).toMatch(/loop/);
    const gated: ComponentDef = {
      id: 't_gated', name: 'gated', category: 'custom', ports: [bit('clk', 'in'), bit('d', 'in'), bit('q', 'out')], symbol: { kind: 'box' },
      netlist: () => ({ instances: [{ name: 'n', def: NOT }, { name: 'f', def: DFF }], nets: [{ ends: ['clk', 'n.a'] }, { ends: ['n.y', 'f.clk'] }, { ends: ['d', 'f.d'] }, { ends: ['f.q', 'q'] }] }),
    };
    expect((CycleSim.build(flatten(gated)) as { reason: string }).reason).toMatch(/clock/);
    expect((CycleSim.build(flatten(computer('inverted'))) as { reason: string }).reason).toMatch(/derived from a clock/);
    // DualSim stays on GateSim for them, and is GateSim
    expect(lockstep(gated, 60, 31, ['zero'])).toBe(0);
    expect(lockstep(SR_LATCH, 40, 32, ['zero'])).toBe(0);
  });

  it('an X clock: that settle runs on GateSim, the cycle engine takes over again after', () => {
    const { dual, ref } = pair(counter(4), 'zero');
    const both = (f: (s: Sim) => void) => { f(dual); f(ref); };
    both((s) => { s.setInput('en', 1); s.settle(); });
    for (let i = 0; i < 4; i++) for (const v of [1, 0]) both((s) => { s.setInput('clk', v); s.settle(); });
    expect(dual.engine).toBe('cycle');
    both((s) => { s.setInputBits('clk', [2]); s.settle(); });
    expect(dual.engine).toBe('gate');
    sameNets(dual, ref, 'clk = X');
    for (let i = 0; i < 4; i++) for (const v of [1, 0]) both((s) => { s.setInput('clk', v); s.settle(); });
    sameNets(dual, ref, 'after');
  });

  it('timing on demand: step, a trace listener, saved states of either engine', () => {
    const { dual, ref } = pair(counter(4), 'zero');
    const both = (f: (s: Sim) => void) => { f(dual); f(ref); };
    both((s) => { s.setInput('en', 1); s.settle(); });
    for (const v of [1, 0, 1, 0]) both((s) => { s.setInput('clk', v); s.settle(); });
    expect(dual.engine).toBe('cycle');
    const onFast = dual.saveState(), refAt = ref.saveState();
    // a pending edge handed to GateSim and stepped one delay at a time
    both((s) => s.setInput('clk', 1));
    while (ref.step()) {
      dual.step();
      sameNets(dual, ref, `t = ${ref.time}`);
    }
    expect(dual.engine).toBe('gate');
    dual.restoreState(onFast);
    ref.restoreState(refAt);
    expect(dual.engine).toBe('cycle');
    sameNets(dual, ref, 'restored');
    const seen: number[] = [];
    dual.watch(dual.design.root.ports.q);
    dual.onTrace = (net) => seen.push(net);
    expect(dual.engine).toBe('gate');
    both((s) => { s.setInput('clk', 1); s.settle(); });
    expect(seen.length).toBeGreaterThan(0);
    sameNets(dual, ref, 'traced');
  });

  it('carry from a DualSim on the cycle engine equals carry from GateSim', () => {
    const { dual, ref } = pair(counter(4), 'zero');
    const both = (f: (s: Sim) => void) => { f(dual); f(ref); };
    both((s) => { s.setInput('en', 1); s.settle(); });
    for (let i = 0; i < 5; i++) for (const v of [1, 0]) both((s) => { s.setInput('clk', v); s.settle(); });
    expect(dual.engine).toBe('cycle');
    const d2 = flatten(counter(4));
    const a = new DualSim(d2), b = new GateSim(d2);
    a.carry(dual, { known: true });
    b.carry(ref, { known: true });
    sameNets(a, b, 'carried');
  });
});
