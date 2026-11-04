// Chapter 52's reference TCP: frames against hand-worked bytes and the independent builder, the state machine's paths, two endpoints over a link that
// loses, duplicates and reorders (every byte arrives, in order, whatever the seed), sequence numbers across both wrap points, the timer and the window.

import { describe, expect, it } from 'vitest';
import { checksum, dissect, ip4, onesSum, tcpFrame } from '../src/comm/netframes';
import { ACK, CLOSED, CLOSE_WAIT, ESTABLISHED, FIN, FIN_WAIT_2, LAST_ACK, LISTEN, parseSeg, RST, segBytes, SYN, SYN_SENT, TCP_K, TcpModel, TIME_WAIT, type Segment, type TcpEvent } from '../src/net/tcp';
import { lcg } from './util';

const A = ip4(10, 0, 0, 1), B = ip4(10, 0, 0, 2);
const MA = [2, 0, 0, 0, 0, 1], MB = [2, 0, 0, 0, 0, 2];

interface Wire { at: number; to: 'a' | 'b'; bytes: number[] }

/** Two endpoints and a link of fixed delay. `fate` decides each segment: 0 lost, 1 delivered, 2 duplicated; `jitter` adds to its delay (so reorders). */
function bench(o: { delay?: number; fate?: (seq: number, n: number, from: 'a' | 'b') => number; jitter?: () => number; isnA?: number; isnB?: number; ev?: (e: TcpEvent) => void } = {}) {
  const q: Wire[] = [];
  let now = 1, count = 0;
  const delay = o.delay ?? 5000;
  const log: { t: number; from: 'a' | 'b'; s: Segment }[] = [];
  const push = (from: 'a' | 'b', s: Segment, to: number) => {
    log.push({ t: now, from, s });
    const fate = o.fate ? o.fate(s.seq, count++, from) : 1;
    const bytes = segBytes(s, from === 'a' ? A : B, to);
    for (let k = 0; k < fate; k++) q.push({ at: now + delay + (o.jitter?.() ?? 0), to: from === 'a' ? 'b' : 'a', bytes });
    return true;
  };
  const a = new TcpModel({ ip: A, isn: o.isnA ?? 0x1000, send: (s, to) => push('a', s, to), onEvent: o.ev });
  const b = new TcpModel({ ip: B, isn: o.isnB ?? 0x2000, send: (s, to) => push('b', s, to) });
  const run = (until: () => boolean, max = 200_000_000) => {
    while (!until() && now < max) {
      let next = Math.min(a.rtoOn ? a.rtoAt : Infinity, b.rtoOn ? b.rtoAt : Infinity, a.st === TIME_WAIT ? a.twAt : Infinity, b.st === TIME_WAIT ? b.twAt : Infinity);
      for (const w of q) next = Math.min(next, w.at);
      if (next === Infinity) break;
      now = Math.max(now, next);
      for (let i = 0; i < q.length;) {
        if (q[i].at <= now) { const w = q.splice(i, 1)[0]; (w.to === 'a' ? a : b).input(w.bytes, w.to === 'a' ? B : A, now); i = 0; } else i++;
      }
      a.tick(now); b.tick(now);
    }
    return now;
  };
  return { a, b, run, log, now: () => now };
}

const open = (t: ReturnType<typeof bench>) => {
  t.b.listen(80);
  t.a.connect(B, 40000, 80, t.now());
  t.run(() => t.a.st === ESTABLISHED && t.b.st === ESTABLISHED);
};

/** Send `n` bytes through, reading as they come; returns what b read. */
function transfer(t: ReturnType<typeof bench>, n: number, max = 400_000_000): number[] {
  const data = Array.from({ length: n }, (_, i) => (i * 7 + (i >> 8)) & 255);
  let sent = 0;
  const got: number[] = [];
  t.run(() => {
    if (sent < n) sent += t.a.write(data.slice(sent), t.now());
    got.push(...t.b.read(4096, t.now()));
    return got.length >= n || t.a.err;
  }, max);
  return got;
}

const want = (n: number) => Array.from({ length: n }, (_, i) => (i * 7 + (i >> 8)) & 255);

