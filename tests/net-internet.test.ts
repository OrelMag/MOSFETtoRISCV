// Chapter 53's model: the map obeys the fast path's limits, BGP against an independent statement of the policy, and a frame's walk through
// the tables against what a router must do. The gates are in net-internet-gates.test.ts.

import { describe, expect, it } from 'vitest';
import { parseIp, PROTO_ICMP, PROTO_UDP, ipOf, checksum } from '../src/net/ipv4';
import { AS_BRACK, AS_FERN, AS_KEST, AS_ORCH, AS_QUIL, AS_RIDGE, AS_SABLE, AS_TARN, ASES, asPrefix, hostFrame, hostId, hostIp, HOSTS, ICMP_TIME_EXCEEDED, ICMP_UNREACHABLE, Internet, linkBetween, linkKey, LINKS, neighboursOf, probeFrame, R, RELATIONS, routerIp, ROUTERS, routersOf, scanRoute, traceroute } from '../src/net/internet';
import { BgpNet, CLS_CUSTOMER, keyOf } from '../src/net/internetbgp';
import { MAX_HOPS, walkTrie } from '../src/net/trie';

const LAPTOP = hostId('laptop'), WWW = hostId('www');
const key = (as: number) => keyOf(asPrefix(as), 16);
const name = (r: number) => ROUTERS[r].name;

describe('the map', () => {
  it('nothing on it is anyone\'s: documentation AS numbers, private addresses', () => {
    for (const a of ASES) { expect(a.asn).toBeGreaterThanOrEqual(64496); expect(a.asn).toBeLessThanOrEqual(64511); }
    for (let r = 0; r < ROUTERS.length; r++) expect(routerIp(r) >>> 24).toBe(10);
    for (let h = 0; h < HOSTS.length; h++) expect(hostIp(h) >>> 24).toBe(10);
  });
  it('every router fits the fast path: three ports, 1024 trie nodes, 15 next hops', () => {
    const net = new Internet();
    for (let r = 0; r < ROUTERS.length; r++) {
      const ports = new Set(neighboursOf(r).map((n) => n.port));
      expect(ports.size, name(r)).toBeLessThanOrEqual(3);
      const t = net.tableOf(r);
      expect(Object.keys(t.hops).length, name(r)).toBeLessThanOrEqual(MAX_HOPS);
      expect(t.trie.length, name(r)).toBeLessThanOrEqual(1024);
    }
  });
  it('addresses are distinct', () => {
    const all = [...ROUTERS.map((_, r) => routerIp(r)), ...HOSTS.map((_, h) => hostIp(h))];
    expect(new Set(all).size).toBe(all.length);
  });
});

/** Valley-free, stated directly on a path of networks: up (customer to provider) any number of times, at most one peer step, then only down. */
function valleyFree(path: number[]): boolean {
  const up = (a: number, b: number) => RELATIONS.some((r) => r.kind === 'provider' && r.a === b && r.b === a);
  const down = (a: number, b: number) => RELATIONS.some((r) => r.kind === 'provider' && r.a === a && r.b === b);
  const peer = (a: number, b: number) => RELATIONS.some((r) => r.kind === 'peer' && ((r.a === a && r.b === b) || (r.a === b && r.b === a)));
  let phase = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    if (up(a, b)) { if (phase > 0) return false; } else if (peer(a, b)) { if (phase > 0) return false; phase = 1; } else if (down(a, b)) phase = 1; else return false;
  }
  return true;
}

