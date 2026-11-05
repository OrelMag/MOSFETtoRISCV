// A DSP core on the gates beside its golden model: every architectural register compared after every clock.
import { DualSim } from '../src/sim/dualsim';
import { findNode, flatten, type FlatDesign, type HierNode } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import type { Sim } from '../src/sim/sim';
import type { ComponentDef } from '../src/sim/types';
import { enc24, INSTRS24 } from '../src/dsp/isa24';
import { Iss24 } from '../src/dsp/iss24';
import { ramLeafState, ramWord } from '../src/lib/bigmem';
import { DSP24_STATE } from '../src/lib/dsp24core';

export type Mutator = (iss: Iss24) => void;

export class DspRig {
  readonly sim: Sim;
  readonly design: FlatDesign;
  readonly iss: Iss24;
  readonly mismatches: string[] = [];
  cycles = 0;
  private readonly node = new Map<string, HierNode>();

  constructor(readonly def: ComponentDef, program: number[], x: number[], y: number[], opts: { gate?: boolean; iss?: Iss24 } = {}) {
    this.design = flatten(def);
    if (opts.gate) {
      this.sim = new GateSim(this.design);
      this.sim.reset('zero');
    } else {
      const d = new DualSim(this.design);
      d.reset('zero');
      d.preferFast = true;
      d.prepare();
      this.sim = d;
    }
    this.iss = opts.iss ?? new Iss24(program, x, y);
    this.sim.setInput('clk', 0);
    this.sim.settle();
  }

  private n(path: string): HierNode {
    let h = this.node.get(path);
    if (!h) {
      h = findNode(this.design.root, path.split('.'))!;
      if (!h) throw new Error(`no ${path}`);
      this.node.set(path, h);
    }
    return h;
  }
  /** A register's value (path in DSP24_STATE), -1 if any bit is unknown. */
  reg(path: string, port = 'q'): number { return pack(this.sim.getBits(this.n(path).ports[port])); }
  top(port: string): number { return pack(this.sim.getBits(this.design.root.ports[port])); }
  mem(path: string, i: number): number {
    const st = ramLeafState(this.sim as unknown as { leafState(li: number): unknown }, this.n(path));
    return st ? ramWord(st, i) : -2;
  }

  /** The architectural state of the hardware, in the order of state(). */
  hwState(): Record<string, number> {
    const s: Record<string, number> = { pc: this.reg(DSP24_STATE.pc) };
    DSP24_STATE.r.forEach((p, i) => { s[`r${i}`] = this.reg(p); });
    DSP24_STATE.p.forEach((p, i) => { s[`p${i}`] = this.reg(p); });
    for (const k of ['xb', 'xl', 'xm', 'yb', 'yl', 'ym', 'ls', 'le', 'lc', 'la'] as const) s[k] = this.reg(DSP24_STATE[k]);
    s.acc = this.reg(DSP24_STATE.acc);
    return s;
  }
  issState(): Record<string, number> {
    const i = this.iss;
    const s: Record<string, number> = { pc: i.pc };
    for (let k = 0; k < 8; k++) s[`r${k}`] = i.r[k];
    for (let k = 0; k < 8; k++) s[`p${k}`] = i.p[k];
    Object.assign(s, { xb: i.xb, xl: i.xl, xm: i.xm, yb: i.yb, yl: i.yl, ym: i.ym, ls: i.ls, le: i.le, lc: i.lc, la: i.la });
    s.acc = Number(BigInt.asUintN(40, i.acc));
    return s;
  }

