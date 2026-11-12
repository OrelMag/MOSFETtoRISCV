// Open blocks as you zoom: the author's target (DESIGN.md Revision 3, R3.2's cap). On the single-cycle, pipelined and
// out-of-order CPUs' top levels, every box that can open does so by the time its shorter side is CAP_SHARE (40 %) of the
// canvas's shorter side, and never past the view's deepest zoom (no dead end: the hint never asks for a zoom the view cannot
// reach); a 32-bit register opens on its own rule (the run of flip-flops) at about 200 px.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { oooCpu } from '../src/lib/ooocore';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { orientGeom } from '../src/sim/geometry';
import { isConstantDef } from '../src/sim/constant';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { MIN_VIEW_UNITS } from '../src/view/camera';
import { CAP_SHARE, capOpenAt, decide, fitInside, handsOff, insideExtent, openAtPx, smallestNamed } from '../src/view/lensplan';

const FIB = assemble(PROGRAMS.find((p) => p.name === 'Fibonacci')!.source).words;
const TOPS: [string, () => ComponentDef][] = [['single-cycle', () => singleCycleCpu(FIB)], ['pipeline', () => pipelinedCpu(FIB)], ['out of order', () => oooCpu(FIB)]];
// the stage's canvas at 1280 × 800 with the panels docked, and a narrower one (look inside beside the circuit)
const CANVASES = [{ w: 888, h: 606 }, { w: 620, h: 520 }];

/** Every box of a top that can open: its size and its own opening zoom. */
function boxes(top: ComponentDef) {
  return netlistOf(top)!.instances.flatMap((i) => {
    const e = netlistOf(i.def) && !isConstantDef(i.def) ? insideExtent(i.def) : null;
    if (!e) return [];
    const g = orientGeom(i.def, i.flip, i.rot), box = { x: 0, y: 0, w: g.w, h: g.h };
    const base = openAtPx(box, fitInside(box, e).k, smallestNamed(i.def));
    return Number.isFinite(base) ? [{ name: i.name, size: { w: g.w, h: g.h }, base }] : [];
  });
}

describe('every box opens by 40 % of the canvas, and within the view\'s zoom', () => {
  for (const [label, make] of TOPS) {
    it(label, () => {
      const all = boxes(make());
      expect(all.length).toBeGreaterThan(10);
      for (const c of CANVASES) {
        const maxPx = c.w / MIN_VIEW_UNITS, cs = Math.min(c.w, c.h);
        for (const b of all) {
          const at = capOpenAt(b.base, b.size, c);
          const why = `${label} ${b.name} on ${c.w} x ${c.h}: opens at ${at.toFixed(1)} px a unit`;
          expect(at, why).toBeLessThan(maxPx);
          expect(Math.min(b.size.w, b.size.h) * at, why).toBeLessThanOrEqual(CAP_SHARE * cs + 1e-6);
          // the cap only ever brings an opening nearer
          expect(at).toBeLessThanOrEqual(b.base);
        }
      }
    });
  }
});

describe('a register opens on its own rule', () => {
  it('the single-cycle CPU\'s pc (32 flip-flops in a column) at about 200 px on its shorter side, before any cap', () => {
    const pc = boxes(singleCycleCpu(FIB)).find((b) => b.name === 'pc')!;
    const short = Math.min(pc.size.w, pc.size.h) * pc.base;
    expect(short).toBeGreaterThan(150);
    expect(short).toBeLessThan(250);
  });
  it('the register file reads its 31 registers as one run (no longer its smallest part\'s floor alone)', () => {
    const def = netlistOf(singleCycleCpu(FIB))!.instances.find((i) => i.name === 'rf')!.def;
    // the read ports (10 units, two of them) are the smallest named blocks now: the 31 REG32s count as one run
    expect(smallestNamed(def)).toBe(10);
  });
});

// Ross's review cases: the cap made the opening zoom depend on the canvas, so the canvas's changes and extremes are tested here.
describe('the cap and the canvas', () => {
  // docked / folded pairs (a panel folding widens the canvas), and the phone canvases touch now opens on
  const PAIRS: [{ w: number; h: number }, { w: number; h: number }][] = [
    [{ w: 888, h: 606 }, { w: 1248, h: 606 }], [{ w: 620, h: 520 }, { w: 888, h: 606 }],
    // not a window resize (1248 x 606 to 1880 x 900): its short side grows 1.49 times, more than the band's 1 / CLOSE_SHARE
  ];
  const PHONES = [{ w: 390, h: 560 }, { w: 360, h: 480 }, { w: 844, h: 300 }];

  for (const [label, make] of TOPS) {
    const all = boxes(make());

    it(`${label}: no box hands off on the step it opens (its inside on screen is smaller than the canvas there)`, () => {
      for (const c of [...CANVASES, ...PHONES]) {
        for (const b of all) {
          const def = netlistOf(make())!.instances.find((i) => i.name === b.name)!.def;
          const box = { x: 0, y: 0, ...b.size }, f = fitInside(box, insideExtent(def)!);
          const at = capOpenAt(b.base, b.size, c);
          const fitPx = { x: 0, y: 0, w: f.w * at, h: f.h * at };
          expect(handsOff(fitPx, c), `${label} ${b.name} on ${c.w} x ${c.h}: inside ${fitPx.w.toFixed(0)} x ${fitPx.h.toFixed(0)} px at ${at.toFixed(1)}`).toBe(false);
        }
      }
    });

    it(`${label}: a panel docking or folding never closes an open box (the cap moves less than the band)`, () => {
      for (const [a, b2] of PAIRS) for (const [from, to] of [[a, b2], [b2, a]]) {
        for (const b of all) {
          const px = capOpenAt(b.base, b.size, from);
          expect(decide(true, px, capOpenAt(b.base, b.size, to)), `${label} ${b.name}: open at ${px.toFixed(1)} on ${from.w} x ${from.h}, then ${to.w} x ${to.h}`).toBe(true);
        }
      }
    });

    it(`${label}: on a phone every box still opens within the view's zoom and by 40 % of the short side`, () => {
      for (const c of PHONES) {
        const cs = Math.min(c.w, c.h);
        for (const b of all) {
          const at = capOpenAt(b.base, b.size, c);
          expect(at, `${label} ${b.name} on ${c.w} x ${c.h}`).toBeLessThan(c.w / MIN_VIEW_UNITS);
          expect(Math.min(b.size.w, b.size.h) * at).toBeLessThanOrEqual(CAP_SHARE * cs + 1e-6);
        }
      }
    });
  }

  it('the cap is a function of the box and the canvas alone: any order, any number of times', () => {
    const all = boxes(singleCycleCpu(FIB));
    const first = all.map((b) => CANVASES.map((c) => capOpenAt(b.base, b.size, c)));
    for (let run = 0; run < 3; run++) [...all].reverse().forEach((b) => {
      const i = all.indexOf(b);
      CANVASES.forEach((c, j) => expect(capOpenAt(b.base, b.size, c)).toBe(first[i][j]));
    });
  });
});
