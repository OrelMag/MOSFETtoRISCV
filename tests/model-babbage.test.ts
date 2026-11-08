// Babbage's carry: the column's two carriages against plain decimal addition, the order the helix reaches the arms in, the
// anticipating carriage against the successive one, and the quoted gate delays against the library.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { koggeStone, rca } from '../src/lib';
import { logicDepth } from '../src/sim/stats';
import {
  ADD_UNITS, ARMS, DIGITS, EVENTS, carryUnits, predictVerdict, runCase, GAP_DEG, MOD, PER_COLUMN, PITCH_DEG, SPLIT, TURN_MAX, advanceTo, anticipate, armAngle, armPhase, armTime, babbageAnchors, babbageParts, begin, digitGroups,
  CASES, columnReads, finished, finishCarry, fromValue, gateRows, giveOff, nextFiring, pending, sweep, valueOf, zero, type BabbagePalette,
} from '../src/widgets/babbage3dparts';

const c = (i: number): RGB => [i / 20, 0.5, 0.5];
const P: BabbagePalette = { frame: c(1), metal: c(2), wheel: c(3), tick: c(4), lever: c(5), warn: c(6), arm: c(7), live: c(8), nine: c(9) };
const nines = (n: number) => 10n ** BigInt(n) - 1n;
// A small seeded generator so the cases are the same on every run.
let seed = 12345;
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const big = (digits: number): bigint => { let v = 0n; for (let i = 0; i < digits; i++) v = v * 10n + BigInt(Math.floor(rnd() * 10)); return v; };
/** A random column with runs of 9s: the cases that matter for a carry. */
const nasty = (): bigint => { let v = 0n; for (let i = 0; i < DIGITS; i++) v += BigInt(rnd() < 0.6 ? 9 : Math.floor(rnd() * 10)) * 10n ** BigInt(i); return v; };

describe('the column of figure wheels', () => {
  it('has the engine’s 31 wheels and 30 carry arms', () => {
    expect(DIGITS).toBe(31);
    expect(ARMS).toBe(30);
    expect(fromValue(0n).w).toHaveLength(31);
  });
  it('reads back the number it was given, and wraps at 10^31', () => {
    for (let k = 0; k < 40; k++) { const v = big(31); expect(valueOf(fromValue(v))).toBe(v); }
    expect(valueOf(fromValue(MOD + 7n))).toBe(7n);
  });
  it('giving-off arms a latch exactly where a wheel passes 9 to 0, and carries nothing', () => {
    const a = fromValue(4259n), g = giveOff(a, 6332n);
    expect(g.w.slice(0, 5)).toEqual([1, 8, 5, 0, 0]);
    expect(g.warn.flatMap((x, i) => (x ? [i] : []))).toEqual([0, 3]);
    expect(pending(g)).toBe(2);
    // The wheels above did not move yet: 4259 + 6342 without carries is the digitwise sum mod 10.
    expect(valueOf(g)).toBe(1n + 8n * 10n + 5n * 100n);
    expect(sweep(g).longest).toBe(1);
    expect(valueOf(sweep(g).col)).toBe(10591n);
  });
  it('a wheel never arms twice in one addition: the digit sum is at most 18', () => {
    const g = giveOff(fromValue(nines(31)), nines(31));
    expect(g.w.every((d) => d === 8)).toBe(true);
    expect(g.warn.every(Boolean)).toBe(true);
  });
});

describe('the carry axis and its helix', () => {
  it('the arms are 22 degrees apart, with 45 between the 15th and the 16th', () => {
    for (let a = 1; a < ARMS; a++) {
      const step = ((armAngle(a) - armAngle(a - 1)) % 360 + 360) % 360;
      expect(step).toBe(a === SPLIT ? GAP_DEG : PITCH_DEG);
    }
  });
  it('polls each section from below, and the upper section’s first arm comes before arm 0 in a rotation', () => {
    for (let a = 1; a < SPLIT; a++) expect(armTime(a, 0)).toBeGreaterThan(armTime(a - 1, 0));
    for (let a = SPLIT + 1; a < ARMS; a++) expect(armTime(a, 0)).toBeGreaterThan(armTime(a - 1, 0));
    expect(armTime(SPLIT, 0)).toBeLessThan(armTime(0, 0));
    expect(armTime(SPLIT, 0)).toBe(0);
    // A carry out of arm 14 reaches lever 15 after that lever was polled: it has to wait for the second rotation.
    expect(armTime(SPLIT, 0)).toBeLessThan(armTime(SPLIT - 1, 0));
    expect(armTime(SPLIT, 1)).toBeGreaterThan(armTime(SPLIT - 1, 0));
  });
  it('two rotations, every arm polled twice, in time order', () => {
    expect(EVENTS).toHaveLength(2 * ARMS);
    for (let k = 1; k < EVENTS.length; k++) expect(EVENTS[k].t).toBeGreaterThanOrEqual(EVENTS[k - 1].t);
    expect(EVENTS[EVENTS.length - 1].t).toBeLessThan(TURN_MAX);
  });
  it('an arm is at the contact direction exactly when its poll comes up', () => {
    for (const e of EVENTS) expect(((armPhase(e.arm, e.t) % 360) + 360) % 360).toBeCloseTo(0, 9);
  });
});

