// Chapter 51: IPv4 bytes, the checksum's incremental update, longest-prefix match in a trie, and the fast path in gates against its golden
// model at every output of every clock, then against an independent statement of what a router must do to a frame.

import { describe, expect, it } from 'vitest';
import { BROADCAST, ETHERTYPE_ARP, ETHERTYPE_IPV4, frameBody, type Mac } from '../src/comm/ethframe';
import { routerFastPath } from '../src/lib';
import { ACT_DROP, ACT_PUNT, ACT_WALK, C_BROADCAST, C_FORWARD, C_LOCAL, C_NO_ROUTE, C_NOT_IP, C_OPTIONS, C_TTL, FastPathModel, S_RX, verdict, type FpIn } from '../src/net/fastpath';
import { checksum, ipOf, ipPacket, ipText, onesSum, parseIp, PROTO_UDP, ttlChecksum } from '../src/net/ipv4';
import { adjImage, buildTrie, lpmLinear, PORT_CPU, walkTrie, type NextHop, type Route } from '../src/net/trie';
import { simulate } from '../src/sim/harness';
import { lcg, out as outOf } from './util';
import { tick as yieldTick } from './yieldtick';

const OWN: Mac = [0x02, 0, 0, 0, 0, 0xfe];
const HOST: Mac = [0x02, 0, 0, 0, 0, 0x01];
const HOPS: Record<number, NextHop> = {
  1: { mac: [0x02, 0, 0, 0, 1, 1], port: 0 }, 2: { mac: [0x02, 0, 0, 0, 2, 2], port: 1 }, 3: { mac: [0x02, 0, 0, 0, 3, 3], port: 2 }, 4: { mac: OWN, port: PORT_CPU },
};
const ROUTES: Route[] = [
  { prefix: ipOf('10.0.0.0'), len: 8, hop: 1 }, { prefix: ipOf('10.1.0.0'), len: 16, hop: 2 }, { prefix: ipOf('10.1.2.0'), len: 24, hop: 3 },
  { prefix: ipOf('10.1.2.1'), len: 32, hop: 4 }, { prefix: ipOf('192.168.0.0'), len: 16, hop: 2 },
];
const TRIE = buildTrie(ROUTES), ADJ = adjImage(OWN, HOPS);

const udp = (dst: string, ttl = 64, payload: number[] = [1, 2, 3, 4]) => frameBody({ dst: OWN, src: HOST, type: ETHERTYPE_IPV4, payload: ipPacket({ src: ipOf('10.9.9.9'), dst: ipOf(dst), ttl, proto: PROTO_UDP, id: 7, payload }) });

describe('IPv4 bytes', () => {
  it('RFC 1071\'s worked example, and a header that sums to all ones', () => {
    expect(onesSum([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7])).toBe(0xddf2);
    const p = ipPacket({ src: ipOf('192.168.0.1'), dst: ipOf('192.168.0.199'), ttl: 64, proto: PROTO_UDP, payload: [] });
    expect(onesSum(p.slice(0, 20))).toBe(0xffff);
    expect(parseIp(p)).toMatchObject({ version: 4, ihl: 5, ttl: 64, proto: 17, checkOk: true, dst: ipOf('192.168.0.199') });
    expect(ipText(ipOf('10.1.2.3'))).toBe('10.1.2.3');
  });
  it('a known header\'s checksum (the widely quoted 0xB861 example)', () => {
    const h = [0x45, 0, 0, 0x73, 0, 0, 0x40, 0, 0x40, 0x11, 0, 0, 0xc0, 0xa8, 0, 1, 0xc0, 0xa8, 0, 0xc7];
    expect(checksum(h)).toBe(0xb861);
  });
  it('the incremental update equals summing again, over random headers and every TTL', () => {
    const r = lcg(3);
    for (let n = 0; n < 4000; n++) {
      const ttl = 1 + r(255), p = ipPacket({ src: (r(65536) * 65536 + r(65536)) >>> 0, dst: (r(65536) * 65536 + r(65536)) >>> 0, ttl, proto: r(256), id: r(65536), payload: [] });
      const old = (p[10] << 8) | p[11];
      p[8] = ttl - 1; p[10] = p[11] = 0;
      expect(ttlChecksum(old)).toBe(checksum(p));
    }
  });
});

