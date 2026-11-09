// The fault brush's simulator side (sim/faults.ts, docs/PLAN-ONI.md D): stuck-at as a rewrite every engine sees alike,
// flip once on a stored bit, slow as extra gate delays in GateSim and static timing; no faults is the identity.
import { describe, expect, it } from 'vitest';
import { counter } from '../src/lib/sequential';
import { rca } from '../src/lib/combinational';
import { BitSim } from '../src/sim/bitsim';
import { CycleSim } from '../src/sim/cyclesim';
import { DualSim } from '../src/sim/dualsim';
import { applyFaults, type FlatFault, faultsKey, flipBits, flipRamBit, seenNets } from '../src/sim/faults';
import { resolveProbe } from '../src/editor/probes';
import { bigRam } from '../src/lib/bigmem';
import { findNode, flatten, type FlatDesign } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { Sim } from '../src/sim/sim';
import { analyzeTiming } from '../src/sim/timing';
import { pack } from '../src/sim/values';
import type { ChipDoc } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { chip, compileLib, part, pin, wire } from './editorkit';

const out = (s: Sim, p: string) => pack(s.getBits(s.design.root.ports[p]));
const carry1 = (d: FlatDesign) => findNode(d.root, ['fa1'])!.ports.cin;

/** a + b + cin with the carry into bit 1 forced to `v`. */
function sumStuckC1(a: number, b: number, cin: number, v: number): number {
  const s0 = (a ^ b ^ cin) & 1;
  const hi = (a >> 1) + (b >> 1) + v;
  return ((hi << 1) | s0) & 31; // 4-bit sum and the carry out, as s | cout << 4
}

describe('no faults: the identity', () => {
  it('applyFaults with none returns the design itself, and its key is empty', () => {
    const d = flatten(rca(4));
    expect(applyFaults(d, []).design).toBe(d);
    expect(faultsKey([])).toBe('');
  });
});

describe('stuck at', () => {
  const d = flatten(rca(4));
  const faults: FlatFault[] = [{ kind: 'stuck0', nets: carry1(d) }];
  const { design: f, problems } = applyFaults(d, faults);

  it('copies what it changes: the healthy design and its shared arrays are untouched', () => {
    expect(problems).toEqual([]);
    expect(f).not.toBe(d);
    expect(f.netCount).toBe(d.netCount + 1);
    expect(f.leaves.length).toBe(d.leaves.length + 1);
    // every reader of the carry in the healthy design still reads it
    const c = carry1(d)[0];
    expect(d.leaves.some((l) => l.inputs.some((p) => p.includes(c)))).toBe(true);
    expect(f.leaves.some((l) => l.inputs.some((p) => p.includes(c)))).toBe(false);
    expect(findNode(f.root, ['fa1'])!.ports.cin).toEqual(carry1(d)); // the drawing keeps the driver's net
  });

  it('the same wrong sums on GateSim, CycleSim and BitSim, and the right ones on the healthy design', () => {
    const g = new GateSim(f), h = new GateSim(d);
    const c = CycleSim.build(f);
    expect(c).toBeInstanceOf(CycleSim);
    const cs = c as CycleSim;
    cs.reset('zero');
    const vecs: [number, number, number][] = [];
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let ci = 0; ci < 2; ci++) vecs.push([a, b, ci]);
    for (const [a, b, ci] of vecs) {
      const want = sumStuckC1(a, b, ci, 0);
      for (const s of [g, cs] as Sim[]) {
        s.setInput('a', a); s.setInput('b', b); s.setInput('cin', ci); s.settle();
        expect(out(s, 's') | (out(s, 'cout') << 4), `${s.kind} ${a}+${b}+${ci}`).toBe(want);
      }
      h.setInput('a', a); h.setInput('b', b); h.setInput('cin', ci); h.settle();
      expect(out(h, 's') | (out(h, 'cout') << 4)).toBe(a + b + ci);
    }
    // BitSim: 32 lanes at a time
    const bs = new BitSim(f);
    for (let k = 0; k < vecs.length; k += 32) {
      const chunk = vecs.slice(k, k + 32);
      bs.setInput('a', chunk.map((v) => v[0])); bs.setInput('b', chunk.map((v) => v[1])); bs.setInput('cin', chunk.map((v) => v[2]));
      bs.settle();
      const s = bs.get('s'), co = bs.get('cout');
      chunk.forEach(([a, b, ci], i) => expect(s[i] | (co[i] << 4), `BitSim ${a}+${b}+${ci}`).toBe(sumStuckC1(a, b, ci, 0)));
    }
  });

  it('stuck at 1 too, and a stuck net reaching an output pin reads stuck there', () => {
    const one = applyFaults(d, [{ kind: 'stuck1', nets: carry1(d) }]).design;
    const g = new GateSim(one);
    g.setInput('a', 0); g.setInput('b', 0); g.setInput('cin', 0); g.settle();
    expect(out(g, 's')).toBe(2);
    const cout = d.root.ports.cout;
    const st = applyFaults(d, [{ kind: 'stuck1', nets: cout }]).design;
    const g2 = new GateSim(st);
    g2.setInput('a', 0); g2.setInput('b', 0); g2.setInput('cin', 0); g2.settle();
    expect(out(g2, 'cout')).toBe(1);
    expect(d.root.ports.cout).toBe(cout); // the healthy root is not changed
  });

  it('clearing every fault gives the healthy circuit back bit for bit', () => {
    const g = new GateSim(f), h = new GateSim(applyFaults(d, []).design);
    g.setInput('a', 5); g.setInput('b', 6); g.setInput('cin', 1); g.settle();
    const cleared = new GateSim(d);
    cleared.carry(g);
    for (const s of [cleared, h]) { s.setInput('a', 5); s.setInput('b', 6); s.setInput('cin', 1); s.settle(); }
    expect(cleared.getBits(Array.from({ length: d.netCount }, (_, i) => i))).toEqual(h.getBits(Array.from({ length: d.netCount }, (_, i) => i)));
  });
});