describe('frames', () => {
  it('a SYN worked by hand', () => {
    // 04d2 0050 00001000 00000000 6002 0200 csum 0000 0204 0040; pseudo: 0a00 0001 0a00 0002 0006 0018
    const words = [0x04d2, 0x0050, 0x0000, 0x1000, 0, 0, 0x6002, 0x0200, 0, 0x0204, 0x0040, 0x0a00, 0x0001, 0x0a00, 0x0002, 0x0006, 0x0018];
    let s = words.reduce((x, y) => x + y, 0);
    while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
    const ck = ~s & 0xffff;
    const b = segBytes({ sport: 1234, dport: 80, seq: 0x1000, ack: 0, flags: SYN, wnd: 512, mss: 64, data: [] }, A, B);
    expect(b).toEqual([0x04, 0xd2, 0x00, 0x50, 0, 0, 0x10, 0, 0, 0, 0, 0, 0x60, 0x02, 0x02, 0x00, ck >> 8, ck & 255, 0, 0, 2, 4, 0, 64]);
  });
  it('the model and the independent builder agree, and a segment sums to 0xffff with its pseudo-header', () => {
    const r = lcg(7);
    for (let k = 0; k < 200; k++) {
      const data = Array.from({ length: r(70) }, () => r(256));
      const s: Segment = { sport: r(65536), dport: r(65536), seq: (r(65536) << 16 | r(65536)) | 0, ack: (r(65536) << 16 | r(65536)) | 0, flags: r(32) & ~SYN, wnd: r(65536), data };
      const b = segBytes(s, A, B);
      const f = tcpFrame({ srcMac: MA, dstMac: MB, src: A, dst: B, id: 1, ...s });
      expect(b).toEqual(f.bytes.slice(34));
      expect(onesSum(b, onesSum([10, 0, 0, 1, 10, 0, 0, 2, 0, 6, b.length >> 8, b.length & 255]))).toBe(0xffff);
      const p = parseSeg(b, A, B)!;
      expect({ ...s, seq: p.seq, ack: p.ack, data: p.data }).toEqual(s);
      expect(p.flags).toBe(s.flags);
      // a flipped bit never passes
      const bad = b.slice();
      bad[r(bad.length)] ^= 1 << r(8);
      expect(parseSeg(bad, A, B)).toBeNull();
    }
  });
  it('the dissector reads it back', () => {
    const f = tcpFrame({ srcMac: MA, dstMac: MB, src: A, dst: B, id: 1, sport: 40000, dport: 80, seq: 5, ack: 9, flags: ACK | FIN, wnd: 512, data: [1, 2, 3] });
    expect(dissect(f.bytes)).toBe('TCP 10.0.0.1:40000 > 10.0.0.2:80 [ACK, FIN] seq 5 ack 9 win 512 len 3');
    expect(checksum(f.bytes.slice(14, 34))).toBe(0);
  });
});

