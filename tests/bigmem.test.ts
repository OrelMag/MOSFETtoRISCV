// Large memories (lib/bigmem.ts): a RAM of up to 2^16 words is one behavioural leaf whose structure
// (banks of banks down to gate-level 64-word banks) is real, simulable and openable. The leaf must
// behave exactly like that structure; its state must survive what gate-level storage survives
// (carry, save / restore, power-on modes); opened, the inside shows the leaf's words; costs, timing
// and HDL come from the hierarchy without flattening millions of gates.

import { describe, expect, it } from 'vitest';
import { BANK_K, bankState, bigRam, bigRamWithInit, isRamState, ramBank, type RamState, romLevels } from '../src/lib/bigmem';
import { ram } from '../src/lib/memory';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { exportHdl } from '../src/sim/svexport';
import { hasFeedback, logicDepth, stats } from '../src/sim/stats';
import { SwitchSim } from '../src/sim/switchsim';
import { analyzeTiming, CLK_TO_Q, SETUP } from '../src/sim/timing';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { ViewCtx } from '../src/view/context';
import { lcg, out, set } from './util';

/** A throwaway chip around one memory, so the memory is a child (as a placed part is). */
function host(id: string, M: ComponentDef): ComponentDef {
  return {
    id, name: id, category: 'memory', ports: M.ports, symbol: { kind: 'box' },
    netlist: () => ({ instances: [{ name: 'mem', def: M, at: [10, 0] }], nets: M.ports.map((p) => ({ ends: p.dir === 'in' ? [p.name, `mem.${p.name}`] : [`mem.${p.name}`, p.name] })) }),
  };
}

const tick = (sim: { setInput(p: string, v: number): void; settle(): void }) => {
  sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
};
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

describe('behaviour ≡ structure', { timeout: 120000 }, () => {
  // The whole hierarchy expanded down to NANDs, against the one leaf, on random writes and reads.
  for (const [k, w, steps] of [[8, 8, 160], [9, 3, 100], [11, 1, 40]] as const) {
    it(`${2 ** k}×${w}: random writes and reads, gate level`, async () => {
      const d = bigRam(k, w);
      const full = new GateSim(flatten(d, { expand: () => true }));
      const leaf = new GateSim(flatten(d));
      expect(leaf.design.leaves).toHaveLength(1);
      expect(full.design.leaves.length).toBeGreaterThan(1000 * (k - 6));
      const rnd = lcg(k * 31 + w);
      const ref = new Array<number>(2 ** k).fill(0);
      for (let s = 0; s < steps; s++) {
        // a write, then a read somewhere else, then (often) a read of what was just written
        const a = rnd(2 ** k), v = rnd(2 ** w), b = rnd(2 ** k);
        for (const sim of [full, leaf]) {
          set(sim, { addr: a, din: v, we: 1, clk: 0 });
          tick(sim);
          set(sim, { addr: b, we: 0 });
        }
        ref[a] = v;
        expect([out(full, 'dout'), out(leaf, 'dout')], `read [${b}] after writing [${a}] = ${v}`).toEqual([ref[b], ref[b]]);
        for (const sim of [full, leaf]) set(sim, { addr: a });
        expect(out(leaf, 'dout')).toBe(v);
        expect(out(full, 'dout')).toBe(v);
        if (s % 10 === 0) await yieldLoop();
      }
    });
  }

  it('BitSim (no timing, topological sweeps): the leaf agrees with the structure', () => {
    // it writes what it sampled while clk was low, so the sweep order around the edge does not matter
    const d = bigRam(8, 8);
    const full = new BitSim(flatten(d, { expand: () => true }));
    const leaf = new BitSim(flatten(d));
    const rnd = lcg(5);
    for (let s = 0; s < 60; s++) {
      const a = rnd(256), v = rnd(256);
      for (const sim of [full, leaf]) {
        sim.setInput('addr', a); sim.setInput('din', v); sim.setInput('we', s % 3 ? 1 : 0); sim.setInput('clk', 0);
        sim.cycle();
      }
      expect(leaf.get('dout', 1)).toEqual(full.get('dout', 1));
    }
  });

  it('a level opened with the structure one step down: bank leaves, then gates', () => {
    const d = bigRam(16, 32);
    const nl = netlistOf(d)!;
    expect(nl.instances.filter((i) => i.name.startsWith('bank'))).toHaveLength(16);
    const sub = nl.instances.find((i) => i.name === 'bank0')!.def;
    expect(sub).toBe(bigRam(12, 32));
    expect(netlistOf(bigRam(8, 32))!.instances.find((i) => i.name === 'bank3')!.def).toBe(ramBank(32));
    // ramBank is ram(6, w)'s very circuit, simulated as a lookup
    expect(netlistOf(ramBank(32))!.instances.map((i) => i.def)).toEqual(netlistOf(ram(BANK_K, 32))!.instances.map((i) => i.def));
    // no level holds more than 16 banks; the leaf costs one evaluation per access
    const top = flatten(d);
    expect(top.leaves).toHaveLength(1);
    expect(flatten(d, { expand: (_, n) => n.parent === null }).leaves.filter((l) => l.kind === 'behavior')).toHaveLength(16);
  });
});

