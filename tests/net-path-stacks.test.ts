// The Internet path's HTTP/1.1, HTTP/2 and HTTP/3 comparison: what the step's sentences lean on, from the model that draws it.

import { describe, expect, it } from 'vitest';
import { pageOver, responseMs, THINK_MS } from '../src/net/internetdelay';

const NET = { rttMs: 40, bottleneckMbps: 20 };
const page = (objects: number, kb: number, loss = false) => ({ ...NET, objects, objectBytes: kb * 1000, loss });

describe('three ways to carry a page', () => {
  it('one object on TCP + TLS is the single-object model: two round trips, a request, the response', () => {
    for (const kb of [1, 30, 100, 2000]) {
      const want = 2 * NET.rttMs + NET.rttMs + THINK_MS + responseMs(kb * 1000, NET.rttMs, NET.bottleneckMbps);
      expect(pageOver('h1', page(1, kb)).totalMs).toBeCloseTo(want, 9);
      expect(pageOver('h2', page(1, kb)).totalMs).toBeCloseTo(want, 9);
    }
  });
  it('QUIC starts one round trip sooner, and with no loss is otherwise HTTP/2', () => {
    const b = pageOver('h2', page(8, 30)), c = pageOver('h3', page(8, 30));
    expect(b.setupMs - c.setupMs).toBe(NET.rttMs);
    expect(b.totalMs - c.totalMs).toBeCloseTo(NET.rttMs, 9);
  });
  it('more objects: asking one at a time costs round trips that interleaving does not', () => {
    const a = pageOver('h1', page(8, 30)), b = pageOver('h2', page(8, 30));
    expect(a.totalMs).toBeGreaterThan(b.totalMs + 3 * NET.rttMs);
    expect(a.doneMs.every((d, i) => i === 0 || d > a.doneMs[i - 1])).toBe(true);
  });
  it('no loss: nothing is held up', () => {
    for (const k of ['h1', 'h2', 'h3'] as const) expect(pageOver(k, page(8, 30)).stalled).toBe(0);
  });
  it('a loss: TCP holds up what follows it on the connection, QUIC only that stream', () => {
    const b = pageOver('h2', page(8, 30, true)), c = pageOver('h3', page(8, 30, true)), clean = pageOver('h2', page(8, 30));
    expect(c.stalled).toBe(1);
    expect(b.stalled).toBe(8);
    expect(b.heldPackets).toBeGreaterThan(5 * c.heldPackets);
    expect(b.doneMs.every((d, i) => d >= clean.doneMs[i] - 1e-9)).toBe(true);
    // The retransmission takes one round trip more, so nothing is late by more than that.
    expect(b.totalMs).toBeLessThanOrEqual(clean.totalMs + NET.rttMs + 1e-9);
  });
  it('HTTP/1.1: the object with the lost packet and all after it are late', () => {
    const a = pageOver('h1', page(8, 30, true));
    expect(a.stalled).toBe(4);
  });
});
