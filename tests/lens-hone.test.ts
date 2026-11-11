// The lens honed (docs/transparent/DESIGN.md "Revision 3: inside the box"): a block's inside is drawn within its own
// outline, opens past the legibility floor and closes below CLOSE_SHARE of it. These tests make that predictable without a
// page: scripted zoom traces never flicker, the inside never leaves the outline, the answer for a box at a zoom depends on
// nothing but the box, its inside and (inside the band only) whether it was open, the author's register opens, the
// hand-off does not jump, and zooming out always gives the symbol back.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { orientGeom } from '../src/sim/geometry';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import {
  BOX_MIN_PX, CLOSE_SHARE, FLOOR_PX, INSET, decide, fitInside, handOffView, handsOff, insideExtent, openAtPx,
  smallestNamed, type Rect,
} from '../src/view/lensplan';

/** The CPUs on the fib program, as the chapters show them. */
const FIB = assemble(PROGRAMS.find((p) => p.name === 'Fibonacci')!.source).words;
const SC = () => singleCycleCpu(FIB), PIPE = () => pipelinedCpu(FIB);

/** A seeded generator, so a failing property names its case. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Every open / closed answer along a zoom trace (px per outer unit, one per settled step), from closed. */
function play(trace: number[], openAt: number, start = false): boolean[] {
  const out: boolean[] = [];
  let open = start;
  for (const px of trace) out.push((open = decide(open, px, openAt)));
  return out;
}
const flips = (states: boolean[], start = false) => states.reduce((n, s, i) => n + (s !== (i ? states[i - 1] : start) ? 1 : 0), 0);

/** The inside's extent as the rule reads it (lensplan.ts insideExtent: parts, pin glyphs, the view's margin). */
const hullOf = (def: ComponentDef): Rect => insideExtent(def)!;

/** A box on a CPU's top level: its outline (outer grid units) and its definition. */
function boxOf(top: ComponentDef, name: string): { box: Rect; def: ComponentDef } {
  const i = netlistOf(top)!.instances.find((n) => n.name === name)!;
  const g = orientGeom(i.def, i.flip, i.rot);
  const [x, y] = i.at ?? [0, 0];
  return { box: { x, y, w: g.w, h: g.h }, def: i.def };
}

/** openAtPx for a box with its inside's extent. */
const openAtFor = (box: Rect, def: ComponentDef, extent = hullOf(def)) => openAtPx(box, fitInside(box, extent).k, smallestNamed(def));

describe('the open / close rule over scripted zoom traces', () => {
  const at = 20;

  it('outside the band the answer is the geometry\'s alone, inside it the previous answer\'s alone', () => {
    for (let px = 0; px <= 3 * at; px += 0.05) {
      const a = decide(false, px, at), b = decide(true, px, at);
      if (px >= at) expect([a, b]).toEqual([true, true]);
      else if (px < CLOSE_SHARE * at) expect([a, b]).toEqual([false, false]);
      else expect([a, b]).toEqual([false, true]);
    }
    // the edges of the band, exactly
    expect(decide(false, at, at)).toBe(true);
    expect(decide(true, CLOSE_SHARE * at, at)).toBe(true);
    expect(decide(true, CLOSE_SHARE * at - 1e-9, at)).toBe(false);
  });

  it('a steady zoom in opens once, at the first step past the floor; a steady zoom out closes once, below ¾ of it', () => {
    const steps = Array.from({ length: 40 }, (_, i) => 5 * 1.1 ** i);
    const zin = play(steps, at);
    expect(flips(zin)).toBe(1);
    expect(steps[zin.indexOf(true)]).toBeGreaterThanOrEqual(at);
    expect(steps[zin.indexOf(true) - 1]).toBeLessThan(at);
    const back = [...steps].reverse();
    const zout = play(back, at, true);
    expect(flips(zout, true)).toBe(1);
    expect(back[zout.indexOf(false)]).toBeLessThan(CLOSE_SHARE * at);
    expect(back[zout.indexOf(false) - 1]).toBeGreaterThanOrEqual(CLOSE_SHARE * at);
  });

  it('a wobble across the floor never flickers: a trackpad\'s jitter of up to ±12 % flips it at most once', () => {
    const r = rng(7);
    for (let run = 0; run < 200; run++) {
      // hovering around the opening zoom: within ±12 % of it, under the band's 25 %
      const trace = Array.from({ length: 60 }, () => at * (1 + (r() - 0.5) * 0.24));
      expect(flips(play(trace, at))).toBeLessThanOrEqual(1);
      expect(flips(play(trace, at, true), true)).toBe(0);
    }
  });

  it('a back-and-forth zoom flips only when it crosses the far edge of the band', () => {
    // in past the floor, out to just above ¾, in again, out below ¾
    const trace = [10, 15, 21, 18, 16, 15.1, 17, 19.9, 14.9, 12];
    expect(play(trace, at)).toEqual([false, false, true, true, true, true, true, true, false, false]);
  });

  it('a box that cannot open (no inside) never opens at any zoom', () => {
    expect(openAtPx({ w: 4, h: 4 }, 0, 6)).toBe(Infinity);
    expect(openAtPx({ w: 4, h: 4 }, 0.5, 0)).toBe(Infinity);
    expect(play([1, 10, 100, 1e6], Infinity).some(Boolean)).toBe(false);
  });
});