describe('unknowns and power-on', () => {
  const d = bigRam(7, 4);
  const sim = () => new GateSim(flatten(host('t_bm_host7', d)));

  it("'x' power-on reads X until written; 'zero' reads the initial contents; 'random' known words", () => {
    const s = sim();
    s.reset('x');
    set(s, { addr: 5, din: 9, we: 0, clk: 0 });
    expect(out(s, 'dout')).toBe(-1);
    set(s, { we: 1 });
    tick(s);
    expect(out(s, 'dout')).toBe(9);
    set(s, { addr: 6 });
    expect(out(s, 'dout')).toBe(-1);
    s.reset('random');
    expect(out(s, 'dout')).toBeGreaterThanOrEqual(0);
    const init = Array.from({ length: 128 }, (_, i) => i % 16);
    const t = new GateSim(flatten(host('t_bm_init', bigRamWithInit(7, 4, init))));
    set(t, { addr: 37, we: 0, clk: 0 });
    expect(out(t, 'dout')).toBe(37 % 16);
    t.reset('x');
    expect(out(t, 'dout')).toBe(-1);
  });

  it('an X address reads X; a write with X enable or X clock makes the word(s) X unless they hold din', () => {
    const s = sim();
    set(s, { addr: 3, din: 7, we: 1, clk: 0 });
    tick(s);
    s.setInputBits('addr', [2, 0, 0, 0, 0, 0, 0]);
    s.settle();
    expect(out(s, 'dout')).toBe(-1);
    // we = X at an edge: word 4 (0) may have become 5; word 3 already holds 7, so 7 stays known
    set(s, { addr: 4, din: 5 });
    s.setInputBits('we', [2]);
    s.settle();
    tick(s);
    expect(out(s, 'dout')).toBe(-1);
    set(s, { addr: 3, din: 7 });
    s.setInputBits('we', [2]);
    s.settle();
    tick(s);
    expect(out(s, 'dout')).toBe(7);
    // clk X with we = 1: an edge may have happened
    set(s, { addr: 9, din: 1, we: 1 });
    s.setInputBits('clk', [2]);
    s.settle();
    set(s, { clk: 0 });
    expect(out(s, 'dout')).toBe(-1);
    // an X address written with we = 1: every word that does not hold din is unknown
    set(s, { addr: 20, din: 0, we: 0 });
    expect(out(s, 'dout')).toBe(0);
    s.setInputBits('addr', [2, 2, 2, 2, 2, 2, 2]);
    set(s, { we: 1, din: 0 });
    tick(s);
    set(s, { we: 0, addr: 20 });
    expect(out(s, 'dout')).toBe(0); // held din already
    set(s, { addr: 3 });
    expect(out(s, 'dout')).toBe(-1);
  });

  it('a clock low → X → low writes nothing when we = 0', () => {
    const s = sim();
    set(s, { addr: 1, din: 3, we: 1, clk: 0 });
    tick(s);
    set(s, { we: 0, din: 0 });
    s.setInputBits('clk', [2]);
    s.settle();
    set(s, { clk: 0 });
    expect(out(s, 'dout')).toBe(3);
  });
});

