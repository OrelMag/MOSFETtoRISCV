// Chapter 53's internet: a packet-level model of an invented network of networks. Eight autonomous systems, routers and hosts; link state
// inside each one (net/routing.ts), BGP between them (internetbgp.ts); from both, each router's table as prefixes, then as the trie and
// next-hop bytes of chapter 51's fast path. A frame is forwarded here byte by byte, and tests/net-internet-gates runs the same bytes through
// the gates at every hop. A static site cannot run a real traceroute, and this one never touches the learner's network (roadmap decision 6).
//
// Nothing here is anyone's: AS numbers from the documentation range (RFC 5398: 64496-64511), addresses from private 10/8 (RFC 1918), names
// under .example (RFC 2606), and the networks' names made up. Every router has at most three ports, all a 2-bit port field leaves beside the
// slow path's: that is a limit of our fast path, which the map obeys so that any hop can be opened on gates.

import { ETHERTYPE_IPV4, frameBody, type Mac } from '../comm/ethframe';
import { BgpNet, type AsRelation, type BgpOptions } from './internetbgp';
import { checksum, ipOf, ipPacket, onesSum, parseIp, PROTO_ICMP, PROTO_TCP, PROTO_UDP, ttlChecksum } from './ipv4';
import { dijkstra, downKey, type Link, type Topology } from './routing';
import { adjImage, buildTrie, lpmLinear, PORT_CPU, walkTrie, type NextHop, type Route } from './trie';

export interface AsInfo { asn: number; name: string; kind: string; net: number; hue: number }
export interface RouterInfo { name: string; as: number; at: [number, number] }
/** km and Mb/s make the delay; `load` is the cross traffic's share of the rate; `ix` marks a link between two networks. */
export interface NetLink { a: number; b: number; km: number; mbps: number; load: number; note: string }
export interface HostInfo { name: string; router: number; low: number }

export const ASES: AsInfo[] = [
  { asn: 64496, name: 'Fernbank Cable', kind: 'access', net: 1, hue: 150 },
  { asn: 64497, name: 'Ridgeway Net', kind: 'regional', net: 2, hue: 200 },
  { asn: 64498, name: 'Orchard Net', kind: 'regional', net: 3, hue: 30 },
  { asn: 64499, name: 'Tarn Backbone', kind: 'backbone', net: 4, hue: 310 },
  { asn: 64500, name: 'Kestrel Transit', kind: 'backbone', net: 5, hue: 260 },
  { asn: 64501, name: 'Quillon Hosting', kind: 'content', net: 6, hue: 0 },
  { asn: 64502, name: 'Brackwater DSL', kind: 'access', net: 7, hue: 90 },
  { asn: 64503, name: 'Sable Mobile', kind: 'access', net: 8, hue: 60 },
];
export const AS_FERN = 0, AS_RIDGE = 1, AS_ORCH = 2, AS_TARN = 3, AS_KEST = 4, AS_QUIL = 5, AS_BRACK = 6, AS_SABLE = 7;

/** Who pays whom: [provider, customer], and peers, who carry each other's customers for free. */
export const RELATIONS: AsRelation[] = [
  { a: AS_RIDGE, b: AS_FERN, kind: 'provider' }, { a: AS_RIDGE, b: AS_SABLE, kind: 'provider' }, { a: AS_KEST, b: AS_RIDGE, kind: 'provider' },
  { a: AS_TARN, b: AS_ORCH, kind: 'provider' }, { a: AS_TARN, b: AS_QUIL, kind: 'provider' }, { a: AS_ORCH, b: AS_BRACK, kind: 'provider' },
  { a: AS_KEST, b: AS_TARN, kind: 'peer' }, { a: AS_RIDGE, b: AS_ORCH, kind: 'peer' },
];