describe('the inside stays within the box\'s outline', () => {
  it('letterboxed and centred, whatever the shapes (2 000 random boxes and insides)', () => {
    const r = rng(11);
    for (let n = 0; n < 2000; n++) {
      const box = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200, w: 2 + r() * 60, h: 2 + r() * 120 };
      const extent = { x: (r() - 0.5) * 50, y: (r() - 0.5) * 50, w: 1 + r() * 300, h: 1 + r() * 300 };
      const f = fitInside(box, extent);
      const e = 1e-9;
      // inside the outline, clear of the ports' inset
      expect(f.x).toBeGreaterThanOrEqual(box.x + INSET - e);
      expect(f.y).toBeGreaterThanOrEqual(box.y + INSET - e);
      expect(f.x + f.w).toBeLessThanOrEqual(box.x + box.w - INSET + e);
      expect(f.y + f.h).toBeLessThanOrEqual(box.y + box.h - INSET + e);
      // the inside's own shape, one scale both ways
      expect(f.w / extent.w).toBeCloseTo(f.k, 9);
      expect(f.h / extent.h).toBeCloseTo(f.k, 9);
      // centred, and as large as fits: it touches the inset on one pair of sides
      expect(f.x - box.x).toBeCloseTo(box.x + box.w - (f.x + f.w), 9);
      expect(f.y - box.y).toBeCloseTo(box.y + box.h - (f.y + f.h), 9);
      expect(Math.min(box.w - 2 * INSET - f.w, box.h - 2 * INSET - f.h)).toBeCloseTo(0, 9);
    }
  });

  it('a box too small for its inset draws nothing, and so never opens', () => {
    const f = fitInside({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 10, h: 10 });
    expect(f.k).toBe(0);
    expect(openAtPx({ w: 1, h: 1 }, f.k, 6)).toBe(Infinity);
  });

  it('a pipeline register\'s inside fills the box\'s width, centred in its height (wider than the box\'s shape)', () => {
    const { box, def } = boxOf(PIPE(), 'FD');
    const e = hullOf(def), f = fitInside(box, e);
    // its inside is wider for its height than a 3 × 74 box: the width decides, the bands are above and below
    expect(e.w / e.h).toBeGreaterThan(box.w / box.h);
    expect(f.w).toBeCloseTo(box.w - 2 * INSET, 9);
    expect(f.y - box.y).toBeGreaterThan(INSET);
    expect(f.y - box.y).toBeCloseTo(box.y + box.h - (f.y + f.h), 9);
  });
});

describe('no hidden state: a box at a zoom gets the same answer whatever came before', () => {
  const sc = SC();
  const names = netlistOf(sc)!.instances.filter((i) => !i.def.prim && netlistOf(i.def)).map((i) => i.name);

  it('openAtPx is a constant of the box: the same in any order, after any other box, any number of times', () => {
    const first = new Map(names.map((n) => [n, openAtFor(boxOf(sc, n).box, boxOf(sc, n).def)]));
    const r = rng(3);
    for (let run = 0; run < 5; run++) {
      const order = [...names].sort(() => r() - 0.5);
      for (const n of order) expect(openAtFor(boxOf(sc, n).box, boxOf(sc, n).def)).toBe(first.get(n));
    }
  });

  it('two instances of one definition at one zoom always agree (no refusal remembered)', () => {
    const pipe = PIPE();
    // the four pipeline registers are different definitions of one shape; the operand muxes are one definition
    const a = boxOf(pipe, 'srcA'), b = boxOf(pipe, 'srcB');
    expect(a.def).toBe(b.def);
    const oa = openAtFor(a.box, a.def), ob = openAtFor(b.box, b.def);
    expect(oa).toBe(ob);
    // whatever the one was before, the other at the same zoom outside the band answers alike
    for (const px of [oa * 0.5, oa * 0.7, oa, oa * 2]) {
      expect(decide(true, px, oa)).toBe(decide(false, px, ob) || (px >= CLOSE_SHARE * oa && px < oa));
    }
  });

  it('smallestNamed reads the netlist only: a fresh copy of the definition gives the same floor', () => {
    for (const n of names) {
      const d = boxOf(sc, n).def;
      expect(smallestNamed({ ...d })).toBe(smallestNamed(d));
    }
  });

  it('the rule takes no stage, panel or neighbour: its inputs are the box\'s size, its inside and the zoom', () => {
    // a signature check: if a cover or a canvas creeps back into the rule, this fails before any smoke does
    expect(openAtPx.length).toBe(3);
    expect(decide.length).toBe(3);
    expect(fitInside.length).toBe(2);
  });
});