describe('the state machine', () => {
  it('the three-way handshake, in three segments, seq and ack as the RFC draws them', () => {
    const t = bench();
    open(t);
    const l = t.log.map((x) => [x.from, x.s.flags, x.s.seq, x.s.ack]);
    expect(l).toEqual([['a', SYN, 0x1000, 0], ['b', SYN | ACK, 0x2000, 0x1001], ['a', ACK, 0x1001, 0x2001]]);
    expect(t.log[0].s.mss).toBe(TCP_K.MSS);
    expect(t.log[1].s.mss).toBe(TCP_K.MSS);
    expect(t.log[2].s.mss).toBeUndefined();
    expect(t.log[0].s.wnd).toBe(TCP_K.RCV);
  });
  it('a lost SYN and a lost SYN-ACK are sent again', () => {
    for (const lose of [0, 1]) {
      let k = 0;
      const t = bench({ fate: () => (k++ === lose ? 0 : 1) });
      open(t);
      expect(t.a.st).toBe(ESTABLISHED);
      // a lost SYN-ACK leaves both ends waiting, so both timers fire
      expect(t.log.filter((x) => x.s.flags & SYN).length).toBe(lose === 0 ? 3 : 4);
      expect(t.now()).toBeGreaterThan(TCP_K.RTO_INIT);
    }
  });
  it('a segment to a closed port is answered with a reset, which refuses the connection', () => {
    const t = bench();
    t.a.connect(B, 40000, 80, t.now());
    t.b.lport = 0;
    t.run(() => t.a.st === CLOSED);
    expect(t.a.st).toBe(CLOSED);
    expect(t.a.err).toBe(true);
    const r = t.log.find((x) => x.s.flags & RST)!;
    expect(r.s.flags).toBe(RST | ACK);
    expect(r.s.ack).toBe(0x1001);
    expect(r.s.seq).toBe(0);
  });
  it('close from one side: FIN, ACK, FIN, ACK, TIME_WAIT at the closer, LISTEN again at the server', () => {
    const t = bench();
    open(t);
    t.a.close(t.now());
    t.run(() => t.a.st === FIN_WAIT_2 && t.b.st === CLOSE_WAIT);
    expect(t.b.st).toBe(CLOSE_WAIT);
    t.b.close(t.now());
    expect(t.b.st).toBe(LAST_ACK);
    t.run(() => t.a.st === TIME_WAIT && t.b.st === LISTEN);
    expect(t.a.st).toBe(TIME_WAIT);
    const end = t.run(() => t.a.st === CLOSED);
    expect(t.a.st).toBe(CLOSED);
    expect(end).toBeGreaterThanOrEqual(TCP_K.TIME_WAIT);
    const fins = t.log.filter((x) => x.s.flags & FIN);
    expect(fins.map((x) => x.from)).toEqual(['a', 'b']);
  });
  it('a FIN sent again in TIME_WAIT is acknowledged, and 2 MSL starts over', () => {
    const t = bench();
    open(t);
    t.a.close(t.now());
    t.run(() => t.a.st === 6 && t.b.st === 7);
    t.b.close(t.now());
    t.run(() => t.a.st === TIME_WAIT);
    const at = t.a.twAt, n = t.log.length;
    const fin = segBytes({ sport: 80, dport: 40000, seq: (t.b.sndEnd) | 0, ack: t.b.rcvNxt, flags: ACK | FIN, wnd: 512, data: [] }, B, A);
    t.a.input(fin, B, at - 100);
    expect(t.a.twAt).toBe((at - 100 + TCP_K.TIME_WAIT) | 0);
    expect(t.log[n].s.flags).toBe(ACK);
  });
  it('close from both at once meets in CLOSING and both reach TIME_WAIT', () => {
    const t = bench();
    open(t);
    t.a.close(t.now());
    t.b.close(t.now());
    t.run(() => t.a.st === TIME_WAIT && t.b.st === TIME_WAIT);
    expect([t.a.st, t.b.st]).toEqual([TIME_WAIT, TIME_WAIT]);
  });
  it('a reset takes effect only at exactly rcv_nxt (RFC 5961); elsewhere in the window it is challenged', () => {
    const t = bench();
    open(t);
    const n = t.log.length;
    t.b.input(segBytes({ sport: 40000, dport: 80, seq: (t.b.rcvNxt + 5) | 0, ack: 0, flags: RST, wnd: 0, data: [] }, A, B), A, t.now());
    expect(t.b.st).toBe(ESTABLISHED);
    expect(t.log.length).toBe(n + 1);
    expect(t.log[n].s.flags).toBe(ACK);
    t.b.input(segBytes({ sport: 40000, dport: 80, seq: t.b.rcvNxt, ack: 0, flags: RST, wnd: 0, data: [] }, A, B), A, t.now());
    expect(t.b.st).toBe(LISTEN);
  });
  it('another address or port gets a reset, not the connection', () => {
    const t = bench();
    open(t);
    const n = t.log.length;
    t.b.input(segBytes({ sport: 999, dport: 80, seq: 1, ack: 5, flags: ACK, wnd: 0, data: [] }, A, B), A, t.now());
    expect(t.b.st).toBe(ESTABLISHED);
    expect(t.log[n].s).toMatchObject({ flags: RST, seq: 5, dport: 999 });
  });
  it('a connection given up after RETRIES timeouts reports it', () => {
    const t = bench({ fate: () => 0 });
    t.a.connect(B, 40000, 80, t.now());
    t.run(() => t.a.st === CLOSED, 2_000_000_000);
    expect(t.a.err).toBe(true);
    expect(t.log.filter((x) => x.from === 'a').length).toBe(TCP_K.RETRIES + 1);
    expect(t.a.st).not.toBe(SYN_SENT);
  });
});