export const R = { f1: 0, f2: 1, s1: 2, r1: 3, r2: 4, k1: 5, k2: 6, k3: 7, t1: 8, t2: 9, t3: 10, o1: 11, o2: 12, b1: 13, q1: 14, q2: 15 } as const;
export const ROUTERS: RouterInfo[] = [
  { name: 'f1', as: AS_FERN, at: [40, 70] }, { name: 'f2', as: AS_FERN, at: [120, 70] },
  { name: 's1', as: AS_SABLE, at: [120, 170] },
  { name: 'r1', as: AS_RIDGE, at: [200, 110] }, { name: 'r2', as: AS_RIDGE, at: [290, 110] },
  { name: 'k1', as: AS_KEST, at: [290, 30] }, { name: 'k2', as: AS_KEST, at: [400, 30] }, { name: 'k3', as: AS_KEST, at: [510, 30] },
  { name: 't1', as: AS_TARN, at: [510, 110] }, { name: 't2', as: AS_TARN, at: [600, 110] }, { name: 't3', as: AS_TARN, at: [690, 110] },
  { name: 'o1', as: AS_ORCH, at: [400, 190] }, { name: 'o2', as: AS_ORCH, at: [510, 190] },
  { name: 'b1', as: AS_BRACK, at: [400, 260] },
  { name: 'q1', as: AS_QUIL, at: [690, 190] }, { name: 'q2', as: AS_QUIL, at: [690, 260] },
];

/** Lengths and rates are invented but of the usual size: a street, a town, a country, an ocean; 1 Gb/s at the edge, 100 Gb/s in a backbone. */
export const LINKS: NetLink[] = [
  { a: R.f1, b: R.f2, km: 12, mbps: 1000, load: 0.3, note: 'town' },
  { a: R.f2, b: R.r1, km: 60, mbps: 10000, load: 0.3, note: 'to the provider' },
  { a: R.s1, b: R.r1, km: 45, mbps: 1000, load: 0.3, note: 'to the provider' },
  { a: R.r1, b: R.r2, km: 180, mbps: 10000, load: 0.4, note: 'region' },
  { a: R.r2, b: R.k1, km: 30, mbps: 10000, load: 0.4, note: 'to the provider' },
  { a: R.r2, b: R.o1, km: 25, mbps: 10000, load: 0.2, note: 'peering, an exchange point' },
  { a: R.k1, b: R.k2, km: 900, mbps: 100000, load: 0.4, note: 'country' },
  { a: R.k2, b: R.k3, km: 1100, mbps: 100000, load: 0.4, note: 'country' },
  { a: R.k3, b: R.t1, km: 5, mbps: 100000, load: 0.3, note: 'peering, an exchange point' },
  { a: R.t1, b: R.t2, km: 6400, mbps: 100000, load: 0.5, note: 'ocean' },
  { a: R.t2, b: R.t3, km: 800, mbps: 100000, load: 0.4, note: 'country' },
  { a: R.o1, b: R.o2, km: 400, mbps: 10000, load: 0.3, note: 'region' },
  { a: R.o2, b: R.t1, km: 20, mbps: 10000, load: 0.3, note: 'to the provider' },
  { a: R.o1, b: R.b1, km: 35, mbps: 1000, load: 0.3, note: 'to the provider' },
  { a: R.t3, b: R.q1, km: 15, mbps: 10000, load: 0.3, note: 'to the provider' },
  { a: R.q1, b: R.q2, km: 1, mbps: 10000, load: 0.2, note: 'data centre' },
];

export const HOSTS: HostInfo[] = [
  { name: 'laptop', router: R.f1, low: 10 }, { name: 'resolver', router: R.f2, low: 53 },
  { name: 'phone', router: R.s1, low: 20 }, { name: 'neighbour', router: R.b1, low: 30 },
  { name: 'root', router: R.k2, low: 53 }, { name: 'tld', router: R.t2, low: 53 },
  { name: 'www', router: R.q2, low: 80 }, { name: 'ns1', router: R.q1, low: 53 },
  { name: 'cache', router: R.f2, low: 80 },
];
export const hostId = (name: string): number => HOSTS.findIndex((h) => h.name === name);