describe('longest-prefix match', () => {
  it('the trie walk equals the definition, and a read a level', () => {
    const r = lcg(11);
    const routes: Route[] = [];
    for (let i = 0; i < 60; i++) { const len = r(33); routes.push({ prefix: (r(4) << 30 | r(65536) << 8 | r(256)) >>> 0, len, hop: 1 + r(15) }); }
    // later duplicates of a prefix overwrite earlier ones in both
    const uniq = [...new Map(routes.map((x) => [`${(x.prefix & (x.len ? (0xffffffff << (32 - x.len)) >>> 0 : 0)) >>> 0}/${x.len}`, x])).values()];
    const words = buildTrie(uniq);
    for (let n = 0; n < 3000; n++) {
      const pick = uniq[r(uniq.length)], low = r(2) ? r(65536) : 0, ip = n % 2 ? ((pick.prefix & 0xffff0000) | low) >>> 0 : (r(65536) * 65536 + r(65536)) >>> 0;
      const w = walkTrie(words, ip);
      expect(w.hop).toBe(lpmLinear(uniq, ip));
      expect(w.reads).toBeLessThanOrEqual(33);
    }
  });
  it('a full-length route takes 33 reads', () => {
    expect(walkTrie(buildTrie([{ prefix: 0xdeadbeef, len: 32, hop: 5 }]), 0xdeadbeef)).toMatchObject({ hop: 5, reads: 33 });
  });
  it('refuses what does not fit', () => {
    expect(() => buildTrie([{ prefix: 0, len: 8, hop: 0 }])).toThrow();
    const many: Route[] = Array.from({ length: 200 }, (_, i) => ({ prefix: (i * 0x01000000 + 0x123456) >>> 0, len: 32, hop: 1 }));
    expect(() => buildTrie(many)).toThrow(/nodes/);
  });
});

describe('the verdict', () => {
  const ok = { me: 1, bcast: 0, len14: 1, isIp: 1, r34: 1, ip45: 1, sumOk: 1, ttlOk: 1 };
  it('names each way out', () => {
    expect(verdict(ok)).toEqual({ act: ACT_WALK, cause: 0 });
    expect(verdict({ ...ok, me: 0 }).act).toBe(ACT_DROP);
    expect(verdict({ ...ok, isIp: 0 })).toEqual({ act: ACT_PUNT, cause: C_NOT_IP });
    expect(verdict({ ...ok, ip45: 0 })).toEqual({ act: ACT_PUNT, cause: C_OPTIONS });
    expect(verdict({ ...ok, sumOk: 0 }).act).toBe(ACT_DROP);
    expect(verdict({ ...ok, ttlOk: 0 })).toEqual({ act: ACT_PUNT, cause: C_TTL });
    expect(verdict({ ...ok, me: 0, bcast: 1 })).toEqual({ act: ACT_PUNT, cause: C_BROADCAST });
  });
});

// ---- the gates ------------------------------------------------------------------------------------------------------------------

type Sim = ReturnType<typeof simulate>;
const DEF = routerFastPath(TRIE, ADJ, '_test');

function drive(sim: Sim, x: FpIn): void {
  sim.setInput('rxd', x.rxd); sim.setInput('rxv', x.rxv); sim.setInput('rxl', x.rxl); sim.setInput('txr', x.txr);
  sim.setInput('cfg_we', x.cfgWe ?? 0); sim.setInput('cfg_t', x.cfgT ?? 0); sim.setInput('cfg_a', x.cfgA ?? 0); sim.setInput('cfg_d', x.cfgD ?? 0);
  sim.settle();
}
const pulse = (sim: Sim) => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };

