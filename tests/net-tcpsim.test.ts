// The explorers' simulator: what chapter 52's text says about it, measured.

import { describe, expect, it } from 'vitest';
import { ACK, CLOSED, SYN, TCP_K } from '../src/net/tcp';
import { queueDelay, runTcp } from '../src/net/tcpsim';

const stream = (n: number) => Array.from({ length: n }, (_, i) => (i + (i >> 8) * 7) & 255);

describe('the simulator', () => {
  it('the handshake alone', () => {
    const r = runTcp({ bytes: 0 });
    expect(r.segs.map((s) => [s.from, s.seg.flags])).toEqual([['a', SYN], ['b', SYN | ACK], ['a', ACK]]);
    expect(r.segs.every((s) => s.fate === 'ok' || s.fate === 'flight')).toBe(true);
  });
  it('dropping any one of the first segments still delivers every byte', () => {
    const n = runTcp({ bytes: 500 }).segs.length;
    for (let k = 0; k < n; k++) {
      const r = runTcp({ bytes: 500, lost: new Set([k]) });
      expect(r.got, `segment ${k}`).toEqual(stream(500));
      expect(r.segs[k].fate).toBe('lost');
    }
  });
  it('the same inputs give the same run', () => {
    const o = { bytes: 3000, byteClocks: 200, queue: 4, delay: 20000 };
    expect(runTcp(o).trace).toEqual(runTcp(o).trace);
  });
  it('a queue too short for the window: a sawtooth, halving on duplicate ACKs', () => {
    const r = runTcp({ bytes: 30000, byteClocks: 200, queue: 4, delay: 20000 });
    expect(r.got.length).toBe(30000);
    expect(r.drops).toBeGreaterThan(3);
    expect(r.fast).toBeGreaterThan(3);
    const cuts = r.events.filter((e) => e.why === 'fast');
    for (const e of cuts) expect(e.cwnd).toBe(e.ssthresh);
  });
  it('a queue of three holds too few for three duplicate ACKs: the timer has to do it, and it is slower', () => {
    const small = runTcp({ bytes: 8000, byteClocks: 400, queue: 2, delay: 10000 }), big = runTcp({ bytes: 8000, byteClocks: 400, queue: 6, delay: 10000 });
    expect(small.timeouts).toBeGreaterThan(big.timeouts);
    expect(small.doneAt).toBeGreaterThan(big.doneAt);
  });
  it('a longer queue: fewer drops and a longer round trip, and past the receive window of 8 segments no change at all', () => {
    const q = [2, 4, 8, 16].map((queue) => runTcp({ bytes: 20000, byteClocks: 200, queue, delay: 20000 }));
    const rtt = q.map((r) => r.rtts[r.rtts.length - 1]);
    expect(rtt[2]).toBeGreaterThan(rtt[1]);
    expect(rtt[1]).toBeGreaterThan(rtt[0]);
    expect(q[0].drops).toBeGreaterThan(q[1].drops);
    expect(q[2].drops).toBe(0);
    expect(q[3].doneAt).toBe(q[2].doneAt);
    expect(queueDelay(10, 200)).toBe(10 * 118 * 200);
  });
  it('a receiver that reads slowly stops the sender, with no loss', () => {
    const r = runTcp({ bytes: 1500, readEvery: 200_000, readBytes: 128 });
    expect(r.got).toEqual(stream(1500));
    expect(r.drops + r.losses + r.timeouts + r.fast).toBe(0);
    expect(Math.min(...r.trace.slice(5).map((p) => p.sndWnd))).toBeLessThan(TCP_K.MSS);
    expect(Math.max(...r.trace.map((p) => p.held))).toBeLessThanOrEqual(TCP_K.RCV);
  });
  it('a window update does not leave the wait for it timing the data sent next', () => {
    for (const readEvery of [40_000, 60_000, 80_000, 120_000, 200_000, 400_000]) {
      const r = runTcp({ bytes: 1500, readEvery, readBytes: 128 });
      expect(r.got, `read every ${readEvery}`).toEqual(stream(1500));
      expect(r.timeouts, `read every ${readEvery}`).toBe(0);
      expect(r.retrans - r.probes, `read every ${readEvery}`).toBeLessThanOrEqual(r.probes);
    }
  });
  it('a frame is 118 bytes: data through the link never beats the ceiling the widget quotes', () => {
    for (const byteClocks of [32, 200, 400]) {
      const r = runTcp({ bytes: 8000, byteClocks, queue: 8, delay: 2000 });
      expect(8000 / r.doneAt).toBeLessThanOrEqual(64 / (118 * byteClocks) + 1e-9);
    }
  });
  it('random losses: the data still arrives, later', () => {
    const clean = runTcp({ bytes: 6000 }), lossy = runTcp({ bytes: 6000, lossPct: 5, seed: 3 });
    expect(lossy.got).toEqual(stream(6000));
    expect(lossy.losses).toBeGreaterThan(0);
    expect(lossy.doneAt).toBeGreaterThan(clean.doneAt);
  });
  it('a close ends in the expected states', () => {
    const r = runTcp({ bytes: 200, close: true });
    expect(r.got.length).toBe(200);
    expect(r.endState.a).not.toBe(CLOSED - 1);
  });
});