describe('the author\'s bug: a register beside other modules opens once zoomed enough', () => {
  const pipe = PIPE();

  it('the pipeline register FD (3 × 74) opens at about 44 px per unit, decided by its inside alone', () => {
    const { box, def } = boxOf(pipe, 'FD');
    expect([box.w, box.h]).toEqual([3, 74]);
    const at = openAtFor(box, def), k = fitInside(box, hullOf(def)).k;
    // the floor term decides (its smallest named block reaches FLOOR_PX there); BOX_MIN_PX alone would allow 64 / 3
    expect(at).toBeCloseTo(FLOOR_PX / (k * smallestNamed(def)), 9);
    expect(at).toBeGreaterThan(BOX_MIN_PX / 3);
    // a zoom the wheel reaches (the floating lens's opening of FD was 1 936 px tall, three stages high, and never stayed)
    expect(at).toBeLessThan(60);
  });

  it('the four pipeline registers open at nearly the same zoom, so they open together', () => {
    const ats = ['FD', 'DE', 'EM', 'MW'].map((n) => openAtFor(boxOf(pipe, n).box, boxOf(pipe, n).def));
    for (const a of ats) expect(Math.abs(a / ats[0] - 1)).toBeLessThan(0.1);
  });

  it('Rock\'s opening zooms on the fib program, px per unit within 1 % (single-cycle and pipelined CPUs)', () => {
    const want: [() => ComponentDef, string, number][] = [
      [SC, 'pc', 35.16], [SC, 'alu', 27.5], [SC, 'rf', 31.11], [SC, 'imm', 16.0], [SC, 'ctl', 3.61], [SC, 'npc', 21.5],
      [PIPE, 'FD', 43.9], [PIPE, 'DE', 43.9], [PIPE, 'hz', 12.2],
    ];
    const got = want.map(([top, n]) => { const { box, def } = boxOf(top(), n); return [n, openAtFor(box, def)] as const; });
    for (const [i, [n, v]] of got.entries()) expect(Math.abs(v / want[i][2] - 1), `${n}: ${v}`).toBeLessThan(0.01);
    // imm opens as soon as its shorter side is BOX_MIN_PX; ctl just past that, at its floor
    expect(got[3][1]).toBeCloseTo(BOX_MIN_PX / 4, 9);
    expect(got[4][1]).toBeGreaterThan(BOX_MIN_PX / 18);
  });

  it('zoomed in step by step it opens, and stays open while the learner pans and nudges the zoom', () => {
    const { box, def } = boxOf(pipe, 'FD');
    const at = openAtFor(box, def);
    // wheel steps of 10 % from the whole CPU in view, then panning (same zoom) with small zoom corrections
    const zin = Array.from({ length: 40 }, (_, i) => 6 * 1.1 ** i).filter((px) => px < at * 1.15);
    const settle = [at * 1.05, at * 1.05, at * 0.97, at * 0.9, at * 1.02, at * 0.95];
    const states = play([...zin, ...settle], at);
    expect(states.at(zin.length - 1)).toBe(true);
    expect(states.slice(zin.length)).toEqual(settle.map(() => true));
    expect(flips(states)).toBe(1);
  });

  // the floating lens's rule (removed with it, DESIGN.md R3.8), kept here as the regression's fixture: open at 96 px on the
  // shorter side, close when more than half of the box is outside the stage
  const opensAt = (b: { x: number; y: number; w: number; h: number }) => Math.min(b.w, b.h) >= 96;
  const closesAt = (b: { x: number; y: number; w: number; h: number }, st: { x: number; y: number; w: number; h: number }) => {
    const iw = Math.max(0, Math.min(b.x + b.w, st.x + st.w) - Math.max(b.x, st.x)), ih = Math.max(0, Math.min(b.y + b.h, st.y + st.h) - Math.max(b.y, st.y));
    return iw * ih < (b.w * b.h) / 2;
  };
  it('the old rule closed it as soon as it opened; the new one opens it at a finite zoom with no stage at all', () => {
    const { box, def } = boxOf(pipe, 'FD');
    const at = openAtFor(box, def);
    expect(Number.isFinite(at)).toBe(true);
    // the floating lens opened at 96 px on the shorter side, 32 px a unit for a 3-unit-wide box: 2 368 px tall, more than
    // half outside any stage, so closesAt shut it on the next step, and again at every zoom from there on
    const stage = { x: 0, y: 0, w: 1280, h: 800 };
    for (const px of [96 / 3, at, at * 1.5]) {
      expect(opensAt({ x: 0, y: 0, w: box.w * px, h: box.h * px })).toBe(true);
      expect(closesAt({ x: 100, y: -200, w: box.w * px, h: box.h * px }, stage)).toBe(true);
    }
    // the new rule has no stage to be half outside of: open from its opening zoom on, wherever the box sits
    for (const px of [at, at * 1.5, at * 4]) expect(decide(false, px, at)).toBe(true);
  });

  it('the single-cycle CPU\'s boxes all open at a finite zoom, and only past their short side\'s 64 px', () => {
    const sc = SC();
    for (const n of ['pc', 'alu', 'rf', 'imm', 'ctl', 'npc']) {
      const { box, def } = boxOf(sc, n);
      const at = openAtFor(box, def);
      expect(Number.isFinite(at)).toBe(true);
      expect(Math.min(box.w, box.h) * at).toBeGreaterThanOrEqual(BOX_MIN_PX - 1e-9);
    }
  });
});

