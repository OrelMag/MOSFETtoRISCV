// Inside the data centre: its models against their closed forms.
import { describe, expect, it } from 'vitest';
import { arqRun, ecmpAssign, ecmpCarried, ecmpExpected, ecmpNoCollision, fanoutHalf, fanoutSlow, fatTree, gbnGoodput, incast, oversubscription, pfcHeadroom, pfcRun, ringRun, srGoodput } from '../src/comm/dc';
import { bottleneck, dctcpAlpha, dctcpAmplitude } from '../src/comm/queues';

const near = (a: number, b: number, frac: number, msg?: string) => { expect(Math.abs(a - b) / Math.max(Math.abs(b), 1e-12), `${msg ?? ''} ${a} against ${b}`).toBeLessThan(frac); };

describe('the fabric', () => {
  it('a k-ary fat tree has k³ / 4 hosts, 5k² / 4 switches, and (k / 2)² paths between pods', () => {
    const f = fatTree(48);
    expect(f.hosts).toBe(27648);
    expect(f.switches).toBe(2880);
    expect(f.core).toBe(576);
    expect(fatTree(4)).toMatchObject({ hosts: 16, switches: 20, core: 4 });
  });
  it('every switch uses exactly its k ports', () => {
    for (const k of [4, 8, 48]) { const f = fatTree(k); expect(f.hosts + 2 * (f.links - f.hosts)).toBe(f.switches * k); }
  });
  it('oversubscription', () => { expect(oversubscription(40, 25, 8, 100)).toBeCloseTo(1.25, 12); expect(oversubscription(32, 25, 8, 100)).toBe(1); });
});

describe('ECMP', () => {
  it('leaves what balls in bins say: 1 − 1 / e of the fabric with as many flows as paths', () => {
    const m = 64;
    let sum = 0;
    for (let s = 0; s < 400; s++) sum += ecmpCarried(ecmpAssign(m, m, s + 1)) / m;
    near(sum / 400, ecmpExpected(m, m), 0.02);
    near(ecmpExpected(1000, 1000), 1 - 1 / Math.E, 0.001);
  });
  it('collisions: the birthday problem', () => {
    expect(ecmpNoCollision(2, 2)).toBeCloseTo(0.5, 12);
    expect(ecmpNoCollision(5, 4)).toBe(0);
    let hit = 0;
    for (let s = 0; s < 4000; s++) if (Math.max(...ecmpAssign(8, 64, s + 1)) <= 1) hit++;
    near(hit / 4000, ecmpNoCollision(8, 64), 0.08);
  });
});

describe('incast', () => {
  const read = (senders: number, rtoMs = 200, bufferPkts = 32) => incast({ senders, blockBytes: 256 * 1024, bufferPkts, rtoMs });
  it('few senders: slow start may overflow it, and fast retransmit mends that with no timeout', () => {
    const r = read(2);
    expect(r.timeouts).toBe(0);
    expect(r.share).toBeGreaterThan(0.7);
  });
  it('many senders, a 200 ms timer: a timeout dominates the read, and the goodput falls by an order of magnitude', () => {
    const r = read(40);
    expect(r.timeouts).toBeGreaterThan(0);
    expect(r.ms).toBeGreaterThan(200);
    expect(r.share).toBeLessThan(0.45);
  });
  it('a 1 ms timer brings most of it back; so does a larger buffer', () => {
    const slow = read(40), fast = read(40, 1), deep = read(40, 200, 2000);
    expect(fast.share).toBeGreaterThan(2 * slow.share);
    expect(deep.share).toBeGreaterThan(0.8);
  });
  it('the time is the sum: N blocks at the link\'s rate when nothing is lost', () => {
    const r = incast({ senders: 4, blockBytes: 150000, bufferPkts: 500, rtoMs: 200 });
    near(r.ms, (4 * 150000 * 8) / 1e9 * 1000, 0.05);
  });
});

describe('losing a packet at a high rate', () => {
  it('go-back-N and selective repeat keep their closed forms', () => {
    for (const [p, W] of [[1e-3, 100], [1e-2, 50], [1e-4, 1000]] as const) {
      near(arqRun(p, W, 'gbn', 300000, 3), gbnGoodput(p, W), 0.03, `gbn p ${p} W ${W}`);
      near(arqRun(p, W, 'sr', 300000, 4), srGoodput(p), 0.01, `sr p ${p}`);
    }
  });
  it('a pipe of a thousand packets halves at one loss in a thousand', () => { near(gbnGoodput(1e-3, 1000), 0.5, 0.01); });
});

