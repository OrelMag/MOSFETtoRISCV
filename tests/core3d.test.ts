// The core memory plane: the coincident-current rule, and the drawing held to it.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import {
  FULL, HALF, IC, ID, N, OD, PITCH, RING_R, TUBE_R, WIRE_R, applyDrive, centreOf, colOf, coreParts, halfSelected, idle, planOp, rowOf, wirePaths, runsOf, ringPoint, type CorePalette, type Op,
} from '../src/widgets/core3dparts';
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

const C = (n: number): RGB => [n, n, n];
const PAL: CorePalette = { ferrite: C(0.1), frame: C(0.2), metal: C(0.3), wx: C(0.4), wy: C(0.5), ws: C(0.6), wi: C(0.7), live: [0, 1, 0], one: [1, 0, 0], zero: [0, 0, 1], lamp: C(0.9), lampOff: C(0.8), sel: C(0.35) };
const pose = (o = {}) => ({ bits: Array(16).fill(0), drive: idle(), u: 0.5, flipping: [] as number[], addr: 5 as number | null, sense: false, ...o });

describe('the drawing', () => {
  it('uses the real proportions: 80 mil outside, 50 mil inside, 20 mil high; the pitch is 120 mil', () => {
    expect(OD / ID).toBeCloseTo(80 / 50, 9);
    expect(PITCH * 5).toBe(120);
    expect(RING_R).toBeCloseTo((OD + ID) / 4, 9);
    expect(PITCH).toBeGreaterThan(OD * 0.9); // cores clear each other
  });

  it('every wire passes through the hole of every core it is meant to thread', () => {
    const W = wirePaths(), A: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
    const holeDist = (a: Vec3, b: Vec3, c: Vec3): number => { // where the line a-b meets the plane through c normal to the ring axis, distance to c
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], da = d[0] * A[0] + d[2] * A[2], ca = (c[0] - a[0]) * A[0] + (c[2] - a[2]) * A[2], t = ca / da;
      const p = [a[0] + d[0] * t - c[0], a[1] + d[1] * t - c[1], a[2] + d[2] * t - c[2]];
      return Math.hypot(...p);
    };
    for (let k = 0; k < 16; k++) {
      const c = centreOf(k), r = rowOf(k), col = colOf(k);
      const R = runsOf(), lines: [Vec3, Vec3][] = [[W.x[r][0], W.x[r][1]], [W.y[col][0], W.y[col][1]], R.sense[col], R.inhibit[r]];
      for (const [a, b] of lines) expect(holeDist(a, b, c)).toBeLessThan(ID / 2 - WIRE_R - 0.2);
    }
    expect(TUBE_R).toBeLessThan(RING_R); // the ring has a hole
    expect(ringPoint(0, 0, RING_R)).toHaveLength(3);
  });

  it('the inhibit and both select wires thread every core the same way, so the inhibit current opposes the selects in all sixteen', () => {
    const W = wirePaths(), R = runsOf(), A = [Math.SQRT1_2, 0, Math.SQRT1_2];
    const along = ([a, b]: [Vec3, Vec3]) => Math.sign((b[0] - a[0]) * A[0] + (b[2] - a[2]) * A[2]);
    for (let k = 0; k < 16; k++) {
      const r = rowOf(k), c = colOf(k);
      expect(along([W.x[r][0], W.x[r][1]])).toBe(1);
      expect(along([W.y[c][0], W.y[c][1]])).toBe(1);
      expect(along(R.inhibit[r])).toBe(1);
    }
    // the sense wire alternates by column: the amplifier is bipolar
    expect(R.sense.map(along)).toEqual([1, -1, 1, -1]);
  });

  it('draws sixteen rings and a lit wire only where there is current', () => {
    const dark = coreParts(pose(), PAL), d = idle(); d.x[1] = 1; d.y[1] = 1;
    const lit = coreParts(pose({ drive: d }), PAL);
    const live = (ps: typeof dark) => ps.filter((p) => p.color[0] === 0 && p.color[1] === 1 && p.color[2] === 0).length;
    expect(live(dark)).toBe(0);
    expect(live(lit)).toBeGreaterThan(0);
    // 16 rings of 14 segments in ferrite colour
    expect(dark.filter((p) => p.color[0] === 0.1).length).toBe(16 * 14);
  });

  it('shows the stored bit as the circulation direction', () => {
    const arrows = (bit: number) => coreParts(pose({ bits: Array(16).fill(bit) }), PAL).filter((p) => p.color[0] === (bit ? 1 : 0) && p.color[2] === (bit ? 0 : 1) && p.color[1] === 0).length;
    expect(arrows(1)).toBe(16 * 11);
    expect(arrows(0)).toBe(16 * 11);
  });
});