describe('state survives', () => {
  const d = bigRam(10, 16);
  const H = host('t_bm_host10', d);

  it('carry (an edit) keeps the words; with known it heals unknown words to their power-on value', () => {
    const a = new GateSim(flatten(H));
    set(a, { addr: 700, din: 0xbeef, we: 1, clk: 0 });
    tick(a);
    set(a, { addr: 701, din: 1 });
    a.setInputBits('we', [2]);
    a.settle();
    tick(a); // word 701 unknown
    const b = new GateSim(flatten(H));
    b.carry(a);
    set(b, { addr: 700, we: 0 });
    expect(out(b, 'dout')).toBe(0xbeef);
    set(b, { addr: 701 });
    expect(out(b, 'dout')).toBe(-1);
    const c = new GateSim(flatten(H));
    c.carry(a, { known: true });
    set(c, { addr: 701, we: 0 });
    expect(out(c, 'dout')).toBe(0);
    set(c, { addr: 700 });
    expect(out(c, 'dout')).toBe(0xbeef);
    // the old simulation's state is its own
    set(c, { din: 5, we: 1 });
    tick(c);
    set(a, { addr: 700, we: 0 });
    expect(out(a, 'dout')).toBe(0xbeef);
    // a switch-level simulation takes it over too
    const sw = new SwitchSim(flatten(H, { mode: 'switch' }));
    sw.carry(a);
    sw.setInput('addr', 700);
    sw.settle();
    expect(out(sw, 'dout')).toBe(0xbeef);
  });

  it('saveState / restoreState (Back) puts the words back, more than once', () => {
    const s = new GateSim(flatten(H));
    set(s, { addr: 10, din: 1, we: 1, clk: 0 });
    tick(s);
    const saved = s.saveState();
    set(s, { din: 2 });
    tick(s);
    set(s, { addr: 11, din: 3 });
    tick(s);
    for (let r = 0; r < 2; r++) {
      s.restoreState(saved);
      set(s, { addr: 10, we: 0 });
      expect(out(s, 'dout')).toBe(1);
      set(s, { addr: 11 });
      expect(out(s, 'dout')).toBe(0);
      set(s, { addr: 11, din: 9, we: 1 });
      tick(s);
    }
  });
});

describe('looking inside', () => {
  it('opened, each level shows the leaf’s words: bank leaves seeded, then the latches of a gate-level bank', () => {
    const d = bigRam(16, 8);
    const sim = new GateSim(flatten(host('t_bm_host16', d)));
    const writes: [number, number][] = [[0, 0x11], [0x1234, 0xab], [0x1235, 0xcd], [0xffff, 0x7e], [0x8040, 0x42]];
    set(sim, { we: 1, clk: 0 });
    for (const [a, v] of writes) { set(sim, { addr: a, din: v }); tick(sim); }
    set(sim, { we: 0, addr: 0x1235 });
    const root = new ViewCtx(sim, sim.design.root);
    const mem = root.child('mem')!;
    expect(mem.isSubSim).toBe(true);
    // level 1: 16 banks of 4096 words, each a leaf seeded with its share
    const b1 = mem.node.children!.get('bank1')!;
    const st = mem.sim.leafState(b1.leafIndex!) as RamState;
    expect(isRamState(st)).toBe(true);
    expect([st.mem[0x234], st.mem[0x235]]).toEqual([0xab, 0xcd]);
    expect(pack(mem.portBits('dout'))).toBe(0xcd);
    expect(pack(mem.sim.getBits(b1.ports.dout))).toBe(0xcd);
    // down to a 64-word gate-level bank: its registers hold the words
    const l2 = mem.child('bank1')!.child('bank2')!;
    const bank = l2.child('bank0')!;
    expect(bank.def).toBe(ramBank(8));
    const reg = (i: number) => pack(bank.sim.getBits(bank.node.children!.get(`w${i}`)!.ports.q));
    expect([reg(0x34), reg(0x35), reg(0x36)]).toEqual([0xab, 0xcd, 0]);
    expect(pack(bank.portBits('dout'))).toBe(0xcd);
    // the parent writes again: the next sync shows it at every level
    set(sim, { addr: 0x1236, din: 0x99, we: 1 });
    tick(sim);
    set(sim, { we: 0 });
    bank.sync();
    expect(reg(0x36)).toBe(0x99);
    expect(pack(bank.portBits('dout'))).toBe(0x99);
    // a bank of the sub-simulation is the parent's share (its write enable as the decoder gives it)
    const s = sim.leafState(sim.design.root.children!.get('mem')!.leafIndex!) as RamState;
    const share = bankState({ ...s, we: 1, a: 0x1236 }, 1, 12);
    expect([share.we, share.a, bankState({ ...s, we: 1, a: 0x1236 }, 2, 12).we, bankState({ ...s, we: 1, a: -1 }, 2, 12).we]).toEqual([1, 0x236, 0, 2]);
  });
});