describe('successive carriage', () => {
  it('a full carry phase equals decimal addition, on random and on 9-heavy columns, with overflow flagged', () => {
    for (let k = 0; k < 300; k++) {
      const x = k % 2 ? big(31) : nasty(), y = k % 3 ? big(31) : nasty();
      const done = sweep(giveOff(fromValue(x), y));
      expect(pending(done.col)).toBe(0);
      expect(valueOf(done.col)).toBe(x + y);
    }
  });
  it('a domino across all 31 wheels needs every arm and ends in the overflow flag', () => {
    const s = sweep(giveOff(fromValue(nines(31)), 1n));
    expect(s.fired).toHaveLength(ARMS);
    expect(s.longest).toBe(ARMS);
    expect(s.col.w.every((d) => d === 0)).toBe(true);
    expect(s.col.warn[DIGITS - 1]).toBe(true);
    expect(valueOf(s.col)).toBe(MOD);
  });
  it('the number of carries in the longest run is the longest domino, wheel by wheel', () => {
    for (const run of [1, 2, 5, 9, 14, 15, 16, 20, 29]) {
      const s = sweep(giveOff(fromValue(nines(run)), 1n));
      expect(s.longest, `${run} nines`).toBe(run);
      expect(s.fired).toEqual(Array.from({ length: run }, (_, i) => i));
    }
  });
  it('a run inside one section takes 22 degrees an arm; one that crosses the 15 | 16 gap waits for the second rotation', () => {
    for (const run of [2, 6, 12, 14]) {
      const s = sweep(giveOff(fromValue(nines(run)), 1n));
      expect(s.lastT - armTime(0, 0)).toBe(PITCH_DEG * (run - 1));
      expect(s.lastT).toBeLessThan(360);
    }
    expect(sweep(giveOff(fromValue(nines(15)), 1n)).lastT).toBeLessThan(360);
    for (const run of [16, 20, 31]) expect(sweep(giveOff(fromValue(nines(Math.min(run, 31))), 1n)).lastT).toBeGreaterThanOrEqual(360);
  });
  it('the cost of a run grows with its length, one arm at a time', () => {
    let prev = -1;
    for (let run = 1; run <= 14; run++) {
      const t = sweep(giveOff(fromValue(nines(run)), 1n)).lastT;
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });
  it('stepping to the next firing reaches the same end as the whole sweep, never skipping a carry', () => {
    let s = begin(giveOff(fromValue(nines(20)), 1n));
    for (let guard = 0; guard < 100 && !finished(s); guard++) {
      const t = nextFiring(s)!;
      expect(t).not.toBeNull();
      const n = s.fired.length;
      s = advanceTo(s, t);
      expect(s.fired.length).toBeGreaterThan(n);
    }
    expect(valueOf(s.col)).toBe(nines(20) + 1n);
    expect(nextFiring(s)).toBeNull();
  });
  it('nothing armed, nothing fires', () => {
    const g = giveOff(fromValue(11n), 22n);
    expect(nextFiring(begin(g))).toBeNull();
    expect(sweep(g).fired).toHaveLength(0);
  });
});

describe('anticipating carriage', () => {
  it('settles to the same column as the successive carriage, on every case', () => {
    for (let k = 0; k < 300; k++) {
      const x = k % 2 ? big(31) : nasty(), y = k % 3 ? big(31) : nasty(), g = giveOff(fromValue(x), y);
      const a = anticipate(g).col, s = sweep(g).col;
      expect(a.w).toEqual(s.w);
      expect(a.warn[DIGITS - 1]).toBe(s.warn[DIGITS - 1]);
      expect(valueOf(a)).toBe(x + y);
    }
  });
  it('foresees a carry into every wheel of a run of 9s at once, and into nothing else', () => {
    const g = giveOff(fromValue(nines(7)), 1n), { carryIn } = anticipate(g);
    expect(carryIn.flatMap((x, i) => (x ? [i] : []))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('is one step whatever the run, where the successive carriage takes a step a wheel', () => {
    for (const run of [1, 4, 9, 20, 30]) {
      const g = giveOff(fromValue(nines(run)), 1n);
      expect(anticipate(g).carryIn.filter(Boolean)).toHaveLength(run); // run carries all decided in one pass
      expect(sweep(g).fired).toHaveLength(run); // run arms, one after another
    }
  });
});

describe('against the gate adders', () => {
  it('quotes the library: 2 NAND delays a column for the ripple adder, 2n + 4 in all', () => {
    expect(PER_COLUMN).toBe(2);
    for (const r of gateRows()) {
      expect(r.ripple).toBe(logicDepth(rca(r.n)));
      expect(r.ks).toBe(logicDepth(koggeStone(r.n)));
      expect(r.ripple).toBe(PER_COLUMN * r.n + 4);
    }
  });
  it('the ripple adder gets slower with width; the prefix adder gains a level a doubling', () => {
    const rows = gateRows();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].ripple).toBeGreaterThan(rows[i - 1].ripple);
      expect(rows[i].ks - rows[i - 1].ks).toBe(rows[1].ks - rows[0].ks);
    }
  });
});

describe('the finished carry phase', () => {
  it('animated and reduced-motion runs end at the same angle: the last carry, rounded the same', () => {
    for (const run of [1, 6, 14, 20, 31]) {
      const g = giveOff(fromValue(nines(run)), 1n);
      // Animated: the axis turns on in small frames until nothing is armed; reduced motion: one jump to the end of the cycle.
      let a = begin(g);
      for (let th = 0; !finished(a) && th <= TURN_MAX; th += 3.7) a = advanceTo(a, th);
      a = finishCarry(a);
      const r = finishCarry(advanceTo(begin(g), TURN_MAX));
      expect(Math.round(a.theta)).toBe(Math.round(r.theta));
      expect(a.theta).toBe(a.lastT);
      expect(r.theta).toBe(r.lastT);
      expect(valueOf(a.col)).toBe(valueOf(r.col));
    }
  });
  it('a carry phase with nothing to carry stays where it was', () => {
    const s = finishCarry(advanceTo(begin(giveOff(fromValue(11n), 22n)), TURN_MAX));
    expect(s.fired).toHaveLength(0);
  });
});

describe('big numbers in the readouts', () => {
  const BARE = /[0-9]{5,}/, THIN = String.fromCharCode(0x202f);
  it('the column reading, the aria and status text and every case blurb group their digits with the site’s thin spaces', () => {
    for (const v of [0n, 9999n, 10000n, 7999999n, nines(20) + 1n, nines(31), MOD - 1n, MOD, MOD + 5n]) expect(columnReads(v)).not.toMatch(BARE);
    expect(columnReads(nines(20) + 1n)).toBe(['100', ...Array(6).fill('000')].join(THIN));
    expect(columnReads(7999999n)).toBe(['7', '999', '999'].join(THIN));
    for (const c of CASES) { expect(c.blurb).not.toMatch(BARE); expect(c.label).not.toMatch(BARE); }
    expect(CASES[1].blurb.startsWith('7' + THIN + '999' + THIN + '999 + 1')).toBe(true);
  });
  it('the view and its entry write no number of five digits or more bare, and format the column only through columnReads', () => {
    for (const f of ['../src/widgets/babbage3dview.ts', '../src/widgets/babbage3d.ts']) expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toMatch(BARE);
    expect(readFileSync(new URL('../src/widgets/babbage3dview.ts', import.meta.url), 'utf8')).not.toContain('% MOD');
  });
});

describe('the digit row', () => {
  const row = (v: bigint) => digitGroups(fromValue(v).w.slice().reverse()).map((g) => g.join(''));
  it('groups from the units: a leading single digit, then threes, so it reads like the number', () => {
    const g = row(7999999n);
    expect(g).toHaveLength(11);
    expect(g[0]).toHaveLength(1);
    expect(g.slice(1).every((x) => x.length === 3)).toBe(true);
    expect(g.slice(-3)).toEqual(['007', '999', '999']);
    expect(row(nines(31))[0]).toBe('9');
  });
});

describe('the drawing', () => {
  const pose = (g = zero(), theta = 0) => ({ col: g, theta, foresee: null });
  it('draws a wheel, tick and lever per wheel and an arm per carry arm', () => {
    const parts = babbageParts(pose(), P);
    expect(parts.length).toBe(DIGITS * 3 + ARMS + 2 + 2 + 0);
  });
  it('an armed latch is drawn in the warning colour, and only those', () => {
    const g = giveOff(fromValue(4259n), 6332n), warn = babbageParts(pose(g, 18), P).filter((p) => p.color === P.warn);
    expect(warn).toHaveLength(pending(g));
  });
  it('the tick moves with the digit and the arm marked as polled follows the axis', () => {
    const a = babbageParts(pose(fromValue(0n)), P), b = babbageParts(pose(fromValue(5n)), P);
    expect(a.filter((p) => p.color === P.tick)[0].pos).not.toEqual(b.filter((p) => p.color === P.tick)[0].pos);
    const at = (th: number) => babbageParts(pose(zero(), th), P).filter((p) => p.color === P.warn).length;
    expect(at(armTime(0, 0))).toBeGreaterThanOrEqual(1);
    expect(at(armTime(0, 0) + 11)).toBe(0);
  });
  it('labels what is drawn', () => {
    const labels = babbageAnchors(pose()).map((a) => a.text);
    expect(labels).toContain('figure wheel');
    expect(labels.some((l) => l.startsWith('warning lever'))).toBe(true);
  });
});

describe('the common time axis, the predict step and the look-ahead rod', () => {
  it('both carriages are on Babbage’s axis: nine units to add; anticipating carries in one, successive in the carry axis’s turns', () => {
    expect(ADD_UNITS).toBe(9);
    for (const k of CASES) {
      const r = sweep(giveOff(fromValue(k.start), k.add));
      expect(carryUnits(true, r.lastT, r.fired.length)).toBe(1);
      const s = carryUnits(false, r.lastT, r.fired.length);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(2);
    }
    expect(carryUnits(false, 0, 0)).toBe(0);
    // a longer run costs the successive carriage more, never the anticipating one
    const u = (n: number) => { const r = sweep(giveOff(fromValue(nines(n)), 1n)); return carryUnits(false, r.lastT, r.fired.length); };
    expect(u(30)).toBeGreaterThan(u(3));
    expect(u(30)).toBeLessThanOrEqual(2);
  });
  it('a run of n nines plus 1 fires exactly n arms, for every n the slider offers', () => {
    for (let n = 1; n <= ARMS; n++) {
      const k = runCase(n), r = sweep(giveOff(fromValue(k.start), k.add));
      expect(r.fired.length, String(n)).toBe(n);
      expect(r.longest, String(n)).toBe(n);
      expect(valueOf(r.col)).toBe(k.start + 1n);
    }
    expect(runCase(99).start).toBe(nines(ARMS));
  });
  it('the verdict compares the guess with the arms fired and sets it beside the ripple and prefix adders', () => {
    expect(predictVerdict(12, 12)).toMatch(/^Right/);
    expect(predictVerdict(3, 12)).toMatch(/^More than you guessed/);
    expect(predictVerdict(20, 12)).toMatch(/^Fewer than you guessed/);
    expect(predictVerdict(12, 12)).toContain(`12 × ${PER_COLUMN} = ${12 * PER_COLUMN} NAND delays`);
    expect(predictVerdict(12, 12)).toContain(`takes ${gateRows().find((r) => r.n === 32)!.ks} whatever the run`);
  });
  it('wheels at 9 are marked in their own tick colour, and the look-ahead rod appears only with the anticipating carriage', () => {
    const g = fromValue(7999999n), base = { col: g, theta: 0, foresee: null };
    expect(babbageParts(base, P).filter((p) => p.color === P.nine)).toHaveLength(6);
    const n0 = babbageParts(base, P).length;
    expect(babbageParts({ ...base, lookAhead: true }, P).length).toBe(n0 + 1);
    const after = giveOff(g, 1n), fs = anticipate(after).carryIn;
    expect(babbageParts({ col: after, theta: 0, foresee: fs, lookAhead: true }, P).length).toBe(n0 + 2);
    expect(babbageAnchors({ ...base, lookAhead: true }).map((a) => a.text)).toContain('look-ahead (effect only)');
    expect(babbageAnchors(base).map((a) => a.text)).not.toContain('look-ahead (effect only)');
  });
});
