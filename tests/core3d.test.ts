// The core memory plane: the coincident-current rule, and the drawing held to it.
import { describe, expect, it } from 'vitest';
import {
  FULL, HALF, IC, N, applyDrive, colOf, halfSelected, idle, planOp, rowOf, cycleFault, marginOf, marginWindow, icOf, HALF_MIN, HALF_MAX, type Op,
} from '../src/widgets/core3dparts';
import { AWG, AX, CORE_HOME_FRAME, PLANE, HEIGHT, ID, OD, PITCH, RI, RO, SAG, STACK_N, WIRE_R, awgMil, centreOf, coreModel, stackCoreSites, stackSites, wires, type CoreState, type Wire } from '../src/widgets/core3dkit';
import { filletPath } from '../src/gl/kit/geo';
import type { Vec3 } from '../src/gl/math';

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pattern = () => Array.from({ length: N * N }, () => (rnd() < 0.5 ? 0 : 1));

describe('coincident current', () => {
  it('half a select is below the switching current and a full select above it, by a margin on both sides', () => {
    expect(HALF).toBeLessThan(IC);
    expect(FULL).toBeGreaterThan(IC);
    expect(FULL - HALF).toBeGreaterThan(0); // inhibit leaves HALF, which holds
  });

  it('only the addressed core flips; the half-selected never do, in either phase of any operation', () => {
    for (let t = 0; t < 300; t++) {
      const bits = pattern(), addr = Math.floor(rnd() * 16), op = (['read', 'write0', 'write1'] as Op[])[t % 3];
      for (const ph of planOp(bits, addr, op)) {
        expect(ph.flipped.every((k) => k === addr)).toBe(true);
        for (const k of halfSelected(addr)) {
          expect(Math.abs(ph.net[k])).toBeCloseTo(ph.drive.inh ? 0 : HALF, 9); // the inhibit wire cancels their half too
          expect(ph.after[k]).toBe(ph.before[k]);
        }
        for (let k = 0; k < 16; k++) if (k !== addr && rowOf(k) !== rowOf(addr) && colOf(k) !== colOf(addr)) expect(ph.net[k]).toBeCloseTo(HALF * ph.drive.inh, 9);
        expect(Math.abs(ph.net[addr])).toBeCloseTo(ph.drive.inh ? HALF : FULL, 9);
      }
    }
  });

  it('a row of half-selected cores still never flips with any contents', () => {
    for (let t = 0; t < 200; t++) {
      const bits = pattern(), d = idle(); d.x[1] = -1; d.y[2] = -1;
      const r = applyDrive(bits, d);
      expect(r.flipped).toEqual(bits[1 * N + 2] === 1 ? [1 * N + 2] : []);
    }
  });
});

describe('read and write cycles', () => {
  it('a sense pulse in the read phase if and only if a 1 was read, and the value is reported', () => {
    for (let t = 0; t < 200; t++) {
      const bits = pattern(), addr = Math.floor(rnd() * 16), [rd] = planOp(bits, addr, 'read');
      expect(rd.strobed).toBe(true);
      expect(rd.pulse).toBe(bits[addr] === 1);
      expect(rd.senseBit).toBe(bits[addr]);
      expect(rd.after[addr]).toBe(0);
    }
  });

  it('the inhibit wire is driven only when a 0 is written or restored', () => {
    for (let t = 0; t < 200; t++) {
      const bits = pattern(), addr = Math.floor(rnd() * 16);
      for (const op of ['read', 'write0', 'write1'] as Op[]) {
        const [a, b] = planOp(bits, addr, op), v = op === 'read' ? bits[addr] : op === 'write1' ? 1 : 0;
        expect(a.drive.inh).toBe(0);
        expect(b.drive.inh !== 0).toBe(v === 0);
        expect(b.after[addr]).toBe(v);
      }
    }
  });

  it('a read restores every core, all contents survive, and a write changes only its core', () => {
    for (let t = 0; t < 300; t++) {
      const bits = pattern(), addr = Math.floor(rnd() * 16);
      expect(planOp(bits, addr, 'read')[1].after).toEqual(bits);
      for (const v of [0, 1]) {
        const out = planOp(bits, addr, v ? 'write1' : 'write0')[1].after;
        expect(out[addr]).toBe(v);
        expect(out.filter((_, k) => k !== addr)).toEqual(bits.filter((_, k) => k !== addr));
      }
    }
  });

  it('phases chain: the second starts from where the first left the plane', () => {
    const bits = pattern(), [a, b] = planOp(bits, 6, 'read');
    expect(b.before).toEqual(a.after);
  });
});