function same(sim: Sim, m: FastPathModel, where: string): void {
  const o = m.outputs();
  for (const [k, v] of Object.entries(o)) expect(outOf(sim, k), `${k} at ${where}`).toBe(v);
}

/** One frame through gates and model in lock step; what left, with its port and cause. */
function run(sim: Sim, m: FastPathModel, frame: number[], stall: () => number, gap: () => number) {
  const out: number[] = [];
  let port = -1, cause = -1, i = 0, cycles = 0, starting = true;
  for (let guard = 0; guard < 8000; guard++) {
    const o = m.outputs();
    if (i >= frame.length && o.state === S_RX && !starting && o.txv === 0) break;
    const valid = i < frame.length && !stall() ? 1 : 0;
    const x: FpIn = { rxd: valid ? frame[i] : 0, rxv: valid, rxl: valid && i === frame.length - 1 ? 1 : 0, txr: gap() ? 0 : 1 };
    drive(sim, x);
    same(sim, m, `cycle ${cycles}`);
    if (valid && o.rxr) { i++; starting = false; }
    if (o.txv && x.txr) { out.push(o.txd); port = o.port; cause = o.cause; }
    m.step(x); pulse(sim);
    cycles++;
  }
  return { out, port, cause, cycles };
}

/** Independent of the model: what a router must have done to a forwarded frame. */
function expectForwarded(input: number[], out: number[], nextHop: Mac): void {
  expect(out.slice(0, 6)).toEqual([...nextHop]);
  expect(out.slice(6, 12)).toEqual([...OWN]);
  expect(out.length).toBe(input.length);
  expect(out.slice(12, 22)).toEqual(input.slice(12, 22));
  expect(out[22]).toBe(input[22] - 1);
  expect(out[23]).toBe(input[23]);
  expect(out.slice(26)).toEqual(input.slice(26));
  expect(parseIp(out.slice(14)).checkOk).toBe(true);
}

