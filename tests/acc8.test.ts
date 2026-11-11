// The first computer (chapter 'firstcomputer'): its gates against its golden model, PC, A, OUT and every RAM byte
// after every clock, on the chapter's programs and on random ROMs (one per BitSim lane); the control block against
// its table; the assembler against the table's encoding.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { ACC8_PRESET, ACC_OPS, ACC_PROGRAMS, AccISS, accAssemble, accDisasm } from '../src/acc8/acc8';
import { ACC_CTL, ACC_CTL_OUTS, ACC_STATE, accControl, accMachine } from '../src/lib/acc8';
import { ISA_PRESETS } from '../src/isa/presets';
import { BitSim } from '../src/sim/bitsim';
import { findNode, flatten } from '../src/sim/flatten';
import { evalOnce, simulate } from '../src/sim/harness';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random ROM: any word, jumps a little rarer so programs do not fall into a short loop at once. */
function randomRom(seed: number): number[] {
  const r = rng(seed);
  return Array.from({ length: 32 }, () => {
    let w = Math.floor(r() * 256);
    while ((w >> 5 === 5 || w >> 5 === 6) && r() < 0.6) w = Math.floor(r() * 256);
    return w;
  });
}

class Bench {
  readonly sim: BitSim;
  private readonly nets = new Map<string, number[]>();
  constructor(roms: number[][]) {
    const design = flatten(accMachine(roms[0]));
    this.sim = new BitSim(design);
    design.leaves.forEach((leaf, i) => {
      if (leaf.kind === 'behavior' && leaf.def.id.startsWith('acc8_rom_')) {
        this.sim.setLaneBehavior(i, ([a], lane) => [a < 0 ? -1 : roms[lane % roms.length][a & 31] ?? 0]);
      }
    });
    const port = (path: string) => {
      const n = findNode(design.root, path.split('.'));
      if (!n) throw new Error(`no ${path}`);
      return n.ports.q;
    };
    for (const p of [ACC_STATE.pc, ACC_STATE.a, ACC_STATE.out, ...Array.from({ length: 32 }, (_, i) => `${ACC_STATE.ram}.w${i}`)]) this.nets.set(p, port(p));
    this.sim.settle();
  }
  read(path: string, lane: number): number {
    return this.nets.get(path)!.reduce((v, net, i) => v | (((this.sim.v[net] >>> lane) & 1) << i), 0);
  }
  state(lane: number) {
    return {
      pc: this.read(ACC_STATE.pc, lane), a: this.read(ACC_STATE.a, lane), out: this.read(ACC_STATE.out, lane),
      mem: Array.from({ length: 32 }, (_, i) => this.read(`${ACC_STATE.ram}.w${i}`, lane)),
    };
  }
}

describe('first computer: ISA and golden model', () => {
  it('is a Custom ISA preset whose encoding is op[7:5] x[4:0]', () => {
    expect(ISA_PRESETS.acc8).toBe(ACC8_PRESET);
    for (let w = 0; w < 256; w++) {
      const text = accDisasm(w);
      expect(text.split(/\s+/)[0]).toBe(ACC_OPS[w >> 5]);
      // Every word reassembles to itself, the OUT word's unused bits aside.
      const back = accAssemble(text)[0];
      expect(back, text).toBe(w >> 5 === 7 ? w & 0xe0 : w);
    }
  });

  it('runs the chapter\'s programs to the results the text quotes', () => {
    const mul = new AccISS(accAssemble(ACC_PROGRAMS.mul)).run();
    expect(mul.halted).toBe(true);
    expect(mul.outs).toEqual([{ value: 42, clock: mul.steps - 1 }]);
    const sum = new AccISS(accAssemble(ACC_PROGRAMS.sum)).run();
    expect(sum.outs.map((o) => o.value)).toEqual([55]);
    const cd = new AccISS(accAssemble(ACC_PROGRAMS.countdown)).run();
    expect(cd.outs.map((o) => o.value)).toEqual([5, 4, 3, 2, 1, 0]);
  });
});

describe('first computer at gate level', () => {
  it('control block equals its table', () => {
    const ctl = simulate(ACC_CTL);
    for (let op = 0; op < 8; op++) for (const z of [0, 1]) {
      const out = evalOnce(ctl, [op, z]);
      const got = Object.fromEntries(ACC_CTL_OUTS.map((n, i) => [n, out[i]]));
      const want = accControl(op, z);
      for (const n of ACC_CTL_OUTS) expect(got[n], `${ACC_OPS[op]} z=${z} ${n}`).toBe(want[n]);
    }
  });

  it('runs the chapter\'s programs in lock-step with the golden model', () => {
    const names = Object.keys(ACC_PROGRAMS) as (keyof typeof ACC_PROGRAMS)[];
    const roms = names.map((n) => accAssemble(ACC_PROGRAMS[n]));
    const bench = new Bench(roms);
    const isses = roms.map((w) => new AccISS(w));
    for (let c = 0; c < 120; c++) {
      isses.forEach((s) => s.step());
      bench.sim.cycle();
      isses.forEach((s, l) => expect(bench.state(l), `${names[l]} after cycle ${c + 1}`).toEqual(s.state()));
    }
    const halt = bench.sim.get('halt', roms.length);
    names.forEach((n, l) => expect(halt[l], n).toBe(n === 'fetch' ? 0 : 1));
    expect(bench.state(0).out).toBe(42);
  });

  it('matches the golden model on 64 random ROMs, every byte after every clock', () => {
    const seen = new Map<string, number>();
    for (const base of [1, 33]) {
      const roms = Array.from({ length: 32 }, (_, i) => randomRom(base + i));
      const bench = new Bench(roms);
      const isses = roms.map((w) => new AccISS(w));
      for (let c = 0; c < 300; c++) {
        isses.forEach((s) => { const op = ACC_OPS[s.word >> 5]; seen.set(op, (seen.get(op) ?? 0) + 1); s.step(); });
        bench.sim.cycle();
        for (let l = 0; l < roms.length; l++) {
          const hw = bench.state(l), want = isses[l].state();
          if (JSON.stringify(hw) !== JSON.stringify(want)) expect(hw, `seed ${base + l} after cycle ${c + 1}`).toEqual(want);
        }
      }
    }
    for (const o of ACC_OPS) expect(seen.get(o) ?? 0, o).toBeGreaterThan(50);
  });
});