/** Each router numbered within its network owns one /24 of that network's /16: its own address is .1, its hosts are the others. */
export const routerIndexInAs = (r: number): number => ROUTERS.filter((x, i) => i <= r && x.as === ROUTERS[r].as).length - 1;
export const subnetOf = (r: number): number => ipOf(`10.${ASES[ROUTERS[r].as].net}.${routerIndexInAs(r) + 1}.0`);
export const routerIp = (r: number): number => (subnetOf(r) + 1) >>> 0;
export const hostIp = (h: number): number => (subnetOf(HOSTS[h].router) + HOSTS[h].low) >>> 0;
export const routerMac = (r: number): Mac => [0x02, 0, 0, 0, 0xa0, r];
export const hostMac = (h: number): Mac => [0x02, 0, 0, 0, 0xb0, h];
export const asPrefix = (as: number): number => ipOf(`10.${ASES[as].net}.0.0`);
export const asOfIp = (ip: number): number => ASES.findIndex((a) => a.net === ((ip >>> 16) & 255) && ip >>> 24 === 10);

/** A router's next hops: the neighbours and hosts behind each port, in the order the ports are numbered. */
export interface Neighbour { router?: number; host?: number; port: number; link?: number }

/** The ports never renumber when a link fails: a router's wiring does not change because the far end died. */
export function neighboursOf(r: number): Neighbour[] {
  const out: Neighbour[] = [];
  let port = 0;
  LINKS.forEach((l, i) => { if (l.a === r) out.push({ router: l.b, port: port++, link: i }); else if (l.b === r) out.push({ router: l.a, port: port++, link: i }); });
  const hosts = HOSTS.map((h, i) => ({ h, i })).filter((x) => x.h.router === r);
  if (hosts.length) { for (const x of hosts) out.push({ host: x.i, port }); port++; }
  return out;
}

export const linkKey = (i: number): string => downKey(LINKS[i].a, LINKS[i].b);
export const linkBetween = (a: number, b: number): number => LINKS.findIndex((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));

export interface RouterTable {
  routes: Route[];
  /** The next hop's meaning by its index in the table: 1 and up, as the trie and the next-hop memory hold it. */
  hops: Record<number, NextHop>;
  to: Record<number, Neighbour | 'self'>;
  trie: number[];
  adj: number[];
  own: Mac;
}

export interface InternetOptions extends BgpOptions { down?: ReadonlySet<string> }

const LOCAL_LEN = 32;

/** One state of the world: which links are up, what BGP settled on, every router's table. Rebuilt when a link fails. */
export class Internet {
  readonly down: ReadonlySet<string>;
  readonly bgp: BgpNet;
  private tables = new Map<number, RouterTable>();

  constructor(o: InternetOptions = {}) {
    this.down = o.down ?? new Set();
    this.bgp = new BgpNet(this.adjacency(), o);
    this.bgp.settle();
  }

  linkUp(i: number): boolean { return !this.down.has(linkKey(i)); }

  /** Which networks are connected by a live link, with what relation. */
  private adjacency(): AsRelation[] {
    return RELATIONS.filter((rel) => LINKS.some((l, i) => {
      if (this.down.has(linkKey(i))) return false;
      const x = ROUTERS[l.a].as, y = ROUTERS[l.b].as;
      return (x === rel.a && y === rel.b) || (x === rel.b && y === rel.a);
    }));
  }

  /** One network's routers alone: link state does not look past its own edge. */
  private igp(as: number): { topo: Topology; ids: number[] } {
    const ids = ROUTERS.flatMap((r, i) => (r.as === as ? [i] : []));
    const links: Link[] = [];
    LINKS.forEach((l, i) => {
      if (ROUTERS[l.a].as === as && ROUTERS[l.b].as === as) links.push({ a: ids.indexOf(l.a), b: ids.indexOf(l.b), cost: Math.max(1, Math.round(l.km)) });
      void i;
    });
    return { topo: { names: ids.map((i) => ROUTERS[i].name), at: ids.map((i) => ROUTERS[i].at), links }, ids };
  }

  private igpNext(from: number, to: number): { next: number; dist: number } | null {
    const as = ROUTERS[from].as, { topo, ids } = this.igp(as);
    const d = dijkstra(topo, ids.indexOf(from), this.igpDown(ids)), j = ids.indexOf(to);
    if (from === to) return { next: from, dist: 0 };
    if (d.dist[j] === Infinity) return null;
    return { next: ids[d.next[j]], dist: d.dist[j] };
  }

  private igpDown(ids: number[]): Set<string> {
    const s = new Set<string>();
    LINKS.forEach((l, i) => { if (this.down.has(linkKey(i)) && ids.includes(l.a) && ids.includes(l.b)) s.add(downKey(ids.indexOf(l.a), ids.indexOf(l.b))); });
    return s;
  }

