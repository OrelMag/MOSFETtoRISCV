// The expert's bench: each case really has its fault in it. The symptom must come with the fault and go without it, on the book's own models,
// for several seeds; otherwise a case would be teaching a story and not a diagnosis.

import { describe, expect, it } from 'vitest';
import { ATTEMPT_CASES, attemptCases, FAULT_CASES, PASS_MARK } from '../src/comm/faults';
import { SURVIVOR, UART_ERR } from '../src/chapters/ch-comm-bench';
import { receive, UART_8N1 } from '../src/comm/startstop';
import { tick } from './yieldtick';

const SEEDS = [1, 2, 3, 4];
const of = (id: string) => FAULT_CASES.find((c) => c.id === id)!;
/** The fault's case and its healthy control, for each seed. */
const each = (id: string, f: (sick: Record<string, number>, well: Record<string, number>) => void) => {
  for (const s of SEEDS) f(of(id).build(s).metrics, of(id).build(s, true).metrics);
};

describe('every case has its fault in it', () => {
  it('loss: line errors and retransmissions, with the round trip flat; none without', () => each('tcp_loss', (a, b) => {
    expect(a.losses).toBeGreaterThan(0);
    expect(a.retrans).toBeGreaterThan(0);
    expect(a.drops).toBe(0);
    expect(a.late / a.first).toBeLessThan(1.3);
    expect(a.done).toBeGreaterThan(b.done);
    expect([b.losses, b.retrans]).toEqual([0, 0]);
  }));
  it('a slow reader: the window closes, nothing is lost; the window stays open without', () => each('tcp_reader', (a, b) => {
    expect(a.zero).toBeGreaterThan(0);
    expect([a.losses, a.drops, a.retrans]).toEqual([0, 0, 0]);
    expect(a.done).toBeGreaterThan(2 * b.done);
    expect(b.zero).toBe(0);
  }));
  it('a bloated queue: the round trip climbs with nothing lost; it stays flat on a line that keeps up', () => each('tcp_bloat', (a, b) => {
    expect(a.late / a.first).toBeGreaterThan(2);
    expect([a.losses, a.drops, a.retrans]).toEqual([0, 0, 0]);
    expect(b.late / b.first).toBeLessThan(1.3);
  }));
  it('a tiny queue: drops at the queue and none on the line; none with room', () => each('tcp_tiny', (a, b) => {
    expect(a.drops).toBeGreaterThan(0);
    expect(a.losses).toBe(0);
    expect(b.drops).toBe(0);
    expect(a.done).toBeGreaterThan(b.done);
  }));
  it('too little band: the eye shuts; it opens with band', () => each('line_band', (a, b) => {
    expect(a.opening).toBeLessThan(0.1);
    expect(b.opening).toBeGreaterThan(0.5);
  }));
  it('noise: the eye stays open and the errors come; none with little noise', () => each('line_noise', (a, b) => {
    expect(a.opening).toBeGreaterThan(0.5);
    expect(a.ber).toBeGreaterThan(1e-4);
    expect(b.ber).toBeLessThan(1e-12);
  }));
  it('clock error: characters come out wrong; none at 1 %', () => each('uart_clock', (a, b) => {
    expect(a.wrong + a.framing).toBeGreaterThan(0);
    expect([b.wrong, b.framing]).toEqual([0, 0]);
  }));
  it('a saturated segment: collisions, and less carried than asked; hardly any under a light load', () => each('eth_collide', (a, b) => {
    expect(a.collisions).toBeGreaterThan(10 * Math.max(1, b.collisions));
    expect(a.throughput).toBeLessThan(0.85 * a.offered);
    expect(b.throughput).toBeGreaterThan(0.8 * b.offered);
  }));
  it('a bad cable: frames fail the real check; none without', () => each('eth_badframe', (a, b) => {
    expect(a.bad).toBeGreaterThan(5);
    expect(b.bad).toBe(0);
  }));
  it('a small table: entries overwritten and most frames flooded; far fewer with room', () => each('sw_flood', (a, b) => {
    expect(a.flooded).toBeGreaterThan(0.5);
    expect(a.evicted).toBeGreaterThan(100);
    expect(b.flooded).toBeLessThan(a.flooded / 2);
  }));
  it('a hijack: the trace ends in the false network; it reaches the site without', () => each('route_hijack', (a, b) => {
    expect(a.sable).toBe(1);
    expect(a.sameEnd).toBe(0);
    expect(b.sable).toBe(0);
    expect(b.sameEnd).toBe(1);
  }));
  it('a failed link: the trace stops with no route, part way; it reaches the site without', () => each('route_down', (a, b) => {
    expect(a.noroute).toBe(1);
    expect(a.reached).toBe(0);
    expect(a.hopsNow).toBeLessThan(a.hopsBefore);
    expect(b.reached).toBe(1);
  }));
});

describe('the chapter\'s typed claims', () => {
  it('at the quiz\'s clock error U fails and the other character survives, in the model', () => {
    expect(SURVIVOR).toBeGreaterThanOrEqual(0);
    expect(receive(UART_8N1, 0x55, { err: UART_ERR }).ok).toBe(false);
    expect(receive(UART_8N1, SURVIVOR, { err: UART_ERR }).ok).toBe(true);
  });
});

describe('the cases as questions', () => {
  it('each has four causes, the first the right one, a reason against each wrong one, and evidence', async () => {
    for (const c of FAULT_CASES) {
      const x = c.build(1);
      expect(x.id).toBe(c.id);
      expect(x.family).toBe(c.family);
      expect(new Set(x.options).size, c.id).toBe(4);
      expect(x.against, c.id).toHaveLength(3);
      expect(x.evidence.length, c.id).toBeGreaterThan(0);
      await tick();
    }
  });
  it('a case is the same from the same seed', () => {
    for (const c of FAULT_CASES) expect(JSON.stringify(c.build(3).evidence), c.id).toBe(JSON.stringify(c.build(3).evidence));
  });
});

describe('an attempt', () => {
  it('draws eight different cases, no family more than three times, and differs between attempts', () => {
    expect(PASS_MARK).toBe(7);
    const seen = new Set<string>();
    for (let s = 1; s <= 30; s++) {
      const a = attemptCases(s);
      expect(a).toHaveLength(ATTEMPT_CASES);
      expect(new Set(a.map((x) => x.id)).size).toBe(ATTEMPT_CASES);
      const fam = new Map<string, number>();
      for (const x of a) { const f = of(x.id).family; fam.set(f, (fam.get(f) ?? 0) + 1); }
      for (const n of fam.values()) expect(n).toBeLessThanOrEqual(3);
      seen.add(a.map((x) => x.id).join());
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});
