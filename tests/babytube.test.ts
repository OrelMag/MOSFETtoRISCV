import { describe, expect, it } from 'vitest';
import { HOLD_BEATS, REFRESH_BEATS } from '../src/lib/baby';
import { SPOT_HALFLIFE, VISIT_BEATS, WILLIAMS_SA, WILLIAMS_SPOT, williamsColumn, williamsScan, williamsTube } from '../src/lib/babytube';
import { deadInstances } from '../src/sim/dead';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, type ComponentDef, netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const K = 3, N = 2 ** K, ROUND = VISIT_BEATS * N;

/** The tube on SwitchSim; time in beats: `beat()` is a clock and one beat of leakage, `idle(n)` n beats with the scanner stopped. */
function tube() {
  const sim = new SwitchSim(flatten(williamsTube(K), { mode: 'switch' }));
  const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) sim.setInput(k, v); sim.settle(); };
  set({ clk: 0, rst_n: 0, wr: 0, wa: 0, d: 0 });
  set({ rst_n: 1 });
  const root = sim.design.root, col = root.children!.get('col')!;
  const chargeNet = (i: number) => { const n = col.children!.get(`s${i}`)!; return n.nets![n.def.netlist!().nets.findIndex((x) => x.name === 'charge')][0]; };
  let clocks = 0;
  const t = {
    sim, set, clocks: () => clocks,
    charge: (i: number) => sim.level(chargeNet(i)),
    q: () => sim.get(root.ports.q[0]),
    beat() { set({ clk: 1 }); set({ clk: 0 }); clocks++; sim.leak(1); },
    idle(n: number) { sim.leak(n); },
    /** Beats until the pick-up reads spot i (phase 2 of its visit), returning what it read. */
    readSpot(i: number) {
      for (let n = 0; n < 2 * ROUND; n++) { t.beat(); if (clocks % 4 === 3 && Array.from({ length: K }, (_, b) => sim.get(root.ports.a[b])).reduce((v, x, b) => v + (x === B1 ? 1 << b : 0), 0) === i) return t.q(); }
      throw new Error('never reached');
    },
    write(i: number, v: number) {
      set({ wr: 1, wa: i, d: v });
      while (clocks % ROUND !== (i * VISIT_BEATS + VISIT_BEATS - 1) % ROUND) t.beat(); // up to the rewrite phase of its visit
      t.beat();
      set({ wr: 0 });
    },
  };
  return t;
}

describe('the sourced figures', () => {
  it('match lib/baby.ts: 654 beats of charge, a round of the line inside the 64-beat refresh', () => {
    expect(SPOT_HALFLIFE).toBe(HOLD_BEATS);
    expect(ROUND).toBeLessThanOrEqual(REFRESH_BEATS);
  });
});

describe('a spot (switch level)', () => {
  it('shares its charge with the plate and the amplifier restores it: 1 → 1, 0 → 0', () => {
    const t = tube();
    for (let i = 0; i < N; i++) t.write(i, i % 3 === 0 ? 1 : 0);
    // after a write the spot holds a full level
    for (let i = 0; i < N; i++) { if (i % 3 === 0) expect(t.charge(i), `spot ${i}`).toBeGreaterThan(0.95); else expect(t.charge(i)).toBe(0); }
    for (let i = 0; i < N; i++) expect(t.readSpot(i), `read ${i}`).toBe(i % 3 === 0 ? B1 : B0);
  });

  it('leaks: the level halves every SPOT_HALFLIFE beats', () => {
    const t = tube();
    t.write(5, 1);
    const l0 = t.charge(5);
    t.idle(SPOT_HALFLIFE);
    expect(t.charge(5)).toBeCloseTo(l0 / 2, 12);
    t.idle(SPOT_HALFLIFE);
    expect(t.charge(5)).toBeCloseTo(l0 / 4, 12);
  });

  it('a dash is read as a dash up to HOLD_BEATS after its last write and as a dot after', () => {
    const age = (extra: number) => {
      const t = tube();
      t.write(4, 1);
      t.write(0, 0);
      const t0 = t.clocks();
      t.idle(extra);
      const v = t.readSpot(4);
      return { v, age: t.clocks() - t0 + extra };
    };
    // the spot is visited ROUND − 1 beats after its rewrite: the age at the sense is extra + that
    const young = age(HOLD_BEATS - 2 * ROUND), old = age(HOLD_BEATS + 8);
    expect(young.v).toBe(B1);
    expect(old.v).toBe(B0);
    expect(young.age).toBeLessThan(HOLD_BEATS);
    expect(old.age).toBeGreaterThan(HOLD_BEATS);
  });
});

describe('regeneration', () => {
  it('with the scanner running every spot keeps its value for thousands of beats (2 000: 62 rounds of 32 and three times the hold time)', () => {
    const t = tube();
    const word = 0b10110010;
    for (let i = 0; i < N; i++) t.write(i, (word >> i) & 1);
    for (let n = 0; n < 2000; n++) t.beat();
    for (let i = 0; i < N; i++) expect(t.readSpot(i), `spot ${i}`).toBe((word >> i) & 1 ? B1 : B0);
    // each spot was rewritten every ROUND beats: its charge is never below what ROUND beats leave
    for (let i = 0; i < N; i++) if ((word >> i) & 1) expect(t.charge(i)).toBeGreaterThan(2 ** (-ROUND / SPOT_HALFLIFE) - 1e-9);
  }, 120000);

  it('without it (the scanner stopped) the dashes are dots after about HOLD_BEATS', () => {
    const t = tube();
    const word = 0b01011100;
    for (let i = 0; i < N; i++) t.write(i, (word >> i) & 1);
    t.idle(HOLD_BEATS + ROUND); // past the hold time
    const got = Array.from({ length: N }, (_, i) => (t.readSpot(i) === B1 ? 1 : 0)).reduce((w, v, i) => w | (v << i), 0);
    expect(got).toBe(0);
  });

  it('a write goes in while the rest regenerate', () => {
    const t = tube();
    for (let i = 0; i < N; i++) t.write(i, 1);
    t.write(3, 0); t.write(6, 0);
    for (let n = 0; n < 5 * ROUND; n++) t.beat();
    expect(Array.from({ length: N }, (_, i) => t.readSpot(i))).toEqual([1, 1, 1, 0, 1, 1, 0, 1].map((v) => (v ? B1 : B0)));
  });
});

describe('layout of the tube parts', () => {
  const defs: ComponentDef[] = [WILLIAMS_SPOT, WILLIAMS_SA, williamsColumn(N), williamsScan(K), williamsTube(K)];
  it.each(defs.map((d) => [d.id, d] as const))('%s: labels, symbols, pins, wires and dead parts are clean', (_, d) => {
    const nl = netlistOf(d)!;
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(backwardEnds(d, nl)).toEqual([]);
    expect(wireOverlaps(routeNetlist(d, nl).nets)).toEqual([]);
    expect(deadInstances(nl, d.ports)).toEqual([]);
  });
});
