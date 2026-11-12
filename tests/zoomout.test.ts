// Zoom out to go up (DESIGN.md item 9, phase 2e): view/zoomout.ts on wheel and pinch traces. The repo holds no
// recordings of real devices, so the traces are made to their measured shapes: a trackpad scrolls and coasts at the
// display's frame rate (8–17 ms apart) with an exponentially decaying delta for one to two seconds after the fingers
// leave; a mouse wheel sends one event per notch (±100 or ±120), 50–300 ms apart while turned briskly.
import { describe, expect, it } from 'vitest';
import { cueWords, FRESH_MS, PINCH_OUT, progress, ZoomOutGate } from '../src/view/zoomout';

type Ev = [t: number, dy: number];

/** A trackpad fling from t0: fingers for `drag` ms, then momentum decaying by `decay` per frame of `frame` ms. */
function fling(t0: number, { drag = 250, frame = 16.7, peak = 40, decay = 0.955, minDelta = 0.4 } = {}): Ev[] {
  const out: Ev[] = [];
  let t = t0;
  for (; t < t0 + drag; t += frame) out.push([t, peak * (0.6 + 0.4 * Math.sin(((t - t0) / drag) * Math.PI))]);
  for (let d = peak; d >= minDelta; d *= decay, t += frame) out.push([t, d]);
  return out;
}

/** Mouse notches of ±`delta`, `every` ms apart. */
const notches = (t0: number, n: number, every: number, delta = 120): Ev[] => Array.from({ length: n }, (_, i) => [t0 + i * every, delta]);

/** Feed a trace; the cue comes up at `cueAt`. Returns the times of the events that popped. */
function run(trace: Ev[], cueAt: number | null, g = new ZoomOutGate()): number[] {
  const pops: number[] = [];
  let cued = false;
  for (const [t, dy] of [...trace].sort((a, b) => a[0] - b[0])) {
    if (cueAt !== null && !cued && t >= cueAt) { g.cue(cueAt); cued = true; }
    if (g.wheel(t, dy) === 'up') pops.push(t);
  }
  return pops;
}

describe('the wheel', () => {
  it('a trackpad fling never pops, wherever in it the cue comes up', () => {
    for (const frame of [8.3, 16.7]) for (const decay of [0.93, 0.955, 0.97]) {
      const f = fling(1000, { frame, decay });
      const end = f[f.length - 1][0];
      expect(end - 1000).toBeGreaterThan(FRESH_MS + 200); // coasting well past the pause that would pop
      for (const cueAt of [1100, 1300, (1000 + end) / 2, end - 30]) expect(run(f, cueAt)).toEqual([]);
    }
  });

  it('a second, deliberate gesture after the fling has stopped pops once, on its first event', () => {
    const a = fling(1000), end = a[a.length - 1][0];
    const b = fling(end + FRESH_MS + 50);
    expect(run([...a, ...b], 1400)).toEqual([b[0][0]]);
  });

  it('a pause shorter than FRESH_MS is the same gesture: no pop', () => {
    const a = fling(1000), end = a[a.length - 1][0];
    expect(run([...a, ...fling(end + FRESH_MS - 60)], 1400)).toEqual([]);
  });

  it('a mouse turned briskly does not pop until it stops and turns again', () => {
    const a = notches(1000, 12, 120);
    const b = notches(1000 + 11 * 120 + 600, 4, 120);
    expect(run([...a, ...b], 1500)).toEqual([b[0][0]]);
  });

  it('a slow notcher (500 ms a notch) pops on the first notch after the cue: each notch is its own gesture', () => {
    expect(run(notches(1000, 8, 500), 2200)).toEqual([2500]);
  });

  it('only one pop per cue, and none before it or without it', () => {
    const t = notches(1000, 6, 600);
    expect(run(t, null)).toEqual([]);
    expect(run(t, 2300)).toEqual([2800]);
  });

  it('zooming in after the pause does not go up', () => {
    const a = fling(1000), end = a[a.length - 1][0];
    const inward = fling(end + 800).map(([t, d]): Ev => [t, -d]);
    expect(run([...a, ...inward], 1400)).toEqual([]);
  });

  it('the event that raises the cue is not fresh, even after a pause (the cue comes up while it is handled)', () => {
    const g = new ZoomOutGate();
    expect(g.wheel(1000, 120)).toBe(null);
    g.cue(1600.4); // the stage zoomed out to fit on the event of t = 1600 and showed the cue
    expect(g.wheel(1600, 120)).toBe(null);
    expect(g.wheel(1630, 120)).toBe(null);
    expect(g.wheel(2100, 120)).toBe('up');
  });

  it('a cue cleared (another level, the setting off) ends it', () => {
    const g = new ZoomOutGate();
    g.cue(1000);
    g.clear();
    expect(g.cued).toBe(false);
    expect(g.wheel(3000, 120)).toBe(null);
  });
});

