// The PDP-8 in gates (lib/pdp8.ts) in lock step with its golden model (src/pdp8/pdp8.ts): the processor on BitSim, one
// program per lane, its core a JS array per lane read at once and written at the edge. After every instruction the gates
// finish, the model steps once and AC, L, MQ, PC, ION, RUN, the printer flag, what was printed and the core must agree.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { PDP8_CORE, PDP8_STATE } from '../src/lib/pdp8';
import { Pdp8 } from '../src/pdp8/pdp8';
import { assemblePdp8, PDP8_HELLO } from '../src/pdp8/programs';
import { BitSim } from '../src/sim/bitsim';
import { findNode, flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';

const LANES = 32;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Lane { mem: Uint16Array; model: Pdp8; keys: number[]; out: string; waitInt: boolean; done: boolean; checks: number }

class Bench {
  readonly sim: BitSim;
  private readonly nets = new Map<string, number[]>();
  readonly lanes: Lane[];
  constructor(programs: { words: ArrayLike<number>; start: number; keys?: string }[]) {
    const design = flatten(PDP8_CORE);
    this.sim = new BitSim(design);
    for (const [k, p] of Object.entries(PDP8_STATE)) {
      const n = findNode(design.root, p.split('.'));
      if (!n) throw new Error(`no ${p}`);
      this.nets.set(k, n.ports.q);
    }
    this.lanes = programs.map((p) => {
      const mem = new Uint16Array(4096);
      for (let i = 0; i < p.words.length; i++) mem[i] = p.words[i] & 0o7777;
      return { mem, model: new Pdp8(p.words), keys: [], out: '', waitInt: false, done: false, checks: 0 };
    });
    for (const p of ['sr', 'ld', 'dep', 'exam', 'start', 'cont', 'stop', 'sstep', 'kcode', 'kready', 'dout']) this.sim.setInput(p, 0);
    // LOAD ADD, START: on the gates and the model alike; then the keys typed
    this.sim.setInput('sr', programs.map((p) => p.start));
    this.cycle({ ld: 1 });
    this.cycle({ start: 1 });
    programs.forEach((p, i) => {
      const m = this.lanes[i].model;
      m.sr = p.start; m.loadAddress(); m.start();
      if (p.keys) { m.type(p.keys); this.lanes[i].keys = [...p.keys].map((c) => 0o200 | (c.charCodeAt(0) & 0o177)); }
    });
  }
  read(k: keyof typeof PDP8_STATE, lane: number): number {
    return this.nets.get(k)!.reduce((v, net, i) => v | (((this.sim.v[net] >>> lane) & 1) << i), 0);
  }
  /** One clock: the keys held for it, the core served, then the edge. Returns which lanes retired an instruction. */
  cycle(keys: Record<string, number> = {}): boolean[] {
    for (const k of ['ld', 'dep', 'exam', 'start', 'cont', 'stop', 'sstep']) this.sim.setInput(k, keys[k] ?? 0);
    this.sim.setInput('kcode', this.lanes.map((l) => l.keys[0] ?? 0));
    this.sim.setInput('kready', this.lanes.map((l) => (l.keys.length ? 1 : 0)));
    this.sim.settle();
    const addr = this.sim.get('maddr', this.lanes.length);
    this.sim.setInput('dout', this.lanes.map((l, i) => l.mem[addr[i]]));
    this.sim.settle();
    const n = this.lanes.length;
    const [a, din, we, td, twe, kack, ret] = ['maddr', 'din', 'mwe', 'tdata', 'twe', 'kack', 'retire'].map((p) => this.sim.get(p, n));
    this.sim.cycle();
    this.lanes.forEach((l, i) => {
      if (we[i] === 1) l.mem[a[i]] = din[i];
      if (twe[i] === 1 && td[i] !== 0) l.out += String.fromCharCode(td[i]);
      if (kack[i] === 1) l.keys.shift();
    });
    return ret.map((r) => r === 1);
  }
  state(i: number) {
    const r = (k: keyof typeof PDP8_STATE) => this.read(k, i);
    return { pc: r('pc'), ac: r('ac'), l: r('l'), mq: r('mq'), ie: r('ie'), run: r('run'), prn: r('prn'), out: this.lanes[i].out };
  }
}

const modelState = (m: Pdp8) => ({ pc: m.pc, ac: m.ac, l: m.l, mq: m.mq, ie: m.ie ? 1 : 0, run: m.run ? 1 : 0, prn: m.prn ? 1 : 0, out: m.out });

/** Runs every lane until its model halts (or `cycles`), comparing after each instruction. */
function lockStep(bench: Bench, cycles: number, name: (i: number) => string): void {
  for (let c = 0; c < cycles && bench.lanes.some((l) => !l.done); c++) {
    const retired = bench.cycle();
    bench.lanes.forEach((l, i) => {
      if (l.done) return;
      if (l.waitInt) { l.waitInt = false; } // the interrupt cycle after an instruction: the model did both in one step
      else if (retired[i]) {
        const s = l.model.step(); (l as Lane & { last?: string }).last = `${s.pc.toString(8)}: ${s.word.toString(8)}`;
        if (s.interrupt) { l.waitInt = true; return; }
      } else return;
      expect(bench.state(i), `${name(i)} after ${(l as Lane & { last?: string }).last}, instruction ${l.model.instructions} (cycle ${c})`).toEqual(modelState(l.model));
      l.checks++;
      if (!l.model.run) l.done = true;
    });
  }
  bench.lanes.forEach((l, i) => expect([...l.mem], `${name(i)}: core`).toEqual([...l.model.mem]));
}

/** Directed programs: each feature the control unit decides, with what it must leave behind. */
const DIRECTED: { id: string; src: string; start?: number; keys?: string }[] = [
  { id: 'hello', src: PDP8_HELLO.src, start: PDP8_HELLO.start },
  { id: 'group 1', src: `.org 200
    CLA CLL CMA IAC
    RAL
    RTL
    RAR
    RTR
    CML
    BSW
    CIA
    STL
    STA
    IAC
    RAL RAR
    HLT` },
  { id: 'group 2 skips', src: `.org 200
    CLA CLL
    SZA
    HLT
    SNA
    TAD m
    SMA
    HLT
    SPA SNA
    STL
    SNL
    HLT
    SZL
    CLA OSR
    SKP
    HLT
    HLT
m:  .word 7000` },
  { id: 'group 3', src: `.org 200
    TAD a
    MQL
    TAD b
    MQA
    SWP
    CLA SWP
    CAM
    TAD a
    MQL MQA
    HLT
a:  .word 1234
b:  .word 0070` },
  { id: 'memory reference', src: `.org 200
    TAD a
    AND b
    DCA c
    TAD c
loop: ISZ n
    JMP loop
    JMS sub
    TAD I p
    JMP I q
    HLT
sub: .word 0
    IAC
    JMP I sub
done: HLT
a:  .word 7741
b:  .word 0177
c:  .word 0
n:  .word 7775
p:  .word a
q:  .word done` },
  { id: 'auto-index', src: `.org 10
x:  .word 377
.org 200
    CLA
    TAD I x
    TAD I x
    DCA I x
    TAD x
    HLT
.org 400
    .word 1, 2, 0` },
  { id: 'interrupts and keyboard', start: 0o200, keys: 'OK', src: `.org 0
    .word 0
    JMP I v
v:  .word srv
.org 200
    ION
idle: JMP idle
srv: KSF
    JMP out
    KRB
    TLS
    ISZ cnt
    JMP back
    HLT
out: TCF
back: ION
    JMP I 0
cnt: .word 7776` },
];

describe('the PDP-8 in gates', () => {
  it('runs each directed program in lock step with the golden model', () => {
    const progs = DIRECTED.map((p) => {
      const r = assemblePdp8(p.src);
      expect(r.errors, p.id).toEqual([]);
      return { ...p, words: r.words, start: p.start ?? 0o200 };
    });
    const bench = new Bench(progs);
    lockStep(bench, 6000, (i) => DIRECTED[i].id);
    bench.lanes.forEach((l, i) => expect(l.done, `${DIRECTED[i].id} halted`).toBe(true));
    expect(bench.lanes[0].out).toBe(PDP8_HELLO.prints);
    expect(bench.lanes[6].out).toBe('OK');
  });

  it('matches the model on 32 random cores, every instruction for 3000 clocks', () => {
    const r = rng(8);
    const progs = Array.from({ length: LANES }, () => {
      const words = Array.from({ length: 4096 }, () => {
        let w = Math.floor(r() * 4096);
        if ((w & 0o7401) === 0o7400) w &= ~2; // no HLT: a halt with an interrupt pending is where the model and DEC differ
        return w;
      });
      return { words, start: Math.floor(r() * 4096) };
    });
    const bench = new Bench(progs);
    lockStep(bench, 3000, (i) => `random core ${i}`);
    // a core may write a HLT into itself and stop there: every other lane keeps running
    for (const l of bench.lanes) if (!l.done) expect(l.checks).toBeGreaterThan(900);
    expect(bench.lanes.filter((l) => !l.done).length).toBeGreaterThan(24);
  });

  it('acts on a front panel key once however long it is held', () => {
    const bench = new Bench([{ words: [], start: 0o200 }]);
    for (let c = 0; c < 4; c++) bench.cycle({ stop: 1 });
    expect(bench.state(0).run).toBe(0);
    bench.sim.setInput('sr', 0o300);
    for (let c = 0; c < 3; c++) bench.cycle({ ld: 1 });
    bench.sim.setInput('sr', 0o1234);
    for (let c = 0; c < 3; c++) bench.cycle({ dep: 1 });
    expect(bench.lanes[0].mem[0o300]).toBe(0o1234);
    expect(bench.lanes[0].mem[0o301]).toBe(0);
    expect(bench.state(0).pc).toBe(0o301);
    for (let c = 0; c < 3; c++) bench.cycle({ sstep: 1 }); // one instruction: 0301 holds AND 0
    expect(bench.state(0).pc).toBe(0o302);
  });

  it('counts its NANDs', () => {
    const s = stats(PDP8_CORE);
    expect(s.nands).toBeGreaterThan(2000);
    console.log('PDP-8 processor:', s.nands, 'NANDs');
  });
});