  /** One clock on both, then compare everything. Returns false at the first mismatch (recorded) or when halted. */
  step(): boolean {
    if (this.mismatches.length) return false;
    const was = this.iss.halted;
    const outv = this.top('outv'), out = this.top('out'), halt = this.top('halt');
    const st = this.iss.step();
    const at = `cycle ${this.cycles} pc ${st.pc} ${st.name}`;
    if (halt !== (st.name === 'halt' ? 1 : 0)) this.mismatches.push(`${at}: halt ${halt}`);
    if (outv !== (st.out !== undefined && !was ? 1 : 0)) this.mismatches.push(`${at}: outv ${outv}`);
    else if (st.out !== undefined && out !== st.out) this.mismatches.push(`${at}: out ${out} against ${st.out}`);
    this.sim.setInput('clk', 1); this.sim.settle();
    this.sim.setInput('clk', 0); this.sim.settle();
    this.cycles++;
    const a = this.hwState(), b = this.issState();
    for (const k of Object.keys(b)) if (a[k] !== b[k]) this.mismatches.push(`${at}: ${k} is ${a[k]} on the gates, ${b[k]} in the model`);
    if (st.store) {
      const v = this.mem(st.store.bus ? DSP24_STATE.yram : DSP24_STATE.xram, st.store.addr);
      if (v !== st.store.value) this.mismatches.push(`${at}: ${st.store.bus ? 'Y' : 'X'}[${st.store.addr}] is ${v}, expected ${st.store.value}`);
    }
    return !this.mismatches.length;
  }

  /** Run until the model halts (or max cycles) or a mismatch; two more clocks after the halt prove the PC holds. */
  run(max = 20000, every?: (i: number) => void): void {
    let extra = 0;
    for (let i = 0; i < max && !this.mismatches.length; i++) {
      this.step();
      every?.(i);
      if (this.iss.halted && ++extra > 2) break;
    }
  }

  /** Every word of X and Y against the model. */
  memoryMismatch(): string | null {
    for (let i = 0; i < 256; i++) {
      if (this.mem(DSP24_STATE.xram, i) !== this.iss.x[i]) return `X[${i}] is ${this.mem(DSP24_STATE.xram, i)}, expected ${this.iss.x[i]}`;
      if (this.mem(DSP24_STATE.yram, i) !== this.iss.y[i]) return `Y[${i}] is ${this.mem(DSP24_STATE.yram, i)}, expected ${this.iss.y[i]}`;
    }
    return null;
  }
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random 24-bit word that is a real instruction (random operands within what the encodings hold), or a raw one. */
export function randomWord(r: () => number): number {
  const int = (n: number) => Math.floor(r() * n);
  const x = r();
  if (x < 0.15) return int(1 << 24);
  const i = INSTRS24[int(INSTRS24.length)];
  const mode = () => (r() < 0.25 ? int(8) : 1 + int(3));
  switch (i.shape) {
    case '': return i.op << 19;
    case 'rrr': return enc24.rrr(i.op, int(8), int(8), int(8));
    case 'rri': return enc24.rri(i.op, int(8), int(8), int(256));
    case 'ri': return enc24.ri(i.op, int(8), int(256));
    case 'mov': return enc24.mov(i.op, int(24), int(24));
    case 'ldi': return enc24.ldi(i.op, int(24), int(1 << 14));
    case 'mem2': return enc24.mem2(i.op, mode(), int(4), mode(), int(4));
    case 'memld': return enc24.ld(i.op, int(8), mode(), int(4), int(2));
    case 'memst': return enc24.st(i.op, int(8), mode(), int(4), int(2));
    case 'r': return enc24.r(i.op, int(8));
    case 'rsh': return enc24.rsh(i.op, int(8), int(64));
    case 'loop': return enc24.loop(i.op, int(2), r() < 0.8 ? 1 + int(6) : int(1024), int(256));
    case 'a': return enc24.a(i.op, int(256));
    case 'ra': return enc24.ra(i.op, int(8), int(256));
  }
}

export function randomProgram(seed: number): { words: number[]; x: number[]; y: number[] } {
  const r = rng(seed);
  const words = Array.from({ length: 256 }, () => randomWord(r));
  // keep the program from halting at once and from jumping about wildly: the first words are plain
  for (let i = 0; i < 3; i++) words[i] = enc24.ldi(3, i === 0 ? 8 : 12 + i, 1 + Math.floor(r() * 200));
  return { words, x: Array.from({ length: 256 }, () => Math.floor(r() * 65536)), y: Array.from({ length: 256 }, () => Math.floor(r() * 65536)) };
}