describe('flip once', () => {
  it('a flip on a counter\'s bit 2 changes the count by 4, which then counts on from there', () => {
    for (const make of [(d: FlatDesign) => new GateSim(d), (d: FlatDesign) => { const s = new DualSim(d); s.preferFast = true; return s; }]) {
      const d = flatten(counter(4));
      const s = make(d);
      s.reset('zero');
      s.setInput('en', 1);
      const tick = () => { s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); };
      s.setInput('clk', 0); s.settle();
      for (let k = 0; k < 3; k++) tick();
      expect(out(s, 'q')).toBe(3);
      const held = flipBits(s, [d.root.ports.q[2]]);
      expect(held).toEqual([true]);
      expect(out(s, 'q')).toBe(7);
      tick();
      expect(out(s, 'q')).toBe(8);
    }
  });

  it('a net no loop holds does not keep a flip', () => {
    const d = flatten(rca(4));
    const g = new GateSim(d);
    g.setInput('a', 1); g.setInput('b', 0); g.setInput('cin', 0); g.settle();
    // a sum bit its gates compute: they put it back
    const s0 = findNode(d.root, ['fa0'])!.ports.s;
    expect(flipBits(g, s0)).toEqual([false]);
    expect(out(g, 's')).toBe(1);
  });

  it('a bit of a large memory\'s word, in its leaf state', () => {
    const d = flatten(bigRam(8, 8), { expand: (def, n) => n.parent === null || !def.preferBehavior });
    const g = new GateSim(d);
    g.reset('zero');
    const leaf = d.leaves.findIndex((l) => l.def.preferBehavior);
    const tick = () => { g.setInput('clk', 1); g.settle(); g.setInput('clk', 0); g.settle(); };
    g.setInput('clk', 0); g.setInput('addr', 9); g.setInput('din', 0x51); g.setInput('we', 1); g.settle(); tick();
    g.setInput('we', 0); g.settle();
    expect(out(g, 'dout')).toBe(0x51);
    expect(flipRamBit(g, leaf, 9, 3)).toBe(true);
    g.settle();
    expect(out(g, 'dout')).toBe(0x59);
    expect(flipRamBit(g, leaf, 300, 0)).toBe(false); // no such word
  });
});