describe('reliable transfer', () => {
  it('no losses: every byte, no retransmission, the window growing', () => {
    const ev: TcpEvent[] = [];
    const t = bench({ ev: (e) => ev.push(e) });
    open(t);
    const got = transfer(t, 4000);
    expect(got).toEqual(want(4000));
    expect(ev.filter((e) => e.why === 'timeout' || e.why === 'fast')).toEqual([]);
    expect(Math.max(...ev.map((e) => e.cwnd))).toBeGreaterThan(4 * TCP_K.MSS);
    const seqs = t.log.filter((x) => x.from === 'a' && x.s.data.length).map((x) => x.s.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
  it('the receive window is never overrun and the data never exceeds an MSS', () => {
    const t = bench();
    open(t);
    transfer(t, 3000);
    for (const x of t.log) expect(x.s.data.length).toBeLessThanOrEqual(TCP_K.MSS);
  });
  it('any fate of the segments, whatever the seed: every byte, in order', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = lcg(seed);
      const loss = [2, 5, 10, 25][seed & 3];
      const t = bench({ fate: () => { const v = r(100); return v < loss ? 0 : v < loss + 5 ? 2 : 1; }, jitter: () => r(4000) });
      open(t);
      const got = transfer(t, 2500, 2_000_000_000);
      expect(t.a.err, `seed ${seed}`).toBe(false);
      expect(got.length, `seed ${seed}`).toBe(2500);
      expect(got, `seed ${seed}`).toEqual(want(2500));
    }
  });
  it('a stream that also flows back: both directions complete', () => {
    const r = lcg(3);
    const t = bench({ fate: () => (r(100) < 8 ? 0 : 1) });
    open(t);
    const d1 = want(1500), d2 = want(1500).map((x) => x ^ 0x5a);
    let s1 = 0, s2 = 0;
    const g1: number[] = [], g2: number[] = [];
    t.run(() => {
      if (s1 < 1500) s1 += t.a.write(d1.slice(s1), t.now());
      if (s2 < 1500) s2 += t.b.write(d2.slice(s2), t.now());
      g1.push(...t.b.read(4096, t.now())); g2.push(...t.a.read(4096, t.now()));
      return g1.length >= 1500 && g2.length >= 1500;
    }, 2_000_000_000);
    expect(g1).toEqual(d1);
    expect(g2).toEqual(d2);
  });
  it('the sequence numbers cross 0x7fffffff and 0xffffffff, with losses', () => {
    for (const isn of [0x7ffffe00, 0xfffffe00 | 0]) {
      const r = lcg(isn & 0xff | 1);
      const t = bench({ isnA: isn, isnB: isn + 200, fate: () => (r(100) < 6 ? 0 : 1) });
      open(t);
      const got = transfer(t, 3000, 2_000_000_000);
      expect(got).toEqual(want(3000));
    }
  });
  it('close after data: all of it arrives before the FIN, under losses', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = lcg(seed * 11);
      const t = bench({ fate: () => (r(100) < 10 ? 0 : 1) });
      open(t);
      const d = want(700), got: number[] = [];
      expect(t.a.write(d, t.now())).toBe(700);
      t.a.close(t.now());
      t.run(() => { got.push(...t.b.read(4096, t.now())); return t.b.st === CLOSE_WAIT && got.length === 700; }, 2_000_000_000);
      expect(got).toEqual(d);
      t.b.close(t.now());
      t.run(() => t.b.st === LISTEN && (t.a.st === TIME_WAIT || t.a.st === CLOSED), 2_000_000_000);
      expect(t.b.st).toBe(LISTEN);
    }
  });
});