describe('the pinch', () => {
  /** Steps of a pinch from t0 closing to `total` over n steps 16 ms apart; returns the times that popped. */
  const pinch = (g: ZoomOutGate, t0: number, total: number, n = 12): number[] => {
    const k = Math.pow(total, 1 / n), pops: number[] = [];
    for (let i = 0; i < n; i++) if (g.pinch(t0 + i * 16, k, i === 0) === 'up') pops.push(t0 + i * 16);
    g.pinchEnd();
    return pops;
  };

  it('the pinch that brought the cue up does not pop, however far it closes', () => {
    const g = new ZoomOutGate();
    const k = Math.pow(0.3, 1 / 30);
    for (let i = 0; i < 30; i++) {
      if (i === 10) g.cue(1000 + i * 16);
      expect(g.pinch(1000 + i * 16, k, i === 0)).toBe(null);
    }
    g.pinchEnd();
  });

  it('a new pinch after the cue pops once it has closed by PINCH_OUT', () => {
    const g = new ZoomOutGate();
    g.cue(1000);
    const pops = pinch(g, 2000, 0.5);
    expect(pops.length).toBe(1);
    // the step it popped on is the first where the fingers had closed past PINCH_OUT
    const k = Math.pow(0.5, 1 / 12), i = (pops[0] - 2000) / 16;
    expect(Math.pow(k, i + 1)).toBeLessThanOrEqual(PINCH_OUT);
    expect(Math.pow(k, i)).toBeGreaterThan(PINCH_OUT);
  });

  it('a new pinch that spreads, or barely closes, does not pop', () => {
    const g = new ZoomOutGate();
    g.cue(1000);
    expect(pinch(g, 2000, 1.6)).toEqual([]);
    expect(pinch(g, 3000, 0.95)).toEqual([]);
    expect(g.cued).toBe(true);
  });
});

describe('the − key and the zoom-out button', () => {
  it('a press after the cue goes up once; before the cue, or the press that raised it, does not', () => {
    const g = new ZoomOutGate();
    expect(g.key(500)).toBe(null);
    g.cue(1000);
    expect(g.key(1000)).toBe(null);
    expect(g.key(1200)).toBe('up');
    expect(g.key(1300)).toBe(null);
  });
});

describe('state 1: how much more to zoom out', () => {
  it('the bar runs from the scale the level was entered at to the fit, on a log scale', () => {
    expect(progress(8, 2, 8)).toBe(0);
    expect(progress(4, 2, 8)).toBeCloseTo(0.5);
    expect(progress(2, 2, 8)).toBe(1);
    expect(progress(1, 2, 8)).toBe(1);
    // zoomed in past where it was entered: empty, never negative
    expect(progress(16, 2, 8)).toBe(0);
    // entered at fit or below: nothing to show
    expect(progress(3, 2, 2)).toBe(0);
  });
  it('the line says what happens next', () => {
    expect(cueWords('alu', 'cpu', false)).toBe('Zoom out to see all of alu, then once more to go up to cpu');
    expect(cueWords('alu', 'cpu', true)).toBe('Zoom out once more to go up to cpu');
  });
});