describe('the fast path in gates, every output every clock', () => {
  const fresh = () => { const sim = simulate(DEF); return { sim, m: new FastPathModel(TRIE, ADJ) }; };
  const never = () => 0;

  it('forwards by the longest prefix, rewriting four fields', () => {
    const { sim, m } = fresh();
    for (const [dst, hop] of [['10.200.0.1', 1], ['10.1.77.1', 2], ['10.1.2.9', 3], ['192.168.5.5', 2]] as [string, number][]) {
      const f = udp(dst), r = run(sim, m, f, never, never);
      expect(r.cause).toBe(C_FORWARD);
      expect(r.port).toBe(HOPS[hop].port);
      expectForwarded(f, r.out, HOPS[hop].mac);
    }
  });
  it('sends up, unchanged: TTL expired, no route, this router, ARP, options, broadcast', () => {
    const { sim, m } = fresh();
    const cases: [number[], number][] = [
      [udp('10.1.2.9', 1), C_TTL], [udp('10.1.2.9', 0), C_TTL], [udp('8.8.8.8'), C_NO_ROUTE], [udp('10.1.2.1'), C_LOCAL],
      [frameBody({ dst: BROADCAST, src: HOST, type: ETHERTYPE_ARP, payload: new Array(28).fill(1) }), C_NOT_IP],
    ];
    const opt = udp('10.1.2.9'); opt[14] = 0x46;
    cases.push([opt, C_OPTIONS]);
    const bc = udp('10.1.2.9'); bc.splice(0, 6, ...BROADCAST);
    cases.push([bc, C_BROADCAST]);
    for (const [f, c] of cases) {
      const r = run(sim, m, f, never, never);
      expect(r.cause, `cause ${c}`).toBe(c);
      expect(r.port).toBe(PORT_CPU);
      expect(r.out).toEqual(f);
    }
  });
  it('drops: another MAC, a bad checksum, a runt', () => {
    const { sim, m } = fresh();
    const other = udp('10.1.2.9'); other[5] = 0x77;
    const bad = udp('10.1.2.9'); bad[25] ^= 1;
    const runt = udp('10.1.2.9').slice(0, 10), shortIp = udp('10.1.2.9').slice(0, 30);
    for (const f of [other, bad, runt, shortIp]) expect(run(sim, m, f, never, never).out).toEqual([]);
    const after = udp('10.1.2.9'); // the state is clean for the next frame
    expectForwarded(after, run(sim, m, after, never, never).out, HOPS[3].mac);
  });
  it('holds under back-pressure on both sides and the timing is what the chapter says', async () => {
    const { sim, m } = fresh(), r = lcg(9);
    const f = udp('10.1.2.9', 64, Array.from({ length: 60 }, (_, i) => i));
    const clean = run(sim, m, f, never, never);
    // n bytes in, DECIDE, the walk (24 bits of prefix + the root + the /24's own read), ADJ, n bytes out
    expect(clean.cycles).toBe(f.length + 1 + walkTrie(TRIE, ipOf('10.1.2.9')).reads + 1 + f.length);
    expectForwarded(f, run(sim, m, f, () => r(3) === 0 ? 1 : 0, () => r(3) === 0 ? 1 : 0).out, HOPS[3].mac);
    await yieldTick();
  });
  it('random frames, including corrupted ones: every output every clock', async () => {
    const { sim, m } = fresh(), r = lcg(21);
    const dsts = ['10.200.0.1', '10.1.77.1', '10.1.2.9', '10.1.2.1', '192.168.5.5', '8.8.8.8', '172.16.0.1'];
    for (let n = 0; n < 60; n++) {
      const payload = Array.from({ length: r(80) }, () => r(256));
      const f = udp(dsts[r(dsts.length)], r(4) === 0 ? r(3) : 1 + r(255), payload);
      if (r(4) === 0) f[r(f.length)] ^= 1 << r(8);
      run(sim, m, f, () => (r(4) === 0 ? 1 : 0), () => (r(4) === 0 ? 1 : 0));
      await yieldTick();
    }
  });
  it('corner routes: a default, a /1, a /32 at the top of the space, the last hop number', async () => {
    const routes: Route[] = [{ prefix: 0, len: 0, hop: 1 }, { prefix: 0x80000000, len: 1, hop: 2 }, { prefix: 0xffffffff, len: 32, hop: 15 }, { prefix: ipOf('10.1.2.1'), len: 32, hop: 4 }];
    const hops = { ...HOPS, 15: { mac: [0x02, 0, 0, 0, 0xf, 0xf], port: 2 } };
    const trie = buildTrie(routes), adj = adjImage(OWN, hops), sim = simulate(routerFastPath(trie, adj, '_corner')), m = new FastPathModel(trie, adj);
    for (const dst of ['1.2.3.4', '127.255.255.255', '128.0.0.0', '255.255.255.255', '255.255.255.254', '10.1.2.1']) {
      const ip = ipOf(dst), f = udp(dst), hop = lpmLinear(routes, ip), r = run(sim, m, f, () => 0, () => 0);
      if (hop === 4) expect(r.cause).toBe(C_LOCAL);
      else { expect(r.cause).toBe(C_FORWARD); expectForwarded(f, r.out, hops[hop as keyof typeof hops].mac); }
      await yieldTick();
    }
  });
  it('a slow path installs a route through the cfg port', () => {
    const sim = simulate(routerFastPath()), m = new FastPathModel([], []);
    const write = (t: number, a: number, d: number) => { const x: FpIn = { rxd: 0, rxv: 0, rxl: 0, txr: 1, cfgWe: 1, cfgT: t, cfgA: a, cfgD: d }; drive(sim, x); m.step(x); pulse(sim); };
    TRIE.forEach((w, a) => write(0, a, w));
    ADJ.forEach((b, a) => { if (b) write(1, a, b); });
    const f = udp('10.1.2.9'), rr = run(sim, m, f, () => 0, () => 0);
    expectForwarded(f, rr.out, HOPS[3].mac);
  });
});