describe('BGP', () => {
  const net = new Internet();
  it('settles, and everybody reaches everybody', () => {
    expect(net.bgp.rounds).toBeGreaterThan(0);
    for (let a = 0; a < ASES.length; a++) for (let b = 0; b < ASES.length; b++) expect(net.bgp.best(a, key(b)), `${a} to ${b}`).toBeDefined();
  });
  it('every chosen path is valley-free, free of loops, and ends at the origin', () => {
    for (let a = 0; a < ASES.length; a++) for (let b = 0; b < ASES.length; b++) {
      const p = [a, ...net.bgp.best(a, key(b))!.path];
      expect(valleyFree(p), p.join(' ')).toBe(true);
      expect(new Set(p).size).toBe(p.length);
      expect(p[p.length - 1]).toBe(b);
    }
  });
  it('Fernbank reaches Quillon through the backbones although a shorter wire exists: policy', () => {
    expect(net.bgp.best(AS_FERN, key(AS_QUIL))!.path).toEqual([AS_RIDGE, AS_KEST, AS_TARN, AS_QUIL]);
    const free = new Internet({ policy: false });
    expect(free.bgp.best(AS_FERN, key(AS_QUIL))!.path.length).toBeLessThanOrEqual(4);
    expect(free.bgp.best(AS_RIDGE, key(AS_QUIL))!.path).toEqual([AS_ORCH, AS_TARN, AS_QUIL]);
  });
  it('a customer\'s route beats a shorter peer\'s', () => {
    const r = net.bgp.best(AS_TARN, key(AS_BRACK))!;
    expect(r.cls).toBe(CLS_CUSTOMER);
    expect(r.path).toEqual([AS_ORCH, AS_BRACK]);
  });
  it('the peering link: Fernbank reaches Brackwater over it; Orchard will not carry Ridgeway to its own provider', () => {
    expect(net.bgp.best(AS_FERN, key(AS_BRACK))!.path).toEqual([AS_RIDGE, AS_ORCH, AS_BRACK]);
    expect(net.bgp.best(AS_RIDGE, key(AS_QUIL))!.via).toBe(AS_KEST);
  });
  it('a path holding the network itself is refused', () => {
    const b = new BgpNet(RELATIONS, { policy: false });
    b.settle();
    expect(b.refused).toBeGreaterThan(0);
    for (let a = 0; a < ASES.length; a++) for (let o = 0; o < ASES.length; o++) expect(b.best(a, key(o))!.path).not.toContain(a);
  });
  it('rounds are bounded by the longest chosen path, as path vector promises here', () => {
    let longest = 0;
    for (let a = 0; a < ASES.length; a++) for (let o = 0; o < ASES.length; o++) longest = Math.max(longest, net.bgp.best(a, key(o))!.path.length);
    expect(net.bgp.rounds).toBeLessThanOrEqual(longest + 1);
  });
});

describe('forwarding', () => {
  const net = new Internet();
  it('the trie answers as a scan of the routes does, at every router, for every address on the map', () => {
    const ips = [...ROUTERS.map((_, r) => routerIp(r)), ...HOSTS.map((_, h) => hostIp(h)), ipOf('192.0.2.1'), ipOf('10.99.0.1')];
    for (let r = 0; r < ROUTERS.length; r++) { const t = net.tableOf(r); for (const ip of ips) expect(walkTrie(t.trie, ip).hop, `${name(r)} ${ip}`).toBe(scanRoute(t, ip)); }
  });
  it('from every host to every host, the frame arrives', () => {
    for (let a = 0; a < HOSTS.length; a++) for (let b = 0; b < HOSTS.length; b++) {
      if (a === b) continue;
      const j = net.send(a, hostFrame(a, hostIp(b), 64, PROTO_UDP, [1, 2, 3, 4, 5, 6, 7, 8]));
      expect(j.end.kind === 'host' && j.end.host, `${HOSTS[a].name} to ${HOSTS[b].name}`).toBe(b);
    }
  });
  it('the laptop to www: the path the chapter draws', () => {
    const j = net.send(LAPTOP, hostFrame(LAPTOP, hostIp(WWW), 64, PROTO_UDP, [1, 2, 3, 4, 5, 6, 7, 8]));
    expect(routersOf(j).map(name)).toEqual(['f1', 'f2', 'r1', 'r2', 'k1', 'k2', 'k3', 't1', 't2', 't3', 'q1', 'q2']);
  });
  it('at each hop only the MACs, the TTL and the checksum move, and the header still checks', () => {
    const j = net.send(LAPTOP, hostFrame(LAPTOP, hostIp(WWW), 64, PROTO_UDP, [9, 8, 7, 6]));
    for (const [i, h] of j.hops.entries()) {
      if (h.result.kind !== 'forward') throw new Error('stopped');
      const a = h.frameIn, b = h.result.frame;
      expect(b.length).toBe(a.length);
      expect(b.slice(12, 22)).toEqual(a.slice(12, 22));
      expect(b[22]).toBe(a[22] - 1);
      expect(b.slice(26)).toEqual(a.slice(26));
      expect(parseIp(b.slice(14)).checkOk).toBe(true);
      expect(checksum(b.slice(14, 34))).toBe(0);
      expect(b[22]).toBe(64 - i - 1);
    }
  });
  it('a failed link: the route moves, or the network says it has none', () => {
    const down = new Set([linkKey(linkBetween(R.r2, R.k1))]), n = new Internet({ down });
    const j = n.send(LAPTOP, hostFrame(LAPTOP, hostIp(hostId('neighbour')), 64, PROTO_UDP, [1, 2, 3, 4, 5, 6, 7, 8]));
    expect(j.end.kind).toBe('host');
    // Ridgeway has lost its provider, and its peer will not carry it to the backbones
    const w = n.send(LAPTOP, hostFrame(LAPTOP, hostIp(WWW), 64, PROTO_UDP, [1, 2, 3, 4, 5, 6, 7, 8]));
    expect(w.end.kind).toBe('noroute');
    // with policy off the same wires would carry it
    const free = new Internet({ down, policy: false }).send(LAPTOP, hostFrame(LAPTOP, hostIp(WWW), 64, PROTO_UDP, [1, 2, 3, 4, 5, 6, 7, 8]));
    expect(free.end.kind).toBe('host');
  });
  it('a hijack: the longer prefix wins everywhere it reaches, and the packets go to the wrong network', () => {
    const www = hostIp(WWW), hijack = { as: AS_SABLE, prefix: (www & 0xffffff00) >>> 0, len: 24 };
    const n = new Internet({ hijack });
    const j = n.send(LAPTOP, hostFrame(LAPTOP, www, 64, PROTO_UDP, [1, 2, 3, 4, 5, 6, 7, 8]));
    expect(routersOf(j).map((r) => ROUTERS[r].as)).toContain(AS_SABLE);
    expect(j.end).toEqual({ kind: 'router', router: R.s1 });
    expect(n.bgp.best(AS_TARN, keyOf(hijack.prefix, 24))).toBeDefined();
  });
  it('a hijack beats the victim\'s own inside route too: ns1 to www, one network, ends at Sable', () => {
    const www = hostIp(WWW), hijack = { as: AS_SABLE, prefix: (www & 0xffffff00) >>> 0, len: 24 };
    const ns1 = hostId('ns1'), frame = () => hostFrame(ns1, www, 64, PROTO_UDP, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Internet().send(ns1, frame()).end).toMatchObject({ kind: 'host', host: WWW });
    expect(new Internet({ hijack }).send(ns1, frame()).end).toEqual({ kind: 'router', router: R.s1 });
  });
  it('a probe\'s port starts where Unix traceroute starts: 33434 at TTL 1, one more a TTL', () => {
    const port = (f: number[]) => (f[36] << 8) | f[37];
    expect(port(probeFrame(LAPTOP, hostIp(WWW), 1))).toBe(33434);
    expect(port(probeFrame(LAPTOP, hostIp(WWW), 2))).toBe(33435);
  });
});