  /** The way out towards a neighbouring network: the nearest border router wins (hot potato: hand the packet on as soon as you can). */
  private egress(r: number, nextAs: number): number | null {
    const as = ROUTERS[r].as;
    let best: { dist: number; next: number } | null = null;
    LINKS.forEach((l, i) => {
      if (!this.linkUp(i)) return;
      for (const [u, v] of [[l.a, l.b], [l.b, l.a]]) {
        if (ROUTERS[u].as !== as || ROUTERS[v].as !== nextAs) continue;
        const g = this.igpNext(r, u);
        if (!g) continue;
        const next = u === r ? v : g.next;
        if (!best || g.dist < best.dist) best = { dist: g.dist, next };
      }
    });
    return best === null ? null : (best as { next: number }).next;
  }

  /** The table: its own network by link state, everybody else's prefixes by BGP, its own address for the slow path, its hosts to the wire. */
  tableOf(r: number): RouterTable {
    const hit = this.tables.get(r);
    if (hit) return hit;
    const as = ROUTERS[r].as, nbrs = neighboursOf(r);
    const hops: Record<number, NextHop> = {}, to: Record<number, Neighbour | 'self'> = {}, routes: Route[] = [];
    let n = 0;
    const hopFor = (nb: Neighbour): number => {
      for (const [k, v] of Object.entries(to)) if (v !== 'self' && v.router === nb.router && v.host === nb.host) return +k;
      n++;
      to[n] = nb;
      hops[n] = { mac: nb.host !== undefined ? hostMac(nb.host) : routerMac(nb.router!), port: nb.port };
      return n;
    };
    n++; to[n] = 'self'; hops[n] = { mac: routerMac(r), port: PORT_CPU };
    const self = n;
    routes.push({ prefix: routerIp(r), len: LOCAL_LEN, hop: self });
    for (const nb of nbrs) if (nb.host !== undefined) routes.push({ prefix: hostIp(nb.host), len: LOCAL_LEN, hop: hopFor(nb) });
    for (let o = 0; o < ROUTERS.length; o++) {
      if (o === r || ROUTERS[o].as !== as) continue;
      const g = this.igpNext(r, o);
      if (!g) continue;
      const nb = nbrs.find((x) => x.router === g.next);
      if (nb) routes.push({ prefix: subnetOf(o), len: 24, hop: hopFor(nb) });
    }
    for (const p of this.bgp.prefixes()) {
      const best = this.bgp.best(as, p.key);
      if (!best || best.path.length === 0) continue;
      const v = this.egress(r, best.path[0]);
      if (v === null) continue;
      const nb = nbrs.find((x) => x.router === v);
      if (nb) routes.push({ prefix: p.prefix, len: p.len, hop: hopFor(nb) });
    }
    const t: RouterTable = { routes, hops, to, trie: buildTrie(routes), adj: adjImage(routerMac(r), hops), own: routerMac(r) };
    this.tables.set(r, t);
    return t;
  }

  /** What a router does with a frame, by reading its bytes: chapter 51's rules, written apart from net/fastpath.ts and held equal to it. */
  forward(r: number, frame: readonly number[]): HopResult {
    const own = routerMac(r), t = this.tableOf(r), ip = parseIp(frame.slice(14));
    if (!own.every((b, i) => frame[i] === b)) return { kind: 'drop', why: 'another machine\'s MAC', reads: 0 };
    if (!ip.checkOk) return { kind: 'drop', why: 'a bad header checksum', reads: 0 };
    if (ip.ttl < 2) return { kind: 'expired', reads: 0 };
    const w = walkTrie(t.trie, ip.dst);
    if (w.hop === 0) return { kind: 'noroute', reads: w.reads };
    const target = t.to[w.hop];
    if (target === 'self') return { kind: 'local', reads: w.reads };
    const out = [...frame], hop = t.hops[w.hop];
    hop.mac.forEach((b, i) => { out[i] = b; });
    own.forEach((b, i) => { out[6 + i] = b; });
    out[22] = ip.ttl - 1;
    const nc = ttlChecksum(ip.check);
    out[24] = nc >> 8; out[25] = nc & 255;
    return { kind: 'forward', frame: out, to: target, port: hop.port, reads: w.reads };
  }

