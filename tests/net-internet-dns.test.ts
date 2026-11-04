// Chapter 53's DNS bytes against vectors written out by hand from RFC 1035, the resolver's walk and cache, and the delay model against closed forms.

import { describe, expect, it } from 'vitest';
import { hostId, hostIp, Internet, LINKS, linkBetween, probeFrame, R } from '../src/net/internet';
import { CLASS_IN, decodeDns, encodeDns, Resolver, SITE, TTL_A, TYPE_A, TYPE_NS, type DnsMessage } from '../src/net/internetdns';
import { CROSS_BYTES, engineMs, fetchMs, fetchPhases, journeyDelays, MSS, responseMs, LinkQueue, oneWayMs, propMs, queueMs, serMs, slowStartRounds, WIRE_EXTRA } from '../src/net/internetdelay';
import { engineCycles } from '../src/widgets/router';
import { CLOCK_NS } from '../src/dram/timing';

const base: DnsMessage = { id: 0x1234, qr: false, aa: false, rd: true, ra: false, rcode: 0, qname: 'www.quillon.example', qtype: TYPE_A, answer: [], authority: [], additional: [] };
const name = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe('DNS bytes', () => {
  it('a query, written out by hand', () => {
    expect(encodeDns(base)).toEqual([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 3, ...name('www'), 7, ...name('quillon'), 7, ...name('example'), 0, 0, 1, 0, 1]);
    expect(CLASS_IN).toBe(1);
  });
  it('an answer: the name is a pointer to offset 12', () => {
    const b = encodeDns({ ...base, qr: true, ra: true, answer: [{ name: base.qname, type: TYPE_A, ttl: 300, data: 0x0a060250 }] });
    expect(b.slice(2, 4)).toEqual([0x81, 0x80]);
    expect(b.slice(6, 8)).toEqual([0, 1]);
    expect(b.slice(37)).toEqual([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 1, 0x2c, 0, 4, 10, 6, 2, 0x50]);
  });
  it('a referral: names share their tails', () => {
    const m: DnsMessage = { ...base, qr: true, authority: [{ name: 'example', type: TYPE_NS, ttl: 7, data: 'tld.example' }], additional: [{ name: 'tld.example', type: TYPE_A, ttl: 7, data: 0x0a000001 }] };
    const b = encodeDns(m);
    expect(decodeDns(b)).toEqual(m);
    // the whole of tld.example in the additional section is one pointer
    expect(b.length).toBeLessThan(90);
  });
  it('round trips, and a pointer loop is refused', () => {
    expect(decodeDns(encodeDns(base))).toEqual(base);
    const bad = [...encodeDns(base).slice(0, 12), 0xc0, 12, 0, 1, 0, 1];
    expect(() => decodeDns(bad)).toThrow(/loop/);
  });
});

describe('the resolver', () => {
  const net = new Internet(), laptop = hostId('laptop');
  it('goes root, .example, quillon.example, then answers: eight messages', () => {
    const r = new Resolver(net).resolve(laptop, SITE, 0);
    expect(r.answer).toBe(hostIp(hostId('www')));
    expect(r.lookups).toBe(3);
    expect(r.steps.length).toBe(8);
    expect(r.steps.map((s) => s.to)).toEqual([hostId('resolver'), hostId('root'), hostId('resolver'), hostId('tld'), hostId('resolver'), hostId('ns1'), hostId('resolver'), laptop]);
    for (const s of r.steps) expect(net.send(s.from, s.frame).end).toMatchObject({ kind: 'host', host: s.to });
  });
  it('the cache: the second time only the stub\'s two messages; past the A record\'s TTL one question, not three', () => {
    const c = new Resolver(net);
    const first = c.resolve(laptop, SITE, 0), again = c.resolve(laptop, SITE, 10), later = c.resolve(laptop, SITE, TTL_A + 1);
    expect(again.steps.length).toBe(2);
    expect(again.lookups).toBe(0);
    expect(again.ms).toBeLessThan(first.ms / 10);
    expect(later.lookups).toBe(1);
    expect(later.steps[1].to).toBe(hostId('ns1'));
  });
  it('a name that does not exist is a real answer, from the last server', () => {
    const r = new Resolver(net).resolve(laptop, 'nope.quillon.example', 0);
    expect(r.answer).toBeNull();
    expect(r.rcode).toBe(3);
    expect(r.lookups).toBe(3);
  });
});