describe('cost, timing and HDL from the hierarchy', () => {
  it('stats of 2^16 × 32 come per level, at once', () => {
    const t = performance.now();
    const s = stats(bigRam(16, 32));
    expect(performance.now() - t).toBeLessThan(1000);
    const own = (k: number) => {
      const nl = netlistOf(bigRam(k, 32))!;
      return nl.instances.filter((i) => !i.name.startsWith('bank')).reduce((a, i) => a + stats(i.def).nands, 0);
    };
    expect(s.nands).toBe(16 * stats(bigRam(12, 32)).nands + own(16));
    expect(stats(bigRam(8, 32)).nands).toBe(4 * stats(ram(6, 32)).nands + own(8));
    expect(s.transistors).toBe(4 * s.nands);
    expect(s.levels).toBeGreaterThan(stats(ram(6, 32)).levels + 2);
  });

  it('is storage for logicDepth / feedback; static timing captures its inputs and launches dout', () => {
    const d = bigRam(12, 8);
    expect(logicDepth(d)).toBeNull();
    expect(hasFeedback(d)).toBe(true);
    const r = analyzeTiming(flatten(host('t_bm_t', d)))!;
    expect(r).not.toBeNull();
    // inputs straight from pins: nothing before them; dout is not captured
    expect(r.period).toBe(SETUP);
    expect(r.launch).toEqual([]);
    // a RAM feeding a register: clk-to-q + the read path + setup
    const reg: ComponentDef = {
      id: 't_bm_t2', name: 't', category: 'memory', ports: [...d.ports.filter((p) => p.dir === 'in')], symbol: { kind: 'box' },
      netlist: () => ({
        instances: [{ name: 'mem', def: d }, { name: 'back', def: bigRam(12, 8) }],
        nets: [
          ...d.ports.filter((p) => p.dir === 'in' && p.name !== 'din').map((p) => ({ ends: [p.name, `mem.${p.name}`, `back.${p.name}`] })),
          { ends: ['din', 'mem.din'] }, { ends: ['mem.dout', 'back.din'] },
        ],
      }),
    };
    const r2 = analyzeTiming(flatten(reg))!;
    expect(r2.period).toBe(CLK_TO_Q + d.behavior!.delay! + SETUP);
    expect(r2.launch).toEqual(['mem']);
    expect(r2.capture).toEqual(['back']);
  });

  it('synthesis export: one module with a reg array (and its initial words); structure export: the hierarchy', () => {
    const f = exportHdl(bigRam(16, 32), 'synth');
    expect(f.modules).toBe(1);
    expect(f.text).toContain('reg [31:0] mem [0:65535];');
    expect(f.text).toContain('always @(posedge clk) if (we) mem[addr] <= din;');
    const i = exportHdl(bigRamWithInit(7, 8, [0, 0x2a]), 'synth');
    expect(i.text).toContain("mem[1] = 8'h2a;");
    const s = exportHdl(bigRam(8, 4), 'structure');
    const mods = [...s.text.matchAll(/^module (\w+)/gm)].map((m) => m[1]);
    expect(mods).toEqual(expect.arrayContaining(['ram256x4', 'ram64x4_bank', 'nand2']));
    expect(new Set(mods).size).toBe(mods.length);
  });
});

describe('large ROM levels', () => {
  const leaf = (k: number, w: number, c: Uint32Array): ComponentDef => ({
    id: `t_romleaf_${k}_${c[0]}_${c[c.length - 1]}`, name: 'leaf', category: 'memory',
    ports: [{ name: 'addr', width: k, dir: 'in' }, { name: 'data', width: w, dir: 'out' }], symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : c[a]] }, preferBehavior: true,
  });

  it('banks of banks, built when opened, identical slices sharing one definition', () => {
    const content = Uint32Array.from({ length: 2 ** 14 }, (_, i) => (i < 300 ? i * 7 : 0x13));
    const R = romLevels(14, 32, true, content, 't_rom14', leaf);
    const nl = netlistOf(R)!;
    const banks = nl.instances.filter((i) => i.name.startsWith('bank'));
    expect(banks).toHaveLength(16);
    // all but the first bank hold only NOPs: one shared definition
    expect(new Set(banks.slice(1).map((b) => b.def)).size).toBe(1);
    const sim = new GateSim(flatten(host('t_rom14_host', R), { expand: (d, n) => n.parent === null || !d.preferBehavior || d.id.startsWith('t_rom14') }));
    for (const i of [0, 1, 255, 299, 300, 9000, 16383]) {
      sim.setInput('addr', 4 * i);
      sim.settle();
      expect(out(sim, 'data'), `word ${i}`).toBe(content[i]);
    }
    expect(R.behavior!.eval([4 * 299], undefined)).toEqual([299 * 7]);
  });
});