  /** Sends a frame from a host until something other than a forward happens: the frame at every hop on the way. */
  send(fromHost: number, frame: readonly number[]): Journey {
    const hops: JourneyHop[] = [];
    let f = [...frame], r: number = HOSTS[fromHost].router, guard = 0;
    for (;;) {
      if (guard++ > 64) return { hops, end: { kind: 'loop' } };
      const res = this.forward(r, f);
      hops.push({ router: r, frameIn: f, result: res });
      if (res.kind !== 'forward') return { hops, end: { kind: res.kind === 'expired' ? 'expired' : res.kind === 'local' ? 'router' : res.kind === 'noroute' ? 'noroute' : 'drop', router: r } };
      if (res.to.host !== undefined) return { hops, end: { kind: 'host', host: res.to.host, frame: res.frame } };
      f = res.frame;
      r = res.to.router!;
    }
  }
}

export type HopResult =
  | { kind: 'forward'; frame: number[]; to: Neighbour; port: number; reads: number }
  | { kind: 'expired' | 'noroute' | 'local'; reads: number }
  | { kind: 'drop'; why: string; reads: number };
export interface JourneyHop { router: number; frameIn: number[]; result: HopResult }
export type JourneyEnd = { kind: 'host'; host: number; frame: number[] } | { kind: 'expired' | 'router' | 'noroute' | 'drop'; router: number } | { kind: 'loop' };
export interface Journey { hops: JourneyHop[]; end: JourneyEnd }

// ---- the frames ---------------------------------------------------------------------------------------------------------------------

const be16 = (v: number) => [(v >> 8) & 255, v & 255];
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** RFC 768 with its pseudo-header. */
export function udpSegment(src: number, dst: number, sport: number, dport: number, data: readonly number[]): number[] {
  const len = 8 + data.length, seg = [...be16(sport), ...be16(dport), ...be16(len), 0, 0, ...data];
  const c = checksum(seg, onesSum([...be32(src), ...be32(dst), 0, PROTO_UDP, ...be16(len)])) || 0xffff;
  seg[6] = c >> 8; seg[7] = c & 255;
  return seg;
}

export const TCP_SYN = 2, TCP_ACK = 16, TCP_PSH = 8;
/** RFC 793's header, no options, for the bytes of one request; the protocol is chapter 52's. */
export function tcpSegment(src: number, dst: number, sport: number, dport: number, seq: number, ack: number, flags: number, data: readonly number[]): number[] {
  const seg = [...be16(sport), ...be16(dport), ...be32(seq), ...be32(ack), 0x50, flags, ...be16(65535), 0, 0, 0, 0, ...data];
  const c = checksum(seg, onesSum([...be32(src), ...be32(dst), 0, PROTO_TCP, ...be16(seg.length)]));
  seg[16] = c >> 8; seg[17] = c & 255;
  return seg;
}

/** A host's frame to its own router, whatever the far address: that is what a default route means. */
export function hostFrame(host: number, dst: number, ttl: number, proto: number, payload: readonly number[], id = 1): number[] {
  return frameBody({ dst: routerMac(HOSTS[host].router), src: hostMac(host), type: ETHERTYPE_IPV4, payload: ipPacket({ src: hostIp(host), dst, ttl, proto, id, payload }) });
}

export const TRACE_PORT = 33434;
/** Traceroute's probe as Unix sends it: UDP to a port nobody listens on, so the far host answers too, and the TTL decides who speaks. */
export const probeFrame = (host: number, dst: number, ttl: number): number[] =>
  hostFrame(host, dst, ttl, PROTO_UDP, udpSegment(hostIp(host), dst, 33000 + host, TRACE_PORT + ttl, new Array<number>(12).fill(0)), 0x1000 + ttl);

export const ICMP_TIME_EXCEEDED = 11, ICMP_UNREACHABLE = 3;
/** RFC 792: type, code, checksum, four unused bytes, then the offending IP header and its first eight bytes, so the sender can tell which probe it was. */
export function icmpError(type: number, code: number, offending: readonly number[]): number[] {
  const body = [type, code, 0, 0, 0, 0, 0, 0, ...offending.slice(0, 28)];
  const c = checksum(body);
  body[2] = c >> 8; body[3] = c & 255;
  return body;
}