describe('the half-select current window', () => {
  it('works from Ic/2 up to just under Ic, and the slider range brackets it', () => {
    expect(HALF_MIN).toBeLessThan(IC / 2);
    expect(HALF_MAX).toBeGreaterThan(IC);
    expect(marginWindow()).toEqual({ lo: IC / 2, hi: IC });
    expect(marginOf(HALF)).toBe('ok');
    expect(marginOf(IC * 0.44)).toBe('low');
    expect(marginOf(IC / 2)).toBe('ok');
    expect(marginOf(IC)).toBe('high');
    expect(marginOf(IC * 1.1)).toBe('high');
    // the half select is Whirlwind's (R-221): 0.45 A, a full select 0.90 A, the model's Ic between them
    expect([HALF, FULL]).toEqual([0.45, 0.9]);
  });

  const stray = (half: number, spread = false) => planOp(START, 5, 'read', { half, spread });
  const START = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0];

  it('inside the window every phase is clean, at any drive', () => {
    for (let h = IC / 2 + 0.005; h < IC - 0.001; h += IC / 45) for (const op of ['read', 'write0', 'write1'] as Op[]) {
      for (const ph of planOp(START, 5, op, { half: h })) { expect(ph.missed).toBe(false); expect(ph.stray).toEqual([]); expect(ph.half).toBe(h); }
    }
  });

  it('below Ic/2 the addressed core does not flip: a 1 reads as a 0 and the write fails', () => {
    const [rd, rs] = stray(IC * 0.49);
    expect(START[5]).toBe(1);
    expect(rd.flipped).toEqual([]);
    expect(rd.pulse).toBe(false);
    expect(rd.senseBit).toBe(0); // the sense wire saw nothing
    expect(rd.missed).toBe(true);
    expect(rs.after[5]).toBe(1); // it still holds the 1; the read-back wrote a "0" that could not take
    const w = planOp(START, 5, 'write1', { half: IC * 0.44 });
    expect(w[0].missed).toBe(true);
    expect(w[1].after[5]).toBe(START[5]); // nothing changed: the write did not happen
    expect(planOp([...START].fill(0), 5, 'write1', { half: IC * 0.44 })[1].after[5]).toBe(0);
    expect(planOp([...START].fill(0), 5, 'write1', { half: IC * 0.44 })[1].missed).toBe(true);
  });

  it('at Ic or more a half select flips the whole row and column of the address', () => {
    const [rd] = stray(IC * 1.1);
    expect(new Set(rd.flipped)).toEqual(new Set(halfSelected(5).filter((k) => START[k] === 1).concat([5])));
    expect(rd.stray.every((k) => halfSelected(5).includes(k))).toBe(true);
    expect(rd.stray.length).toBeGreaterThan(0);
    // every row/column core now reads 0: their data is gone
    for (const k of halfSelected(5)) expect(rd.after[k]).toBe(0);
    // just at Ic is already too much
    const exact = planOp(START, 5, 'read', { half: IC })[0];
    expect(exact.stray.length).toBeGreaterThan(0);
  });

  it('write 0 above Ic: the inhibit cannot hold the crossing core, and the plane is wiped', () => {
    const [, w] = planOp(START, 5, 'write0', { half: IC * 1.1 });
    expect(w.missed).toBe(true); // the crossing sees 1.1 Ic and takes a 1
    expect(w.stray.length).toBeGreaterThan(0);
  });

  it('a drive spread of +-20 % narrows the window: the default stays inside it, the edges of the plain window do not', () => {
    const w = marginWindow(true);
    expect(w.lo).toBeCloseTo((IC * 1.2) / 2, 9);
    expect(w.hi).toBeCloseTo(IC * 0.8, 9);
    expect(w.lo).toBeGreaterThan(IC / 2);
    expect(w.hi).toBeLessThan(IC);
    expect(marginOf(HALF, true)).toBe('ok');
    expect(marginOf(IC * 0.53, true)).toBe('low');
    expect(marginOf(IC * 0.89, true)).toBe('high');
    expect(Math.max(...Array.from({ length: 16 }, (_, k) => icOf(k, true)))).toBeCloseTo(IC * 1.2, 9);
    expect(icOf(3)).toBe(IC);
    // behaviour agrees with the analytic window over a sweep, for every address
    for (let h = HALF_MIN; h <= HALF_MAX + 1e-9; h += 0.01) for (let a = 0; a < 16; a++) {
      const bad = planOp(START, a, 'read', { half: h, spread: true }).some((p) => p.missed || p.stray.length);
      if (marginOf(h, true) === 'ok') expect(bad).toBe(false);
    }
    // at 0.85 Ic (inside the plain window) core 3, 20% weak and holding a 1, flips when the column is driven (address 7)
    expect(marginOf(IC * 0.85)).toBe('ok');
    expect(planOp(START, 7, 'read', { half: IC * 0.85, spread: true })[0].stray).toContain(3);
  });

  it('the default is unchanged: planOp without options is the 0.45 A plane', () => {
    expect(planOp(START, 5, 'read')[0].half).toBe(HALF);
  });
});
describe('the cycle summary', () => {
  const B = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0];
  it('a clean cycle has none', () => expect(cycleFault(planOp(B, 5, 'read'), 'read')).toBe(''));
  it('too low: one sentence, one current', () => {
    expect(cycleFault(planOp(B, 5, 'read', { half: 0.3 }), 'read')).toBe('Read failed: the addressed core never reached Ic (0.60 A against 0.65 A).');
    expect(cycleFault(planOp(B, 5, 'write1', { half: 0.3 }), 'write1')).toBe('Write failed: the addressed core never reached Ic (0.60 A against 0.65 A).');
  });
  it('too high: strays counted once across phases, plural right', () => {
    const plan = planOp(B, 5, 'read', { half: IC * 1.1 }), n = new Set(plan.flatMap((p) => p.stray)).size;
    expect(cycleFault(plan, 'read')).toBe(`${n} other cores flipped and lost their data.`);
    expect(n).toBeGreaterThan(1);
  });
});