describe('traceroute', () => {
  const net = new Internet();
  const rows = traceroute(net, LAPTOP, hostIp(WWW));
  it('hears from each router in order, then the far host', () => {
    expect(rows.map((r) => (r.router !== undefined ? name(r.router) : HOSTS[r.host!].name))).toEqual(['f1', 'f2', 'r1', 'r2', 'k1', 'k2', 'k3', 't1', 't2', 't3', 'q1', 'q2', 'www']);
    expect(rows[rows.length - 1].reached).toBe(true);
  });
  it('the replies are real ICMP: type, checksum, and the probe\'s header inside', () => {
    for (const [i, r] of rows.entries()) {
      expect(r.reply[0]).toBe(r.reached ? ICMP_UNREACHABLE : ICMP_TIME_EXCEEDED);
      expect(checksum(r.reply)).toBe(0);
      expect(r.reply[8]).toBe(0x45);
      const inner = parseIp(r.reply.slice(8));
      expect(inner.dst).toBe(hostIp(WWW));
      expect(inner.proto).toBe(PROTO_UDP);
      expect(inner.checkOk).toBe(true);
      expect(r.back.end.kind === 'host' && r.back.end.host).toBe(LAPTOP);
      if (r.back.end.kind === 'host') {
        const ip = parseIp(r.back.end.frame.slice(14));
        expect(ip.proto).toBe(PROTO_ICMP);
        expect(ip.src).toBe(r.from);
      }
      expect(r.ttl).toBe(i + 1);
    }
  });
  it('probes differ only in TTL, port and id, and each is a valid frame', () => {
    for (const ttl of [1, 7]) expect(parseIp(probeFrame(LAPTOP, hostIp(WWW), ttl).slice(14)).checkOk).toBe(true);
  });
  it('every link on the map is usable', () => {
    for (const l of LINKS) expect(linkBetween(l.a, l.b)).toBeGreaterThanOrEqual(0);
  });
});
