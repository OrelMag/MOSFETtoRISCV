// The gate-level 4-bit CPU against its golden model: every architectural register compared after
// every clock, on the sample programs and on random ROMs (32 per BitSim run, one per lane), with
// the TEST pin and the switches changing under it.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { assemble4 } from '../src/isa4/asm4';
import { Iss4 } from '../src/isa4/iss4';
import { INSTRS4 } from '../src/isa4/isa4';
import { PROGRAMS4 } from '../src/isa4/programs4';
import { BitSim } from '../src/sim/bitsim';
import { findNode, flatten } from '../src/sim/flatten';
import { CPU4_STATE, cpu4, rom4 } from '../src/lib/cpu4';
import { stats } from '../src/sim/stats';

/** Seeded PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random ROM: mostly straight-line instructions with random operands, jumps rare enough that the
 * program does not fall into a short loop at once, some raw words (undefined ones too).
 */
function randomRom(seed: number): number[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const plain = [0x00, 0x20, 0x21, 0x60, 0x80, 0x90, 0xa0, 0xb0, 0xd0, 0xe2, 0xea, 0xf0];
  const jumps = [0x10, 0x31, 0x40, 0x50, 0x70, 0xc0];
  return Array.from({ length: 256 }, () => {
    const x = r();
    if (x < 0.05) return Math.floor(r() * 0x10000);
    const hi = x < 0.85 ? pick(plain) : pick(jumps);
    if (hi === 0xf0) return (0xf0 | Math.floor(r() * 12)) << 8;
    if (hi === 0x20 || hi === 0x21 || hi === 0x31) return ((hi | (Math.floor(r() * 8) << 1)) << 8) | Math.floor(r() * 256);
    const opa = hi === 0x40 || hi === 0x50 || hi === 0x00 || hi === 0xe2 || hi === 0xea ? 0 : Math.floor(r() * 16);
    return ((hi | opa) << 8) | Math.floor(r() * 256);
  });
}

class Bench {
  readonly sim: BitSim;
  private readonly nets = new Map<string, number[]>();
  constructor(readonly roms: number[][]) {
    const design = flatten(cpu4(roms[0]));
    this.sim = new BitSim(design);
    design.leaves.forEach((leaf, i) => {
      if (leaf.kind === 'behavior' && leaf.inputs.length && leaf.def.id.startsWith('cpu4_rom_')) {
        this.sim.setLaneBehavior(i, ([a], lane) => [a < 0 ? -1 : roms[lane % roms.length][a & 255] ?? 0]);
      }
    });
    const port = (path: string, name: string) => {
      const n = findNode(design.root, path.split('.'));
      if (!n) throw new Error(`no ${path}`);
      return n.ports[name];
    };
    const all = [CPU4_STATE.pc, ...CPU4_STATE.stack, CPU4_STATE.a, CPU4_STATE.src, ...CPU4_STATE.regs, ...CPU4_STATE.ports];
    for (const p of all) this.nets.set(p, port(p, 'q'));
    this.nets.set(CPU4_STATE.cy, port(CPU4_STATE.cy, 'q'));
    this.sim.setInput('test', 0);
    this.sim.setInput('sw', 0);
    this.sim.settle();
  }
  read(path: string, lane: number): number {
    return this.nets.get(path)!.reduce((v, net, i) => v | (((this.sim.v[net] >>> lane) & 1) << i), 0);
  }
  /** The ISS's state and the hardware's, as comparable records. */
  state(lane: number) {
    const S = CPU4_STATE;
    return {
      pc: this.read(S.pc, lane), a: this.read(S.a, lane), cy: this.read(S.cy, lane), src: this.read(S.src, lane),
      stack: S.stack.map((p) => this.read(p, lane)), r: S.regs.map((p) => this.read(p, lane)), ports: S.ports.map((p) => this.read(p, lane)),
    };
  }
}

const issState = (s: Iss4) => ({ pc: s.pc, a: s.a, cy: s.cy, src: s.src, stack: [...s.stack], r: [...s.r], ports: [...s.ports] });

describe('4-bit CPU at gate level', () => {
  it('runs every sample in lock-step with the golden model', () => {
    const roms = PROGRAMS4.map((p) => assemble4(p.src).words);
    const bench = new Bench(roms);
    const isses = roms.map((w) => new Iss4(w));
    const r = rng(7);
    for (let c = 0; c < 400; c++) {
      // TEST and switches: the same per lane for the hardware and the model
      const test = roms.map(() => (r() < 0.2 ? 1 : 0)), sw = roms.map(() => Math.floor(r() * 16));
      bench.sim.setInput('test', test);
      bench.sim.setInput('sw', sw);
      isses.forEach((s, l) => { s.test = test[l]; s.switches = sw[l]; s.step(); });
      bench.sim.cycle();
      isses.forEach((s, l) => expect(bench.state(l), `${PROGRAMS4[l].id} after cycle ${c + 1}`).toEqual(issState(s)));
    }
    // The BCD sample's result and the halt output on its last word.
    expect(bench.state(0).ports.slice(0, 4)).toEqual([7, 1, 1, 0]);
    expect(bench.sim.get('halt', roms.length)[0]).toBe(1);
  });

  it('matches the golden model on 64 random ROMs, every register after every cycle', () => {
    const seen = new Map<string, number>();
    for (const base of [1, 33]) {
      const roms = Array.from({ length: 32 }, (_, i) => randomRom(base + i));
      const bench = new Bench(roms);
      const isses = roms.map((w) => new Iss4(w));
      const r = rng(base * 101);
      for (let c = 0; c < 600; c++) {
        const test = roms.map(() => (r() < 0.5 ? 1 : 0)), sw = roms.map(() => Math.floor(r() * 16));
        bench.sim.setInput('test', test);
        bench.sim.setInput('sw', sw);
        isses.forEach((s, l) => { s.test = test[l]; s.switches = sw[l]; const n = s.step().name; seen.set(n, (seen.get(n) ?? 0) + 1); });
        bench.sim.cycle();
        for (let l = 0; l < roms.length; l++) {
          const hw = bench.state(l), want = issState(isses[l]);
          if (JSON.stringify(hw) !== JSON.stringify(want)) {
            expect(hw, `seed ${base + l} after cycle ${c + 1}`).toEqual(want);
          }
        }
      }
    }
    // Coverage: every instruction ran, many times.
    for (const i of INSTRS4) expect(seen.get(i.name) ?? 0, i.name).toBeGreaterThan(10);
  });

  it('costs a few thousand NANDs (the ROM aside)', () => {
    const w = assemble4(PROGRAMS4[0].src).words;
    const n = stats(cpu4(w)).nands - stats(rom4(w)).nands;
    expect(n).toBeGreaterThan(1500);
    expect(n).toBeLessThan(6000);
  });
});
