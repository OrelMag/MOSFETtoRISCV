// Inside the data centre on the page: its place in the book and what its quizzes and text claim.
import { describe, expect, it } from 'vitest';
import { chDatacentre } from '../src/chapters/ch-comm-dc';
import { numOf } from '../src/chapters/order';
import { fanoutSlow, gbnGoodput, incast, pfcHeadroom } from '../src/comm/dc';
import { dctcpMinK } from '../src/comm/queues';

describe('the chapter', () => {
  it('comes after the internet path, says it is a model, every step has a widget and a check', () => {
    expect(numOf('datacentre')).toBeGreaterThan(numOf('path'));
    expect(chDatacentre.steps.length).toBeLessThan(15);
    expect(chDatacentre.steps[0].body).toMatch(/labelled model/);
    for (const s of chDatacentre.steps) { expect(!!s.widget, s.title).toBe(true); expect(!!s.challenge, s.title).toBe(true); }
  });
});

describe('what the text says', () => {
  const read = (senders: number, rtoMs = 200, bufferPkts = 32) => incast({ senders, blockBytes: 256 * 1024, bufferPkts, rtoMs });
  it('adding servers makes the read slower, in time and not only in rate per server', () => {
    expect(read(40).ms).toBeGreaterThan(read(2).ms * 3);
    expect(read(40).goodputGbps).toBeLessThan(read(2).goodputGbps / 4);
  });
  it('a 1 ms timer rescues a queue shorter than it; on a queue longer than it, it fires for nothing', () => {
    expect(read(40, 1).share).toBeGreaterThan(0.9);
    const deep = read(40, 1, 512), deepSlow = read(40, 200, 512);
    expect(deep.timeouts).toBeGreaterThan(100);
    expect(deep.share).toBeLessThan(deepSlow.share);
  });
  it('the quizzes\' arithmetic', () => {
    expect(gbnGoodput(1e-3, 1000)).toBeCloseTo(0.5, 2);
    expect(pfcHeadroom(12.5)).toBe(27);
    expect(fanoutSlow(50, 0.0002)).toBeCloseTo(0.01, 3);
    expect(fanoutSlow(50, 0.01)).toBeGreaterThan(0.39);
    expect(fanoutSlow(50, 1 / 50)).toBeCloseTo(0.636, 2);
    expect(dctcpMinK(83)).toBeCloseTo(11.9, 1);
  });
});