describe('the delays', () => {
  const net = new Internet(), laptop = hostId('laptop'), www = hostIp(hostId('www'));
  const ocean = LINKS[linkBetween(R.t1, R.t2)];
  it('light: 6400 km at 200 000 km/s is 32 ms', () => { expect(propMs(ocean)).toBeCloseTo(32, 9); });
  it('bits: a 1500-byte frame on the 20 Mb/s line, with 24 bytes of wire, is 609.6 µs', () => {
    expect(serMs(LINKS[linkBetween(R.f1, R.f2)], 1500)).toBeCloseTo(0.6096, 9);
  });
  it('the engine is chapter 51\'s count', () => {
    expect(engineMs(60, 17)).toBeCloseTo(engineCycles(60, 17) * CLOCK_NS / 1e6, 12);
  });
  it('the queue: M/M/1 at half load waits one service time; the packet-level queue agrees', () => {
    const l = LINKS[linkBetween(R.f1, R.f2)], s = serMs(l, CROSS_BYTES - WIRE_EXTRA);
    expect(queueMs(l, 0.5)).toBeCloseTo(s, 9);
    expect(queueMs(l, 1)).toBe(Infinity);
    for (const load of [0.3, 0.5, 0.8]) {
      const q = new LinkQueue(load, s, 42);
      let sum = 0;
      const N = 400_000;
      for (let i = 0; i < N; i++) sum += q.next();
      expect(sum / N / queueMs(l, load)).toBeGreaterThan(0.93);
      expect(sum / N / queueMs(l, load)).toBeLessThan(1.07);
    }
  });
  it('the whole path adds up, and the ocean dominates', () => {
    const f = probeFrame(laptop, www, 64), j = net.send(laptop, f), d = journeyDelays(j, f.length);
    const prop = d.reduce((a, x) => a + x.prop, 0);
    expect(prop).toBeCloseTo((12 + 60 + 180 + 30 + 900 + 1100 + 5 + 6400 + 800 + 15 + 1 + 0.05) / 200, 6);
    expect(oneWayMs(j, f.length)).toBeGreaterThan(prop);
    expect(oneWayMs(j, f.length)).toBeLessThan(prop * 1.05);
  });
  it('a page: slow start and the phases', () => {
    expect(slowStartRounds(1)).toBe(1);
    expect(slowStartRounds(10)).toBe(1);
    expect(slowStartRounds(11)).toBe(2);
    expect(slowStartRounds(31)).toBe(3);
    const f = { dnsMs: 0, rttMs: 100, pageBytes: 1460, bottleneckMbps: 20, tls: false, thinkMs: 0 };
    expect(fetchPhases(f).length).toBe(3);
    expect(fetchMs(f)).toBeCloseTo(200 + ((1460 + 78) * 8) / 20000, 9);
  });
});

describe('the response', () => {
  /** Segment by segment through a FIFO at the bottleneck, window k arriving k round trips in: what responseMs must equal. */
  const fifo = (bytes: number, rtt: number, mbps: number): number => {
    const segs = Math.max(1, Math.ceil(bytes / MSS));
    let free = 0, k = 0, w = 10, n = 0, left = bytes;
    while (n < segs) {
      for (let i = 0; i < w && n < segs; i++, n++) {
        const pay = Math.min(left, MSS);
        left -= pay;
        free = Math.max(free, k * rtt) + ((pay + 78) * 8) / (mbps * 1000);
      }
      k++; w *= 2;
    }
    return free;
  };
  it('equals a packet-by-packet queue at every size, so no bit is counted twice', () => {
    for (const kb of [1, 14, 15, 44, 100, 167, 500, 2000]) for (const [rtt, mbps] of [[95.39, 14], [10, 1000], [300, 2]])
      expect(responseMs(kb * 1000, rtt, mbps)).toBeCloseTo(fifo(kb * 1000, rtt, mbps), 6);
  });
  it('is round trips for a small page and the link for a large one', () => {
    const rtt = 95.39, mbps = 14;
    expect(responseMs(100_000, rtt, mbps)).toBeLessThan(226);
    expect(responseMs(100_000, rtt, mbps)).toBeGreaterThan(2 * rtt);
    expect(responseMs(2_000_000, rtt, mbps)).toBeCloseTo(1454, -1);
    expect(responseMs(2_000_000, rtt, mbps)).toBeLessThan(2 * ((2_000_000 + 1370 * 78) * 8) / (mbps * 1000));
  });
});
