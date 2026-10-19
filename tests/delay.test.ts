import { describe, expect, it } from 'vitest';
import { busMux2, rca } from '../src/lib/combinational';
import { brentKung, koggeStone, sklansky } from '../src/lib/fastadd';
import { chapterById } from '../src/chapters';
import { register } from '../src/lib/sequential';
import { bestBuffering, effortDelay, fanoutOf, inputArrivals, leafDelays, nandDelay, netLoads, TAU_PER_UNIT } from '../src/sim/delay';
import { flatten } from '../src/sim/flatten';
import { FF_INPUT, FF_WIRE } from '../src/sim/netcap';
import { logicDepth } from '../src/sim/stats';
import { analyzeTiming, CLK_TO_Q, SETUP } from '../src/sim/timing';

const fo = (n: number) => n * (FF_INPUT + FF_WIRE);

describe('logical-effort delay', () => {
  it('one unit is a NAND2 driving one NAND input', () => {
    expect(TAU_PER_UNIT).toBeCloseTo(2 + (4 / 3) * 1.6, 10);
    expect(nandDelay(fo(1))).toBeCloseTo(1, 10);
    expect(nandDelay(0)).toBeCloseTo(2 / TAU_PER_UNIT, 10); // parasitic only
  });

  it('grows linearly as drawn, logarithmically once buffered', () => {
    for (let n = 1; n < 64; n++) {
      expect(nandDelay(fo(n + 1), false)).toBeGreaterThan(nandDelay(fo(n), false));
      expect(nandDelay(fo(n + 1))).toBeGreaterThanOrEqual(nandDelay(fo(n)));
      expect(nandDelay(fo(n))).toBeLessThanOrEqual(nandDelay(fo(n), false));
    }
    // light loads are never buffered; a pair of inverters pays from fan-out 4
    expect(bestBuffering(fo(1)).pairs).toBe(0);
    expect(bestBuffering(fo(2)).pairs).toBe(0);
    expect(bestBuffering(fo(4)).pairs).toBe(1);
    // each pair is the best count: one more or one fewer is no faster
    for (const n of [4, 16, 64, 256, 1024]) {
      const b = bestBuffering(fo(n));
      expect(effortDelay(fo(n), b.pairs + 1) / TAU_PER_UNIT).toBeGreaterThanOrEqual(b.delay);
      if (b.pairs) expect(effortDelay(fo(n), b.pairs - 1) / TAU_PER_UNIT).toBeGreaterThan(b.delay);
    }
    // a thousand loads cost a handful of units, not a thousand
    expect(nandDelay(fo(1024))).toBeLessThan(8);
    expect(nandDelay(fo(1024), false)).toBeGreaterThan(500);
  });

  it('a part alone is measured between gates', () => {
    const d = flatten(rca(4), { mode: 'gate' });
    const loads = netLoads(d);
    // each output loads one NAND input
    for (const net of d.root.ports.s) expect(fanoutOf(loads[net])).toBe(1);
    // each input is driven by a minimum NAND outside: its load beyond one input arrives late
    const arr = inputArrivals(d, 'load')!;
    for (const net of d.root.ports.a) expect(arr[net]).toBeCloseTo(nandDelay(loads[net]) - 1, 10);
    expect(inputArrivals(d, 'unit')).toBeNull();
  });

  it('unit delay is unchanged', () => {
    const d = flatten(rca(8), { mode: 'gate' });
    expect([...leafDelays(d, 'unit')].every((x) => x === 1)).toBe(true);
    expect(logicDepth(rca(8))).toBe(20);
  });
});

describe('load-dependent depth and timing', () => {
  it('a ripple carry costs its fan-out at every bit, linearly', () => {
    const d8 = logicDepth(rca(8), 'load')!, d16 = logicDepth(rca(16), 'load')!, d32 = logicDepth(rca(32), 'load')!;
    expect(d8).toBeGreaterThan(logicDepth(rca(8))!);
    expect(d32 - d16).toBeCloseTo(2 * (d16 - d8), 0);
  });

  it('Kogge–Stone stays far ahead of ripple at 32 bits', () => {
    const ks = logicDepth(koggeStone(32), 'load')!, r = logicDepth(rca(32), 'load')!;
    expect(ks).toBeGreaterThan(logicDepth(koggeStone(32))!);
    expect(r / ks).toBeGreaterThan(3);
  });

  it('a select driving 32 muxes is no longer free', () => {
    const unit = logicDepth(busMux2(32))!, load = logicDepth(busMux2(32), 'load')!;
    expect(load).toBeGreaterThan(unit + 2);
  });

  it('a register launches at clk-to-q plus its output load', () => {
    const d = flatten(register(4), { mode: 'gate' });
    const u = analyzeTiming(d)!, l = analyzeTiming(d, { delay: 'load' })!;
    expect(u.model).toBe('unit');
    expect(l.model).toBe('load');
    expect(u.period).toBe(CLK_TO_Q + u.logic + SETUP);
    expect(l.period).toBeGreaterThan(0);
    for (const p of l.path) expect(p.fanout).toBeGreaterThanOrEqual(0);
  });
});

describe('chapter 16 quotes the prefix family as measured', () => {
  const f = (x: number | null) => x!.toFixed(1);
  it('recap numbers', () => {
    const keep = chapterById('fastadd')!.recap!.keep.join(' ');
    expect(keep).toContain(`Kogge–Stone ${f(logicDepth(koggeStone(32), 'load'))} units, Sklansky ${f(logicDepth(sklansky(32), 'load'))}, Brent–Kung ${f(logicDepth(brentKung(32), 'load'))}`);
  });
  it('the prose: Sklansky ties in unit delay, loses as drawn, comes back with buffers', () => {
    expect(logicDepth(sklansky(64))).toBe(logicDepth(koggeStone(64)));
    const drawn = [sklansky(64), brentKung(64), koggeStone(64)].map((d) => logicDepth(d, 'drawn')!);
    expect(drawn[0]).toBeGreaterThan(drawn[1]);
    expect(drawn[1]).toBeGreaterThan(drawn[2]);
    const sk = logicDepth(sklansky(64), 'load')!, ks = logicDepth(koggeStone(64), 'load')!;
    expect(sk - ks).toBeGreaterThan(0);
    expect(sk - ks).toBeLessThan(5); // "within a few units"
    expect(logicDepth(brentKung(64), 'load')!).toBeGreaterThan(sk);
    const step = chapterById('fastadd')!.steps.find((s) => s.title === 'When fan-out costs')!;
    const q = step.challenge!;
    expect(q.kind === 'quiz' && q.answer).toBe(0);
  });
});