describe('slow', () => {
  const d = flatten(counter(4));
  const healthy = analyzeTiming(d)!;
  const K = 6;
  // a NAND-driven net in the middle of the critical path
  const driverOf = (net: number) => d.leaves.findIndex((l) => l.outputs.some((p) => p.includes(net)));
  const net = healthy.nets.find((n, i) => i > 0 && d.leaves[driverOf(n)]?.kind === 'nand')!;
  const { design: slow, problems } = applyFaults(d, [{ kind: 'slow', nets: [net], delay: K }]);

  it('static timing: the period grows by the delay added on the critical path', () => {
    expect(problems).toEqual([]);
    expect(slow.extraDelay?.get(driverOf(net))).toBe(K);
    expect(slow.leaves).toBe(d.leaves); // CycleSim and BitSim see the healthy netlist
    expect(analyzeTiming(slow)!.period).toBe(healthy.period + K);
  });

  /** The counter clocked at a fixed period, as Stage does (view/stage.ts rise / fall). */
  function run(design: FlatDesign, P: number, cycles: number): number[] {
    const s = new GateSim(design);
    s.reset('zero');
    s.setInput('en', 1); s.setInput('clk', 0); s.settle();
    const seen: number[] = [];
    let next = s.time;
    for (let c = 0; c < cycles; c++) {
      const E = Math.max(s.time, next);
      s.runUntil(E);
      s.setInput('clk', 1);
      s.runUntil(E + Math.ceil(P / 2));
      s.setInput('clk', 0);
      s.runUntil(E + P);
      next = E + P;
      seen.push(out(s, 'q'));
    }
    return seen;
  }

  it('at the healthy period the slowed counter captures a wrong value; at the longer period it counts right', () => {
    const P = healthy.period, ok = Array.from({ length: 20 }, (_, i) => (i + 1) % 16);
    expect(run(d, P, 20)).toEqual(ok);
    expect(run(slow, P, 20)).not.toEqual(ok);
    expect(run(slow, P + K, 20)).toEqual(ok);
  });

  it('DualSim stays on GateSim with a slow fault and says why', () => {
    const s = new DualSim(slow);
    s.preferFast = true;
    s.reset('zero');
    s.setInput('en', 1);
    for (let k = 0; k < 40; k++) { s.setInput('clk', k & 1); s.settle(); }
    expect(s.engine).toBe('gate');
    expect(s.whyNot).toMatch(/slow fault/);
  });

  it('refuses what it cannot slow', () => {
    const add = flatten(rca(4));
    expect(applyFaults(add, [{ kind: 'slow', nets: add.root.ports.a, delay: 2 }]).problems[0]).toMatch(/input pin/);
    expect(applyFaults(add, [{ kind: 'slow', nets: [carry1(add)[0]], delay: 99 }]).problems[0]).toMatch(/1 to 32/);
  });
});

describe('in the sandbox (EditorSim)', () => {
  // a NOT gate between two pins; the fault sits on its input wire
  const base = (faults?: ChipDoc['faults']): ChipDoc => chip('u_f', 'F', {
    pins: [{ ...pin('a', 'in', [0, 2]), value: 0 }, pin('y', 'out', [20, 2])],
    parts: [part('n', { lib: 'not' }, [8, 0])],
    wires: [wire('w1', 'pin:a', 'n.a'), wire('w2', 'n.y', 'pin:y')],
    ...(faults ? { faults } : {}),
  });
  const run = (doc: ChipDoc) => {
    const es = new EditorSim({ debounceMs: 0 });
    es.update(compileLib(doc), doc.pins, doc);
    es.flush();
    const y = pack(es.pinBits('y')!), w1 = pack(es.wireBits('w1')!);
    // a probe's lane (analysis.ts) reads seenNets of the probe's nets: the value the wire is drawn with
    const r = resolveProbe({ wires: ['w1'] }, doc, es.built!, es.sim!.design)!;
    expect(pack(es.sim!.getBits(seenNets(es.sim!.design, r.nets)))).toBe(w1);
    const st = es.faults;
    es.destroy();
    return { y, w1, st };
  };

  it('a chip\'s fault is applied to its simulation, drawn on its wire; switched off it heals', () => {
    expect(run(base()).y).toBe(1);
    const on = run(base([{ id: 'f1', kind: 'stuck1', target: { wires: ['w1'] } }]));
    expect(on.y).toBe(0);
    expect(on.w1).toBe(1); // the wire shows what its readers read
    expect(on.st.applied.get('f1')?.length).toBe(1);
    expect(run(base([{ id: 'f1', kind: 'stuck1', target: { wires: ['w1'] }, off: true }])).y).toBe(1);
  });

  it('a fault whose wire is gone is kept, marked stale', () => {
    const r = run(base([{ id: 'f2', kind: 'stuck0', target: { wires: ['nope'] } }]));
    expect(r.st.stale.has('f2')).toBe(true);
    expect(r.y).toBe(1);
  });
});