describe('priority flow control', () => {
  const base = { r1: 0.25, buffer: 64, oneWay: 8, slots: 40000 };
  it('lossy: the slow port drops its overflow, the other goes through', () => {
    const r = pfcRun({ ...base, lossless: false, headroom: 18 });
    expect(r.drops).toBeGreaterThan(1000);
    near(r.f1, 0.25, 0.03);
    near(r.f2, 0.5, 0.03);
  });
  it('lossless: nothing dropped, and the fast flow is held to the slow flow\'s rate', () => {
    const r = pfcRun({ ...base, lossless: true, headroom: pfcHeadroom(base.oneWay) });
    expect(r.drops).toBe(0);
    near(r.f1, 0.25, 0.03);
    near(r.f2, 0.25, 0.1, 'victim');
    expect(r.pausedShare).toBeGreaterThan(0.3);
  });
  it('the headroom is what the round trip of the pause needs: less loses packets', () => {
    expect(pfcHeadroom(8)).toBe(18);
    const all = { ...base, lossless: true, oneFlow: true };
    expect(pfcRun({ ...all, headroom: pfcHeadroom(8) }).drops).toBe(0);
    expect(pfcRun({ ...all, headroom: 6 }).drops).toBeGreaterThan(0);
    expect(pfcRun({ ...all, headroom: pfcHeadroom(8) }).maxHeld).toBeLessThanOrEqual(base.buffer);
  });
});

describe('deadlock', () => {
  it('two hops around a ring stops for ever, one hop never does', () => {
    const two = ringRun(4, 2, 4, 20000), one = ringRun(4, 1, 4, 20000);
    expect(two.stoppedAt).not.toBeNull();
    expect(one.stoppedAt).toBeNull();
    expect(one.delivered.reduce((a, b) => a + b, 0)).toBeGreaterThan(50000);
  });
  it('light traffic only postpones it', () => {
    const r = ringRun(4, 3, 4, 2000000, 0.5);
    expect(r.stoppedAt).not.toBeNull();
    expect(r.stoppedAt!).toBeGreaterThan(0);
  });
});

describe('the tail at scale', () => {
  it('one server in a hundred slow, a hundred servers: 63 %', () => {
    near(fanoutSlow(100, 0.01), 1 - 0.99 ** 100, 1e-12);
    expect(fanoutSlow(100, 0.01)).toBeGreaterThan(0.63);
    near(fanoutSlow(fanoutHalf(0.01), 0.01), 0.5, 1e-9);
  });
});

describe('DCTCP', () => {
  const pk = (gbps: number) => (1500 * 8) / (gbps * 1e9) * 1e3;
  const run = (cc: 'dctcp' | 'reno', K: number) => bottleneck({ mbps: 10000, bufferPkts: 400, aqm: 'step', markK: K }, [{ cc, rttMs: 0.1, ecn: true }], 1.5, 0.5);
  it('runs near K, with the link full, on a queue far shorter than Reno needs', () => {
    const W = 0.1 / pk(10); // the pipe in packets
    const K = Math.ceil(W / 7) + 2, d = run('dctcp', K), r = run('reno', K);
    expect(d.utilization).toBeGreaterThan(0.97);
    expect(d.maxQueue).toBeLessThan(K + 10);
    expect(r.utilization).toBeLessThan(d.utilization);
  });
  it('α and the swing keep the paper\'s closed forms', () => {
    const W = 0.1 / pk(10), K = 40, star = W + K, d = run('dctcp', K);
    near(dctcpAlpha(star), Math.sqrt(2 / star), 1e-12);
    near(d.dctcpAlpha!, dctcpAlpha(star), 0.25, 'alpha');
    // the swing is at least the cut; marks take a round trip to act, so the window overshoots by a little more
    const swing = d.maxQueue - d.minQueue!, A = dctcpAmplitude(star);
    expect(swing).toBeGreaterThan(0.8 * A); expect(swing).toBeLessThan(2 * A);
    expect(dctcpAmplitude(star)).toBeLessThan(K);
  });
});
