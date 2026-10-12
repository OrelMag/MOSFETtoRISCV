import { describe, expect, it } from 'vitest';
import { cachedMemory, dualCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { registry } from '../src/lib/define';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { deadInstances } from '../src/sim/dead';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, symbolOverlaps } from '../src/view/route';
import { orGloss } from '../src/view/symbols';
import { boxText, boxTextOverlaps, ICON, iconSpot, labelRect, portTextRect } from '../src/view/boxtext';
import { counter } from '../src/lib/sequential';
import { symbolGeom } from '../src/sim/geometry';
import { families, initialParams } from '../src/lib/resolve';
import { bigMemTops, cpuTops } from './tops';
import { rv16Core } from '../src/lib/rv16/cpu';
import { rv16Pipe } from '../src/lib/rv16/pipe';
import { rv16SysCore } from '../src/lib/rv16/system';

// Build the parametric designs the chapters show, so their schematics are in the registry too.
const words = assemble(PROGRAMS[0].source).words;
singleCycleCpu(words);
singleCycleCpu(words, { adder: 'ks' });
pipelinedCpu(words, { adder: 'ks', balanced: true, predictor: true });
pipelinedCpu(words);
systemCpu(words, { m: true });
multicycleCpu(words, { control: 'fsm' });
multicycleCpu(words, { control: 'micro' });
dualCore(words);
cachedMemory(6, 2);
// Every workbench family as it first opens.
for (const f of families) f.make(initialParams(f));
// The campaign's RV16 cores (built on demand, by the levels' reference answers).
for (const full of [false, true]) rv16Core(full);
rv16Core(true, true); rv16Core(true, false, 'mul'); rv16Core(true, false, 'div');
rv16SysCore(false); rv16SysCore(true);
for (const o of [{ fwd: false, stall: false, flush: false }, { fwd: true, stall: false, flush: false }, { fwd: true, stall: true, flush: false },
  { fwd: true, stall: true, flush: true }, { fwd: true, stall: true, flush: true, sys: true }, { fwd: true, stall: true, flush: true, predict: true }]) rv16Pipe(o);

describe('schematic labels', () => {
  // the top-level CPUs are not registered (only their parts are): add them explicitly
  const tops = [...cpuTops(), ...bigMemTops()];
  const defs = [...new Set([...registry.values(), ...tops])].filter((d) => d.netlist);
  it.each(defs.map((d) => [d.id, d] as const))('%s: no label hides another', (_, d) => {
    expect(labelOverlaps(d, netlistOf(d)!)).toEqual([]);
  });
  it.each(defs.map((d) => [d.id, d] as const))('%s: no symbol sits on another', (_, d) => {
    expect(symbolOverlaps(netlistOf(d)!)).toEqual([]);
  });
  it.each(defs.map((d) => [d.id, d] as const))('%s: no wire reaches a pin from behind its symbol', (_, d) => {
    expect(backwardEnds(d, netlistOf(d)!)).toEqual([]);
  });
});

describe('dead parts', () => {
  const defs = [...new Set([...registry.values(), ...cpuTops()])].filter((d) => d.netlist);
  it.each(defs.map((d) => [d.id, d] as const))('%s: every part reaches an output', (_, d) => {
    expect(deadInstances(netlistOf(d)!, d.ports)).toEqual([]);
  });
});

describe('cartoon gloss', () => {
  it('stays inside an OR-family body at every height', () => {
    const half = 0.13 + 0.15; // half the gloss stroke + the body outline (cartoon widths)
    for (const [x0, bw] of [[0, 4], [0, 3.4], [0.45, 4], [0.45, 3.4]]) for (let n = 2; n <= 8; n++) {
      const h = Math.max(4, 2 * n), L = bw - x0;
      // The body's three edges, sampled: top Q (x0,0) (x0+0.6L,0) (bw,h/2), its mirror, the back Q through (x0+0.55,h/2).
      const edge: [number, number][] = [];
      for (let i = 0; i <= 400; i++) {
        const t = i / 400, x = x0 + L * (1.2 * t - 0.2 * t * t), y = t * t * h / 2;
        edge.push([x, y], [x, h - y], [x0 + 1.1 * t * (1 - t), h * t]);
      }
      for (const [x, y] of orGloss(x0, bw, h)) {
        const at = `x0 ${x0} bw ${bw} h ${h}: (${x.toFixed(2)}, ${y.toFixed(2)})`;
        const top = edge.filter((_, i) => i % 3 === 0).reduce((a, p) => (Math.abs(p[0] - x) < Math.abs(a[0] - x) ? p : a));
        expect(y, at).toBeGreaterThan(top[1]); // below the top edge, not above it
        expect(x, at).toBeGreaterThan(x0);
        expect(Math.min(...edge.map(([ex, ey]) => Math.hypot(ex - x, ey - y))), at).toBeGreaterThan(half);
      }
    }
  });
});

describe('box symbol text', () => {
  // every registered box (with a structure or not), and the sandbox's own displays and I/O parts
  const boxes = [...registry.values()].filter((d) => d.symbol.kind === 'box');
  it.each(boxes.map((d) => [d.id, d] as const))('%s: no port name or label hides another', (_, d) => {
    expect(boxTextOverlaps(d)).toEqual([]);
  });
  it('a short box with a clock at the bottom lifts its label clear of the clock\'s name', () => {
    const c = counter(8), t = boxText(c);
    const clk = t.ports.find((p) => p.name === 'clk')!;
    expect(t.label!.y).toBeLessThan(symbolGeom(c).h / 2 + 0.45);
    expect(t.label!.y).toBeLessThan(clk.y - 0.8);
  });
  it('the cartoon icon sits inside the box, clear of every port name and the label, mirrored or not', () => {
    const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    let placed = 0;
    for (const d of boxes) for (const flip of [false, true]) {
      const t = boxText(d, flip), spot = iconSpot(d, t);
      if (!spot) continue;
      placed++;
      const { w, h } = symbolGeom(d);
      const r = { x: spot.x, y: spot.y, w: ICON, h: ICON };
      expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h, d.id).toBe(true);
      for (const q of [...t.ports.map(portTextRect), ...(t.label ? [labelRect(t.label)] : [])]) expect(hit(q, r), d.id).toBe(false);
    }
    expect(placed).toBeGreaterThan(boxes.length / 3);
    for (const id of ['regfile']) if (registry.get(id)) expect(iconSpot(registry.get(id)!, boxText(registry.get(id)!)), id).not.toBeNull();
  });
  it('a constant prints no port name', () => {
    expect(boxText(registry.get('tie1')!).ports).toEqual([]);
  });
});