export interface TraceRow { ttl: number; router?: number; host?: number; from: number; forward: Journey; back: Journey; reply: number[]; reached: boolean }

const ipBytes = (frame: readonly number[]): number[] => {
  const len = (frame[16] << 8) | frame[17];
  return frame.slice(14, 14 + len);
};

/** One probe, and the ICMP that comes back, each a real walk through the tables: the way back can differ from the way there. */
export function traceRow(net: Internet, host: number, dst: number, ttl: number): TraceRow | null {
  const forward = net.send(host, probeFrame(host, dst, ttl));
  const end = forward.end;
  if (end.kind === 'expired') {
    const last = forward.hops[forward.hops.length - 1];
    const icmp = icmpError(ICMP_TIME_EXCEEDED, 0, ipBytes(last.frameIn));
    return { ttl, router: end.router, from: routerIp(end.router), forward, back: replyJourney(net, end.router, hostIp(host), icmp), reply: icmp, reached: false };
  }
  if (end.kind === 'host') {
    const icmp = icmpError(ICMP_UNREACHABLE, 3, ipBytes(end.frame));
    const back = net.send(end.host, hostFrame(end.host, hostIp(host), 64, PROTO_ICMP, icmp, 0x2000 + ttl));
    return { ttl, host: end.host, from: hostIp(end.host), forward, back, reply: icmp, reached: true };
  }
  return null;
}

/** A router's own packet starts inside it: the slow path looks the source up in its own table and hands the frame to the fast path. */
function replyJourney(net: Internet, r: number, dst: number, icmp: readonly number[]): Journey {
  const pkt = ipPacket({ src: routerIp(r), dst, ttl: 64, proto: PROTO_ICMP, id: 0x3000, payload: icmp });
  const t = net.tableOf(r), w = walkTrie(t.trie, dst), target = t.to[w.hop];
  if (w.hop === 0 || target === undefined || target === 'self') return { hops: [], end: { kind: 'noroute', router: r } };
  const first = frameBody({ dst: t.hops[w.hop].mac, src: routerMac(r), type: ETHERTYPE_IPV4, payload: pkt });
  if (target.host !== undefined) return { hops: [{ router: r, frameIn: first, result: { kind: 'forward', frame: first, to: target, port: t.hops[w.hop].port, reads: w.reads } }], end: { kind: 'host', host: target.host, frame: first } };
  let f = first, x = target.router!, guard = 0;
  const hops: JourneyHop[] = [{ router: r, frameIn: first, result: { kind: 'forward', frame: first, to: target, port: t.hops[w.hop].port, reads: w.reads } }];
  while (guard++ < 64) {
    const res = net.forward(x, f);
    hops.push({ router: x, frameIn: f, result: res });
    if (res.kind !== 'forward') return { hops, end: { kind: 'drop', router: x } };
    if (res.to.host !== undefined) return { hops, end: { kind: 'host', host: res.to.host, frame: res.frame } };
    f = res.frame; x = res.to.router!;
  }
  return { hops, end: { kind: 'loop' } };
}

export const MAX_TTL = 30;
/** Traceroute: TTL 1, 2, 3 … until the far host answers or nothing does. */
export function traceroute(net: Internet, host: number, dst: number): TraceRow[] {
  const rows: TraceRow[] = [];
  for (let ttl = 1; ttl <= MAX_TTL; ttl++) {
    const row = traceRow(net, host, dst, ttl);
    if (!row) break;
    rows.push(row);
    if (row.reached) break;
  }
  return rows;
}

/** The routers a packet crosses, by name: what the map lights. */
export const routersOf = (j: Journey): number[] => j.hops.map((x) => x.router);

/** The links a journey uses, in order. */
export function linksOf(j: Journey): number[] {
  const out: number[] = [];
  for (const x of j.hops) if (x.result.kind === 'forward' && x.result.to.router !== undefined) out.push(linkBetween(x.router, x.result.to.router));
  return out;
}

/** Every entry an independent scan of the routes would pick: the trie's answer checked in tests. */
export const scanRoute = (t: RouterTable, ip: number): number => lpmLinear(t.routes, ip);
