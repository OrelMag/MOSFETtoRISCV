// The core memory plane: the coincident-current rule, and the drawing held to it.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import {
  FULL, HALF, IC, ID, N, OD, PITCH, RING_R, TUBE_R, WIRE_R, applyDrive, centreOf, colOf, coreParts, halfSelected, idle, planOp, rowOf, wirePaths, runsOf, ringPoint, senseDiag, cycleFault, marginOf, marginWindow, icOf, HALF_MIN, HALF_MAX, STACK_DY, coreAnchors, type CorePalette, type Op,
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
      const R = runsOf(), lines: [Vec3, Vec3][] = [[W.x[r][0], W.x[r][1]], [W.y[col][0], W.y[col][1]], R.sense[senseDiag(k)], R.inhibit[r]];
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
    // the sense wire runs along the ring axis (diagonals r - c = d), alternating direction diagonal by diagonal
    expect(R.sense.map(along)).toEqual([1, -1, 1, -1, 1, -1, 1]);
  });

  it('draws sixteen rings and a lit wire only where there is current', () => {
    const dark = coreParts(pose(), PAL), d = idle(); d.x[1] = 1; d.y[1] = 1;
    const lit = coreParts(pose({ drive: d }), PAL);
    const live = (ps: typeof dark) => ps.filter((p) => p.color[0] === 0 && p.color[1] === 1 && p.color[2] === 0).length;
    expect(live(dark)).toBe(0);
    expect(live(lit)).toBeGreaterThan(0);
    // 16 rings of 14 segments in ferrite colour
    expect(dark.filter((p) => p.color[0] === 0.1 && (p.color as number[])[3] === undefined).length).toBe(16 * 14);
  });

  it('shows the stored bit as the circulation direction', () => {
    const arrows = (bit: number) => coreParts(pose({ bits: Array(16).fill(bit) }), PAL).filter((p) => p.color[0] === (bit ? 1 : 0) && p.color[2] === (bit ? 0 : 1) && p.color[1] === 0).length;
    expect(arrows(1)).toBe(16 * 11);
    expect(arrows(0)).toBe(16 * 11);
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

describe('real-plane details', () => {
  it('the sense wire is one diagonal polyline threading all sixteen holes', () => {
    const R = runsOf(), seen = new Set<number>();
    expect(R.sense.length).toBe(2 * N - 1);
    for (let k = 0; k < 16; k++) seen.add(senseDiag(k));
    expect(seen.size).toBe(2 * N - 1);
    const W = wirePaths();
    expect(W.sense.length).toBe(2 * R.sense.length + 3); // ground drop, the runs, the lead to the amplifier
  });

  it('a three-wire plane draws one wire fewer and lights the shared wire for sense or inhibit', () => {
    const d = idle(); d.inh = -1;
    const four = coreParts(pose({ drive: d }), PAL), three = coreParts(pose({ drive: d, threeWire: true }), PAL);
    expect(three.length).toBeLessThan(four.length);
    const live = (ps: typeof four) => ps.filter((p) => p.color[0] === 0 && p.color[1] === 1 && p.color[2] === 0).length;
    expect(live(four)).toBeGreaterThan(0); // the inhibit wire
    expect(live(three)).toBeGreaterThan(0); // the merged wire
  });

  it('a faint second plane lies below, with sixteen ghost cores', () => {
    const ps = coreParts(pose(), PAL), ghosts = ps.filter((p) => ((p.color as number[])[3] ?? 1) < 1);
    expect(ghosts.length).toBe(17);
    expect(STACK_DY).toBeLessThan(-20);
    expect(coreAnchors().some((a) => /16 more planes/.test(a.text))).toBe(true);
  });

  it('a phone gets two labels', () => {
    expect(coreAnchors(true).length).toBe(2);
    expect(coreAnchors().length).toBeGreaterThan(5);
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

describe('wire gauge (MIT Report R-221, section 5.24)', () => {
  it('draws Whirlwind\'s 32-gauge magnet wire at its bare copper diameter, 0.00795 in', async () => {
    const { AWG, awgInch, UNIT_MIL } = await import('../src/widgets/core3dparts');
    expect(AWG).toBe(32);
    expect(awgInch(36)).toBeCloseTo(0.005, 6); // the AWG series' anchor
    expect(awgInch(32)).toBeCloseTo(0.00795, 5);
    expect(WIRE_R * 2 * UNIT_MIL).toBeCloseTo(7.95, 2);
  });
});
