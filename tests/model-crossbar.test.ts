import { describe, expect, it } from 'vitest';
import { CROSSBAR_EXCHANGE } from '../src/lib/telegraph';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B1 } from '../src/sim/types';
import {
  BARS, CROSSPOINTS, HOLD_MAGNETS, LEVELS, PAIRS, SELECT_MAGNETS, VERTICALS, apply, barOf, closed, closedList, dirOf, fresh, framesOf, levelBusy, markerCall, markerHang, motionAt, run, stateAt,
} from '../src/phys/crossbar';

describe('the crossbar switch (phys/crossbar.ts): the sources\' counts and rules', () => {
  it('a Type B 200-point switch: ten levels, twenty verticals, five bars of two select magnets, a hold magnet per vertical, three pairs a crosspoint', () => {
    expect([LEVELS, VERTICALS, BARS, PAIRS]).toEqual([10, 20, 5, 3]);
    expect(CROSSPOINTS).toBe(200);
    expect(SELECT_MAGNETS + HOLD_MAGNETS).toBe(30);
    // every level is one bar and one direction, and every bar and direction one level
    const seen = new Set<string>();
    for (let l = 0; l < LEVELS; l++) seen.add(`${barOf(l)}${dirOf(l)}`);
    expect(seen.size).toBe(LEVELS);
  });
  it('select, then hold: the crosspoint closes and stays when the select lets go; the other order closes nothing', () => {
    let x = run(fresh(), [{ kind: 'select', l: 4 }, { kind: 'hold', v: 7 }]);
    expect(closed(x, 4, 7)).toBe(true);
    x = run(x, [{ kind: 'unselect' }]);
    expect(closed(x, 4, 7)).toBe(true);
    expect(closedList(x)).toEqual([[4, 7]]);
    const y = run(fresh(), [{ kind: 'hold', v: 7 }, { kind: 'select', l: 4 }, { kind: 'unselect' }]);
    expect(closedList(y)).toEqual([]);
  });
  it('only one select magnet at a time', () => {
    const x = run(fresh(), [{ kind: 'select', l: 2 }]);
    const s = apply(x, { kind: 'select', l: 5 });
    expect(s.refused).toMatch(/one select magnet/);
    expect(s.x.select).toBe(2);
  });
  it('a hang-up drops that vertical\'s crosspoint alone', () => {
    let x = fresh();
    x = run(x, markerCall(x, 1, 3).ops);
    x = run(x, markerCall(x, 9, 0).ops);
    expect(levelBusy(x, 3)).toBe(true);
    x = run(x, markerHang(1));
    expect(closedList(x)).toEqual([[0, 9]]);
    expect(levelBusy(x, 3)).toBe(false);
  });
  it('the motion: the bar tilts, then the holding bar comes in, then the bar returns while the finger stays trapped', () => {
    const fr = framesOf(fresh(), markerCall(fresh(), 6, 7).ops), end = fr[fr.length - 1].t;
    expect(fr.length).toBe(4);
    const mid1 = motionAt(fr, fr[1].t / 2);
    expect(mid1.tilt[barOf(7)]).toBeGreaterThan(0);
    expect(mid1.hold[6]).toBe(0);
    const fin = motionAt(fr, end);
    expect(fin.tilt.every((t) => t === 0)).toBe(true);
    expect(fin.hold[6]).toBe(1);
    expect(fin.trapped[6]).toBe(7);
    expect(closed(stateAt(fr, end), 7, 6)).toBe(true);
  });
});

/** The chapter's 3 × 3 relay crossbar on the switch-level solver: callers on rows, called lines on columns. */
function chapter() {
  const sim = new SwitchSim(flatten(CROSSBAR_EXCHANGE, { mode: 'switch' }));
  const leaf = new Map(sim.design.leaves.map((l, i) => [l.node.path.join('.'), i] as const));
  const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) sim.setInput(k, v); sim.settle(); };
  return {
    call: (r: number, c: number) => { set({ rs: 1 << r, cs: 1 << c }); set({ rs: 0, cs: 0 }); },
    hang: (r: number) => { set({ hang: 1 << r }); set({ hang: 0 }); },
    closed: (): [number, number][] => {
      const out: [number, number][] = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (sim.relayState(leaf.get(`xb.x${r}${c}.x`)!) === B1) out.push([c, r]);
      return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    },
  };
}

describe('the switch is the chapter\'s crossbar: callers on verticals, called lines on levels', () => {
  const sort = (l: [number, number][]) => l.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  it('the tour\'s calls: two calls up, a third into a busy column refused, a hang-up frees it', () => {
    const ch = chapter();
    let x = fresh(3);
    const step = (f: () => void, ops: () => void) => { f(); ops(); expect(sort(closedList(x))).toEqual(ch.closed()); };
    step(() => ch.call(0, 1), () => { x = run(x, markerCall(x, 0, 1).ops); });
    step(() => ch.call(2, 0), () => { x = run(x, markerCall(x, 2, 0).ops); });
    step(() => ch.call(1, 1), () => { const m = markerCall(x, 1, 1); expect(m.refused).toMatch(/busy/); });
    step(() => ch.hang(0), () => { x = run(x, markerHang(0)); });
    step(() => ch.call(1, 1), () => { x = run(x, markerCall(x, 1, 1).ops); });
  });
  it('random sequences of calls (from idle callers) and hang-ups end in the same held crosspoints', () => {
    let seed = 11;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * n); };
    for (let run_ = 0; run_ < 12; run_++) {
      const ch = chapter();
      let x = fresh(3);
      for (let k = 0; k < 10; k++) {
        const r = rnd(3);
        if (rnd(3) === 0) { ch.hang(r); x = run(x, markerHang(r)); }
        else if (!x.hold[r]) { const c = rnd(3); ch.call(r, c); const m = markerCall(x, r, c); x = run(x, m.ops); }
        expect(sort(closedList(x)), `run ${run_}, op ${k}`).toEqual(ch.closed());
      }
    }
  });
});

describe('the crossbar model (widgets/crossbar3dkit.ts)', () => {
  it('inside the typical outline, the size labelled typical, a spring per pole of every crosspoint, seven beats', async () => {
    const { OUTLINE, springInstances, xbModel, tipOf, levelY, barY } = await import('../src/widgets/crossbar3dkit');
    const { boundsOf } = await import('../src/gl/kit/scene');
    const fr = framesOf(fresh(), markerCall(fresh(), 6, 5).ops), m = motionAt(fr, fr[fr.length - 1].t), mod = xbModel(m);
    const { min, max } = boundsOf(mod);
    expect(max[0] - min[0]).toBeLessThanOrEqual(OUTLINE.l + 1e-6);
    expect(max[1] - min[1]).toBeLessThanOrEqual(OUTLINE.h + 1e-6);
    expect(mod.items.find((i) => i.name === 'frame')!.info!.dim).toMatch(/typical/);
    for (const it of mod.items) expect(it.geo.positions.every(Number.isFinite), it.name).toBe(true);
    expect(springInstances(m).length).toBe(CROSSPOINTS * 2 * PAIRS);
    expect(springInstances(m).filter((s) => s.emissive).length).toBe(2 * PAIRS);
    // the trapped finger sits at its level; the others are back level with their bar
    expect(tipOf(m, barOf(5), 6)[1]).toBeCloseTo(levelY(5), 9);
    expect(tipOf(m, barOf(5), 7)[1]).toBeCloseTo(barY(barOf(5)), 9);
    expect(mod.beats!.length).toBe(7);
    expect(new Set(mod.anchors!.map((a) => a.text)).size).toBe(mod.anchors!.length);
  });
});