describe('the hand-off to the drilled level does not jump', () => {
  it('every inner point is at the same canvas pixel before and after (2 000 random cases)', () => {
    const r = rng(5);
    for (let n = 0; n < 2000; n++) {
      const canvas = { w: 400 + r() * 1600, h: 300 + r() * 900 };
      const extent = { x: (r() - 0.5) * 40, y: (r() - 0.5) * 40, w: 5 + r() * 200, h: 5 + r() * 200 };
      // the fit on screen: the inside's own aspect at the view's scale
      const s = 0.5 + r() * 30;
      const fitPx = { x: (r() - 0.5) * 2000, y: (r() - 0.5) * 2000, w: extent.w * s, h: extent.h * s };
      const vb = handOffView(fitPx, extent, canvas);
      // the drilled level's camera keeps the canvas's aspect (one scale both ways)
      expect(canvas.w / vb.w).toBeCloseTo(canvas.h / vb.h, 9);
      for (const [u, v] of [[0, 0], [1, 1], [r(), r()]]) {
        const p = { x: extent.x + u * extent.w, y: extent.y + v * extent.h };
        const before = { x: fitPx.x + (p.x - extent.x) * s, y: fitPx.y + (p.y - extent.y) * s };
        const after = { x: (p.x - vb.x) * canvas.w / vb.w, y: (p.y - vb.y) * canvas.h / vb.h };
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      }
    }
  });

  it('hands off exactly when the drawn inside reaches the canvas in width or in height, along a zoom', () => {
    const canvas = { w: 1200, h: 700 };
    const { box, def } = boxOf(SC(), 'alu');
    const extent = hullOf(def), f = fitInside(box, extent);
    let handed = -1;
    for (let i = 0; i < 80 && handed < 0; i++) {
      const px = 4 * 1.1 ** i;
      // the box centred on the canvas at this zoom
      const fitPx = { x: canvas.w / 2 + (f.x - box.x - box.w / 2) * px, y: canvas.h / 2 + (f.y - box.y - box.h / 2) * px, w: f.w * px, h: f.h * px };
      if (handsOff(fitPx, canvas)) {
        handed = i;
        expect(fitPx.w >= canvas.w || fitPx.h >= canvas.h).toBe(true);
        // and it had opened earlier along the same trace
        expect(px).toBeGreaterThan(openAtFor(box, def));
      } else expect(fitPx.w < canvas.w && fitPx.h < canvas.h).toBe(true);
    }
    expect(handed).toBeGreaterThan(0);
  });
});

describe('zooming out gives the symbol back', () => {
  it('from any history, every zoom below ¾ of the opening closes it', () => {
    const r = rng(9);
    const at = 21.3;
    for (let run = 0; run < 300; run++) {
      const trace = Array.from({ length: 30 }, () => at * (0.2 + r() * 3));
      const open = play(trace, at, r() < 0.5).at(-1)!;
      expect(decide(open, at * CLOSE_SHARE * 0.999, at)).toBe(false);
    }
  });

  it('a zoom in then all the way out ends closed, for every box on both CPUs', () => {
    for (const top of [SC(), PIPE()]) {
      for (const i of netlistOf(top)!.instances) {
        if (i.def.prim || !netlistOf(i.def)) continue;
        const { box, def } = boxOf(top, i.name);
        const at = openAtFor(box, def);
        if (!Number.isFinite(at)) continue;
        const zin = Array.from({ length: 50 }, (_, k) => 2 * 1.12 ** k);
        const states = play([...zin, ...[...zin].reverse()], at);
        expect(states.some(Boolean)).toBe(true);
        expect(states.at(-1)).toBe(false);
        expect(flips(states)).toBe(2);
      }
    }
  });
});