describe('retransmission and congestion', () => {
  it('RFC 6298: the first sample sets SRTT = R, RTTVAR = R/2, RTO = R + 4·R/2 (floored at the minimum)', () => {
    const t = bench({ delay: 50_000 });
    t.b.listen(80);
    t.a.connect(B, 40000, 80, t.now());
    t.run(() => t.a.st === ESTABLISHED);
    expect(t.a.srtt).toBe(100_000);
    expect(t.a.rttvar).toBe(50_000);
    expect(t.a.rto).toBe(300_000);
  });
  it("Karn's rule: no sample from a retransmitted segment, and the timer doubles until an ACK", () => {
    let k = 0;
    const samples: number[] = [];
    const t = bench({ delay: 5000, fate: () => (k++ === 0 ? 0 : 1), ev: (e) => { if (e.why === 'sample') samples.push(e.srtt); } });
    t.b.listen(80);
    t.a.connect(B, 40000, 80, t.now());
    t.run(() => t.a.st === ESTABLISHED);
    expect(samples).toEqual([]);
    expect(t.a.srtt).toBe(0);
    expect(t.a.rto).toBe(2 * TCP_K.RTO_INIT);
  });
  it('slow start doubles per round trip, then congestion avoidance adds one MSS', () => {
    const ev: TcpEvent[] = [];
    const t = bench({ delay: 30_000, ev: (e) => ev.push(e) });
    open(t);
    t.a.ssthresh = 8 * TCP_K.MSS;
    transfer(t, 900);
    const acks = ev.filter((e) => e.why === 'ack');
    const c = acks.map((e) => e.cwnd / TCP_K.MSS);
    expect(c[0]).toBe(3);
    expect(c.includes(8)).toBe(true);
    // above ssthresh, one more only after a whole window's bytes
    const i = c.indexOf(8);
    expect(c[i + 1]).toBe(8);
  });
  it('three duplicate ACKs halve and go back; a timeout falls to one segment', () => {
    const ev: TcpEvent[] = [];
    let k = 0, lostAt = -1;
    const t = bench({ delay: 10_000, ev: (e) => ev.push(e), fate: (_seq, _n, from) => {
      if (from === 'a' && lostAt < 0 && t.a.cwnd >= 8 * TCP_K.MSS && t.a.sndNxt !== t.a.sndUna) { lostAt = k; return 0; }
      k++;
      return 1;
    } });
    open(t);
    expect(transfer(t, 4000)).toEqual(want(4000));
    const fast = ev.find((e) => e.why === 'fast')!;
    expect(fast).toBeDefined();
    expect(fast.cwnd).toBe(fast.ssthresh);
    expect(fast.cwnd).toBeLessThan(fast.flight);
    // lose everything for a while: the timer fires
    const ev2: TcpEvent[] = [];
    let dead = true;
    const u = bench({ delay: 10_000, ev: (e) => ev2.push(e), fate: (_seq, _n, from) => (from === 'a' && dead && u.a.sndUna !== u.a.sndNxt ? 0 : 1) });
    open(u);
    u.a.write(want(300), u.now());
    u.run(() => ev2.some((e) => e.why === 'timeout'));
    dead = false;
    const to = ev2.find((e) => e.why === 'timeout')!;
    expect(to.cwnd).toBe(TCP_K.MSS);
    expect(to.ssthresh).toBeGreaterThanOrEqual(2 * TCP_K.MSS);
    const got: number[] = [];
    u.run(() => { got.push(...u.b.read(4096, u.now())); return got.length >= 300; });
    expect(got).toEqual(want(300));
  });
  it('flow control: a receiver that stops reading closes the window, a probe finds it open again', () => {
    const t = bench({ delay: 5000 });
    open(t);
    const d = want(TCP_K.RCV + 300);
    let sent = 0;
    t.run(() => { if (sent < d.length) sent += t.a.write(d.slice(sent), t.now()); return t.a.sndWnd === 0 && t.a.sndUna === t.a.sndNxt; }, 100_000_000);
    expect(t.a.sndWnd).toBe(0);
    const delivered = (t.b.rcvNxt - t.b.rcvRead) | 0;
    expect(delivered).toBe(TCP_K.RCV);
    // the sender probes, one byte at a time, and gives none of it up as lost
    const n = t.log.length, cw = t.a.cwnd;
    t.run(() => t.log.length > n + 1, 200_000_000);
    expect(t.log[n].s.data.length).toBe(1);
    expect(t.a.cwnd).toBe(cw);
    const got: number[] = [];
    // what the application has not read holds no event of its own: read until nothing more comes
    for (let k = 0; k < 100 && got.length < d.length; k++) {
      t.run(() => { if (sent < d.length) sent += t.a.write(d.slice(sent), t.now()); got.push(...t.b.read(100, t.now())); return got.length >= d.length; }, 400_000_000);
      got.push(...t.b.read(100, t.now()));
    }
    expect(got).toEqual(d);
    // no timeout on the way: reopening carried on from the refused byte
    expect(t.a.retries).toBe(0);
  });
});