// ---------------------------------------------------------------- the drawing (core3dkit.ts): true geometry held to its sources

const items = (s: Partial<CoreState> = {}) => coreModel({ bits: Array(16).fill(0), drive: idle(), flipping: [], addr: 5, sense: false, ...s }).items;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** The smallest distance between segments pq and rs. */
function segDist(p: Vec3, q: Vec3, r: Vec3, s: Vec3): number {
  const d1 = sub(q, p), d2 = sub(s, r), w = sub(p, r), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, w);
  let sc: number, tc: number;
  if (a < 1e-12 && e < 1e-12) return Math.hypot(...w);
  if (a < 1e-12) { sc = 0; tc = Math.min(1, Math.max(0, f / e)); } else {
    const c = dot(d1, w);
    if (e < 1e-12) { tc = 0; sc = Math.min(1, Math.max(0, -c / a)); } else {
      const b = dot(d1, d2), den = a * e - b * b;
      sc = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      tc = (b * sc + f) / e;
      if (tc < 0) { tc = 0; sc = Math.min(1, Math.max(0, -c / a)); } else if (tc > 1) { tc = 1; sc = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const pa: Vec3 = [p[0] + d1[0] * sc, p[1] + d1[1] * sc, p[2] + d1[2] * sc], pb: Vec3 = [r[0] + d2[0] * tc, r[1] + d2[1] * tc, r[2] + d2[2] * tc];
  return Math.hypot(...sub(pa, pb));
}
/** The centreline the tube is drawn on (wires() rounded at its corners as tube() does). */
const drawn = (w: Wire) => filletPath(w.path, 12);

describe('the drawing, in true geometry', () => {
  it('uses the sourced sizes: an 80 mil core (R-221 sec. 5.22), a 50 mil hole, 20 mil high; the pitch under R-221’s 9.5 in / 32', () => {
    expect([OD, ID, HEIGHT]).toEqual([80, 50, 20]);
    expect(PITCH).toBeLessThanOrEqual((9.5 * 1000) / 32);
    expect(PITCH).toBeGreaterThan(OD * 2); // a sparse plane, as Whirlwind’s was
    // the ring as drawn: its outside is OD across, along its axis it is HEIGHT thick
    const ring = items().find((i) => i.name === 'ferrite core')!.geo, c = centreOf(0), P = ring.positions;
    let rMax = 0, rMin = Infinity, aMax = 0;
    for (let k = 0; k < P.length; k += 3) {
      const v = sub([P[k], P[k + 1], P[k + 2]], c), a = dot(v, AX), r = Math.hypot(...sub(v, [AX[0] * a, AX[1] * a, AX[2] * a]));
      rMax = Math.max(rMax, r); rMin = Math.min(rMin, r); aMax = Math.max(aMax, Math.abs(a));
    }
    expect(rMax).toBeCloseTo(RO, 3);
    expect(rMin).toBeCloseTo(RI, 3);
    expect(2 * aMax).toBeCloseTo(HEIGHT, 3);
  });

  it('draws R-221’s 32-gauge magnet wire at its bare copper diameter, 7.95 mil', () => {
    expect(AWG).toBe(32);
    expect(awgMil(36)).toBeCloseTo(5, 6); // the AWG series’ anchor, 0.005 in
    expect(2 * WIRE_R).toBeCloseTo(7.95, 2);
  });

  it('every wire passes through the hole of every core it should, clear of the ferrite', () => {
    const W = wires(), byKind = (k: Wire['kind'], i = 0) => W.find((w) => w.kind === k && w.i === i)!;
    const diag = (k: number) => rowOf(k) - colOf(k) + N - 1;
    for (let k = 0; k < 16; k++) {
      const c = centreOf(k), lines = [byKind('x', rowOf(k)).runs[0], byKind('y', colOf(k)).runs[0], byKind('inh').runs[rowOf(k)], byKind('sense').runs[diag(k)]];
      for (const [a, b] of lines) {
        const d = sub(b, a), t = dot(sub(c, a), AX) / dot(d, AX), p: Vec3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
        const cos = Math.abs(dot(d, AX)) / Math.hypot(...d);
        expect(t).toBeGreaterThan(0); expect(t).toBeLessThan(1); // it does reach this core
        // where it crosses the ring's plane: its distance from the axis, plus its own width seen slantwise, inside the hole
        expect(Math.hypot(...sub(p, c)) + WIRE_R / cos).toBeLessThan(RI);
      }
    }
  });

  it('no wire, as drawn (sagging, bent at the frame), comes within its own radius of a core', () => {
    for (const w of wires()) {
      const pts = drawn(w);
      for (let i = 1; i < pts.length; i++) for (let s = 0; s <= 20; s++) {
        const q: Vec3 = [0, 1, 2].map((j) => pts[i - 1][j] + ((pts[i][j] - pts[i - 1][j]) * s) / 20) as Vec3;
        for (let k = 0; k < 16; k++) {
          const v = sub(q, centreOf(k)), a = dot(v, AX), r = Math.hypot(...sub(v, [AX[0] * a, AX[1] * a, AX[2] * a]));
          // the ring is a solid of revolution: its distance from a point is the distance, in (radius, along the axis), to its
          // rectangular section (drawn with rounded edges, so the true clearance is a little more)
          const dr = Math.max(RI - r, 0, r - RO), da = Math.max(Math.abs(a) - HEIGHT / 2, 0), inside = r > RI && r < RO && Math.abs(a) < HEIGHT / 2;
          const clear = inside ? 0 : da > 0 || r > RO ? Math.hypot(dr, da) : Math.min(RI - r, Math.hypot(dr, da));
          expect(clear, `${w.kind}${w.i} near core ${k}`).toBeGreaterThanOrEqual(WIRE_R);
        }
      }
    }
  });

  it('no two wires come closer than a wire’s width anywhere (they cross inside the holes, one above the other)', () => {
    const W = wires().map(drawn);
    let min = Infinity;
    for (let i = 0; i < W.length; i++) for (let j = i + 1; j < W.length; j++)
      for (let a = 1; a < W[i].length; a++) for (let b = 1; b < W[j].length; b++) min = Math.min(min, segDist(W[i][a - 1], W[i][a], W[j][b - 1], W[j][b]));
    expect(min).toBeGreaterThanOrEqual(2 * WIRE_R);
  });

  it('X, Y and the inhibit thread every core the same way, so the inhibit opposes the selects in all sixteen; the sense alternates', () => {
    const W = wires(), way = ([a, b]: [Vec3, Vec3]) => Math.sign(dot(sub(b, a), AX));
    for (const w of W.filter((x) => x.kind !== 'sense')) for (const r of w.runs) expect(way(r)).toBe(1);
    expect(W.find((w) => w.kind === 'sense')!.runs.map(way)).toEqual([1, -1, 1, -1, 1, -1, 1]);
    expect(SAG).toBeLessThan(WIRE_R);
  });

  it('a wire lights only while it carries current; the switching core glows; the lamp only on a strobed pulse', () => {
    const lit = (it: ReturnType<typeof items>) => it.filter((i) => /wire/.test(i.name ?? '') && (i.mat.glow ?? 0) > 0).map((i) => i.name);
    expect(lit(items())).toEqual([]);
    const d = idle(); d.x[1] = -1; d.y[1] = -1;
    expect(lit(items({ drive: d })).sort()).toEqual(['X select wire', 'Y select wire']);
    const cores = items({ flipping: [5] }).filter((i) => i.name === 'ferrite core');
    expect(cores.filter((i) => (i.mat.glow ?? 0) > 0)).toHaveLength(1);
    const lamp = (sense: boolean) => items({ sense }).find((i) => i.name === 'sense lamp')!.mat.glow ?? 0;
    expect(lamp(false)).toBe(0);
    expect(lamp(true)).toBeGreaterThan(0);
  });

  it('shows each stored bit as its arrow’s way round the ring, without any animation (the flat view has it too)', () => {
    const turn = (bit: number) => {
      const arrow = items({ bits: Array(16).fill(bit) }).filter((i) => i.name === 'stored bit')[0], P = arrow.geo.positions, c = centreOf(0);
      // the arc's first and a later point: the turn between them, about the axis
      const p0 = sub([P[0], P[1], P[2]], c), p1 = sub([P[60], P[61], P[62]], c);
      return Math.sign(dot([p0[1] * p1[2] - p0[2] * p1[1], p0[2] * p1[0] - p0[0] * p1[2], p0[0] * p1[1] - p0[1] * p1[0]], AX));
    };
    expect(turn(1)).toBe(-turn(0));
    expect(items({ bits: Array(16).fill(1) }).filter((i) => i.name === 'stored bit')).toHaveLength(16);
  });

  it('a three-wire plane draws no inhibit wire and lights the shared wire for an inhibit', () => {
    const d = idle(); d.inh = -1;
    expect(items({ drive: d, threeWire: true }).some((i) => i.name === 'inhibit wire')).toBe(false);
    expect(items({ drive: d, threeWire: true }).find((i) => i.name === 'sense + inhibit wire')!.mat.glow).toBeGreaterThan(0);
    expect(items({ drive: d }).find((i) => i.name === 'inhibit wire')!.mat.glow).toBeGreaterThan(0);
  });

  it('the tour ends on the stack: 17 planes of 32 × 32 (R-221), the crop the middle of the top one', () => {
    expect(STACK_N).toBe(17);
    expect(stackSites()).toHaveLength(17);
    expect(stackCoreSites()).toHaveLength(17 * 1024 - 16);
    // the crop's cores sit exactly where the top plane's middle cores would
    const top = new Set(stackCoreSites().filter((p) => p[1] === 0).map((p) => p.join()));
    for (let k = 0; k < 16; k++) expect(top.has(centreOf(k).join())).toBe(false);
    expect(top.has([centreOf(0)[0] - PITCH, 0, centreOf(0)[2]].join())).toBe(true);
    expect(PLANE * PITCH).toBeLessThan(9.5 * 1000); // 32 cores fit R-221's 9.5 in frame
    const m = coreModel({ bits: Array(16).fill(0), drive: idle(), flipping: [], addr: 5, sense: false });
    expect(m.beats!.at(-1)!.labels).toBe(false);
    const names = new Set(m.items.flatMap((i) => [i.name, i.group]));
    for (const b of m.beats!) for (const f of b.frame ?? []) expect(names.has(f)).toBe(true);
    for (const a of m.anchors!) expect(a.p.every(Number.isFinite)).toBe(true);
    expect(CORE_HOME_FRAME.every((f) => names.has(f))).toBe(true);
  });

  it('every wire’s hover card names R-221 and the gauge', () => {
    for (const i of items().filter((x) => /wire/.test(x.name ?? ''))) {
      expect(i.info?.source).toMatch(/R-221/);
      expect(i.info?.dim).toMatch(/32 AWG/);
    }
    expect(items().find((i) => i.name === 'ferrite core')!.info?.source).toMatch(/sec\. 5\.22/);
  });
});
