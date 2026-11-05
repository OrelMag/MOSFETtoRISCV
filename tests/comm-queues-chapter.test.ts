// Queues and congestion on the page: what the text claims against the model it quotes, and the chapter's place in the book.
import { describe, expect, it } from 'vitest';
import { chQueues } from '../src/chapters/ch-comm-queues';
import { numOf } from '../src/chapters/order';
import { duelRun, labRun } from '../src/widgets/queues';

describe('the chapter', () => {
  it('follows TCP, is a labelled model, every step has a widget and a check', () => {
    expect(numOf('queues')).toBe(numOf('tcp') + 1);
    expect(chQueues.steps.length).toBeLessThan(15);
    for (const s of chQueues.steps) { expect(s.body.length, s.title).toBeGreaterThan(200); expect(!!s.widget, s.title).toBe(true); expect(!!s.challenge, s.title).toBe(true); }
    expect(chQueues.steps[1].body).toMatch(/labelled model/);
  });
});

describe('what the text says', () => {
  const cubic = { cc: 'cubic' as const, rttMs: 50 };
  it('bufferbloat: the big buffer buys no throughput and half a second of delay', () => {
    const big = labRun({ aqm: 'tail', buffer: 1000, rtt: 50, flows: [cubic] }), small = labRun({ aqm: 'tail', buffer: 90, rtt: 50, flows: [cubic] });
    expect(big.pingMeanMs).toBeGreaterThan(300);
    expect(small.pingMeanMs).toBeLessThan(big.pingMeanMs / 4);
    expect(big.utilization - small.utilization).toBeLessThan(0.05);
  });
  it('the disciplines order as the text orders them', () => {
    const d = (aqm: 'tail' | 'red' | 'codel' | 'fq') => labRun({ aqm, buffer: 1000, rtt: 50, flows: [cubic] });
    const t = d('tail'), r = d('red'), c = d('codel'), f = d('fq');
    expect(r.pingMeanMs).toBeLessThan(t.pingMeanMs / 2);
    expect(c.pingMeanMs).toBeLessThan(r.pingMeanMs / 2);
    expect(f.pingMeanMs).toBeLessThanOrEqual(c.pingMeanMs);
  });
  it('the Try box: BBR on a tail-drop queue alone gets 18 Mb/s under 50 ms of delay, CUBIC cannot', () => {
    const b = labRun({ aqm: 'tail', buffer: 1000, rtt: 50, flows: [{ cc: 'bbr', rttMs: 50 }] });
    expect(b.goodputMbps[0]).toBeGreaterThan(18);
    expect(b.pingMeanMs).toBeLessThan(50);
  });
  it('the duel: shallow to BBR, deep more even, a queue per flow equal', () => {
    const s = duelRun(40), d = duelRun(320), f = duelRun(40, 'fq');
    expect(s.goodputMbps[0]).toBeGreaterThan(5 * s.goodputMbps[1]);
    expect(d.goodputMbps[0] / d.goodputMbps[1]).toBeLessThan(3);
    expect(f.jain).toBeGreaterThan(0.99);
  });
});
