// The expert's bench: each case really has its fault in it. The symptom must come with the fault and go without it, on the book's own models,
// for several seeds; otherwise a case would be teaching a story and not a diagnosis.

import { describe, expect, it } from 'vitest';
import { ATTEMPT_CASES, attemptCases, FAULT_CASES, PASS_MARK } from '../src/comm/faults';
import { RADIO_BUDGET_STEP, SHOWN_FAILS, SHOWN_SURVIVES, UART_ERR, WIFI_HIDDEN_STEP } from '../src/chapters/ch-comm-bench';
import { chRadio } from '../src/chapters/ch-comm-radio';
import { chWifi } from '../src/chapters/ch-comm-wifi';
import { emptyCampaign, sanitizeCampaign } from '../src/campaign/progress';
import { COMM_CAPSTONES } from '../src/learn/capstones';
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
  it('clock error: some characters wrong, some intact, as the report says; none wrong at 1 %', () => each('uart_clock', (a, b) => {
    expect(a.wrong).toBeGreaterThan(0);
    expect(a.wrong).toBeLessThan(a.chars);
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
  it('a failed link: the trace stops with no route, part way, and another network still gets through; all reach it without', () => each('route_down', (a, b) => {
    expect(a.noroute).toBe(1);
    expect(a.reached).toBe(0);
    expect(a.otherReached).toBe(1);
    expect(b.reached).toBe(1);
    expect(b.otherReached).toBe(1);
  }));
});

describe('the radio cases', () => {
  it('a new wall between two laptops: the budget stops them hearing each other, frames overlap at the access point; none of it without the wall', () => each('wifi_hidden', (a, b) => {
    expect(a.hears).toBe(0);
    expect(b.hears).toBe(1);
    expect(a.snr).toBeGreaterThan(23); // the report's retries are not a weak signal
    expect(a.overlap).toBeGreaterThan(5 * b.overlap);
    expect(a.delivered).toBeLessThan(0.6 * b.delivered);
    expect(a.tries).toBeGreaterThan(1.5 * a.delivered);
    expect(a.before).toBe(b.delivered);
  }));
  it('a link budget short by a wall: the SNR falls below the top rate, rate adaptation falls with it; all well without', () => each('link_wall', (a, b) => {
    expect(a.shortfall).toBeGreaterThan(10);
    expect(b.shortfall).toBeLessThan(a.shortfall - 15);
    expect(a.mbps).toBeLessThan(0.5 * b.mbps);
    expect(a.lost / a.frames).toBeGreaterThan(b.lost / b.frames);
    expect(a.was).toBe(b.mbps);
  }));
});

describe('the chapter\'s typed claims', () => {
  it('at the quiz\'s clock error U fails and the other character survives, in the model', () => {
    expect(receive(UART_8N1, SHOWN_FAILS, { err: UART_ERR }).word).not.toBe(SHOWN_FAILS);
    expect(receive(UART_8N1, SHOWN_SURVIVES, { err: UART_ERR }).word).toBe(SHOWN_SURVIVES);
  });
});

describe('the capstones\' records', () => {
  it('a pass survives the reload: the sanitizer keeps these ids', () => {
    for (const c of COMM_CAPSTONES) {
      const st = emptyCampaign();
      st.nodes[c.id] = { status: 'solved', at: 1 };
      expect(sanitizeCampaign(JSON.parse(JSON.stringify(st))).nodes[c.id]?.status, c.id).toBe('solved');
    }
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
  it('the wording does not give the answer: the right cause is no longer than the others, and reports repeat across causes', () => {
    for (const c of FAULT_CASES) {
      const x = c.build(1), others = x.options.slice(1).map((o) => o.length);
      expect(x.options[0].length, c.id).toBeLessThanOrEqual(1.25 * Math.max(...others));
    }
    const reports = (fam: string) => new Set(FAULT_CASES.filter((c) => c.family === fam).map((c) => c.build(1).symptom)).size;
    for (const fam of ['tcp', 'line', 'routing', 'radio']) expect(reports(fam), fam).toBe(1);
  });
  it('every case but the fixed ones changes with its seed', () => {
    for (const c of FAULT_CASES) expect(JSON.stringify(c.build(1).evidence) === JSON.stringify(c.build(2).evidence) && JSON.stringify(c.build(1).evidence) === JSON.stringify(c.build(3).evidence), c.id).toBe(false);
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
