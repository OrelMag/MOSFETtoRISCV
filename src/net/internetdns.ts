// DNS for chapter 53: RFC 1035's real message bytes and an iterative resolver with a cache, on the invented network. The names are under
// .example (RFC 2606), so none can exist. Only A and NS records, no retries, no EDNS, no DNSSEC, and a query that is lost is not modelled.

import { hostFrame, hostId, hostIp, Internet, udpSegment } from './internet';
import { oneWayMs } from './internetdelay';
import { PROTO_UDP } from './ipv4';

export const TYPE_A = 1, TYPE_NS = 2, CLASS_IN = 1, DNS_PORT = 53;
export const RCODE_OK = 0, RCODE_NXDOMAIN = 3;

export interface Rr { name: string; type: number; ttl: number; data: number | string }
export interface DnsMessage { id: number; qr: boolean; aa: boolean; rd: boolean; ra: boolean; rcode: number; qname: string; qtype: number; answer: Rr[]; authority: Rr[]; additional: Rr[] }

const be16 = (v: number) => [(v >> 8) & 255, v & 255];
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** A name as labels, reusing any tail already written: a pointer is two bytes against a name's whole length (RFC 1035, 4.1.4). */
function writeName(out: number[], name: string, seen: Map<string, number>): void {
  const labels = name ? name.split('.') : [];
  for (let i = 0; i < labels.length; i++) {
    const tail = labels.slice(i).join('.'), at = seen.get(tail);
    if (at !== undefined) { out.push(0xc0 | (at >> 8), at & 255); return; }
    if (out.length < 0x3fff) seen.set(tail, out.length);
    out.push(labels[i].length, ...Array.from(labels[i], (c) => c.charCodeAt(0)));
  }
  out.push(0);
}

function writeRr(out: number[], r: Rr, seen: Map<string, number>): void {
  writeName(out, r.name, seen);
  out.push(...be16(r.type), ...be16(CLASS_IN), ...be32(r.ttl));
  const lenAt = out.length;
  out.push(0, 0);
  if (r.type === TYPE_A) out.push(...be32(r.data as number)); else writeName(out, r.data as string, seen);
  const n = out.length - lenAt - 2;
  out[lenAt] = n >> 8; out[lenAt + 1] = n & 255;
}

export function encodeDns(m: DnsMessage): number[] {
  const flags = (m.qr ? 0x8000 : 0) | (m.aa ? 0x0400 : 0) | (m.rd ? 0x0100 : 0) | (m.ra ? 0x0080 : 0) | m.rcode;
  const out = [...be16(m.id), ...be16(flags), 0, 1, ...be16(m.answer.length), ...be16(m.authority.length), ...be16(m.additional.length)];
  const seen = new Map<string, number>();
  writeName(out, m.qname, seen);
  out.push(...be16(m.qtype), ...be16(CLASS_IN));
  for (const r of [...m.answer, ...m.authority, ...m.additional]) writeRr(out, r, seen);
  return out;
}

function readName(b: readonly number[], start: number): { name: string; next: number } {
  const labels: string[] = [];
  let i = start, next = -1, jumps = 0;
  for (;;) {
    const n = b[i];
    if (n === undefined) throw new Error('name past the end');
    if ((n & 0xc0) === 0xc0) {
      if (next < 0) next = i + 2;
      if (++jumps > 32) throw new Error('a pointer loop');
      i = ((n & 0x3f) << 8) | b[i + 1];
      continue;
    }
    if (n === 0) { if (next < 0) next = i + 1; return { name: labels.join('.'), next }; }
    labels.push(String.fromCharCode(...b.slice(i + 1, i + 1 + n)));
    i += n + 1;
  }
}

export function decodeDns(b: readonly number[]): DnsMessage {
  const w = (i: number) => (b[i] << 8) | b[i + 1], flags = w(2), counts = [w(6), w(8), w(10)];
  const q = readName(b, 12);
  let i = q.next + 4;
  const sections: Rr[][] = counts.map((c) => {
    const out: Rr[] = [];
    for (let k = 0; k < c; k++) {
      const nm = readName(b, i);
      i = nm.next;
      const type = w(i), ttl = (b[i + 4] * 2 ** 24) + (b[i + 5] << 16) + (b[i + 6] << 8) + b[i + 7], len = w(i + 8);
      i += 10;
      const data: number | string = type === TYPE_A ? ((b[i] * 2 ** 24) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]) : readName(b, i).name;
      out.push({ name: nm.name, type, ttl, data });
      i += len;
    }
    return out;
  });
  return { id: w(0), qr: !!(flags & 0x8000), aa: !!(flags & 0x0400), rd: !!(flags & 0x0100), ra: !!(flags & 0x0080), rcode: flags & 15, qname: q.name, qtype: w(q.next), answer: sections[0], authority: sections[1], additional: sections[2] };
}

// ---- the zones ------------------------------------------------------------------------------------------------------------------------

export const TTL_ROOT = 172_800, TTL_TLD = 172_800, TTL_A = 300;
export const SITE = 'www.quillon.example';

interface Server { host: number; zone: string; delegations: { zone: string; ns: string; nsHost: number; ttl: number }[]; records: Rr[] }

/** Three servers, each knowing only the next: the root knows who runs .example, .example knows who runs quillon.example. */
export const SERVERS = (): Server[] => [
  { host: hostId('root'), zone: '', delegations: [{ zone: 'example', ns: 'tld.example', nsHost: hostId('tld'), ttl: TTL_ROOT }], records: [] },
  { host: hostId('tld'), zone: 'example', delegations: [{ zone: 'quillon.example', ns: 'ns1.quillon.example', nsHost: hostId('ns1'), ttl: TTL_TLD }], records: [] },
  { host: hostId('ns1'), zone: 'quillon.example', delegations: [], records: [{ name: SITE, type: TYPE_A, ttl: TTL_A, data: hostIp(hostId('www')) }, { name: 'ns1.quillon.example', type: TYPE_A, ttl: TTL_TLD, data: hostIp(hostId('ns1')) }] },
];

const inZone = (name: string, zone: string): boolean => zone === '' || name === zone || name.endsWith(`.${zone}`);

/** What an authoritative server says: the record, a referral with its glue, or that the name does not exist. */
export function answerFrom(s: Server, q: DnsMessage): DnsMessage {
  const base: DnsMessage = { ...q, qr: true, aa: false, ra: false, rcode: RCODE_OK, answer: [], authority: [], additional: [] };
  const del = s.delegations.find((d) => inZone(q.qname, d.zone));
  if (del) return { ...base, authority: [{ name: del.zone, type: TYPE_NS, ttl: del.ttl, data: del.ns }], additional: [{ name: del.ns, type: TYPE_A, ttl: del.ttl, data: hostIp(del.nsHost) }] };
  const rec = s.records.filter((r) => r.name === q.qname && r.type === q.qtype);
  if (rec.length) return { ...base, aa: true, answer: rec };
  return { ...base, aa: true, rcode: RCODE_NXDOMAIN };
}

export interface DnsStep { from: number; to: number; msg: DnsMessage; frame: number[]; ms: number; note: string }
export interface Resolution { steps: DnsStep[]; answer: number | null; rcode: number; ms: number; lookups: number }

/** The resolver's memory: what it heard, until each record's TTL runs out. */
export class Resolver {
  private cache = new Map<string, { until: number; rr: Rr }>();
  private id = 0x4a10;
  constructor(readonly net: Internet, readonly host = hostId('resolver')) {}

  flush(): void { this.cache.clear(); }
  cached(now: number): { rr: Rr; left: number }[] { return [...this.cache.values()].filter((c) => c.until > now).map((c) => ({ rr: c.rr, left: Math.round(c.until - now) })); }

  private get(name: string, type: number, now: number): Rr | null {
    const c = this.cache.get(`${name}/${type}`);
    return c && c.until > now ? c.rr : null;
  }
  private put(r: Rr, now: number): void { this.cache.set(`${r.name}/${r.type}`, { until: now + r.ttl, rr: r }); }

  private message(from: number, to: number, msg: DnsMessage, note: string): DnsStep {
    const data = encodeDns(msg), src = hostIp(from), dst = hostIp(to), toServer = !msg.qr;
    const frame = hostFrame(from, dst, 64, PROTO_UDP, udpSegment(src, dst, toServer ? 49152 : DNS_PORT, toServer ? DNS_PORT : 49152, data), msg.id & 0xffff);
    return { from, to, msg, frame, ms: oneWayMs(this.net.send(from, frame), frame.length), note };
  }

  /** A stub on `client` asks; the resolver answers from its cache or goes down from the deepest zone it knows, root first. */
  resolve(client: number, name: string, now: number): Resolution {
    const steps: DnsStep[] = [], servers = SERVERS();
    const q = (id: number, rd: boolean): DnsMessage => ({ id, qr: false, aa: false, rd, ra: false, rcode: 0, qname: name, qtype: TYPE_A, answer: [], authority: [], additional: [] });
    const id0 = this.id++;
    const finish = (answer: Rr | null, rcode: number, lookups: number): Resolution => {
      const reply: DnsMessage = { ...q(id0, true), qr: true, ra: true, rcode, answer: answer ? [answer] : [] };
      steps.push(this.message(this.host, client, reply, answer ? 'The answer, to the machine that asked' : 'No such name'));
      return { steps, answer: answer ? (answer.data as number) : null, rcode, ms: steps.reduce((a, s) => a + s.ms, 0), lookups };
    };
    steps.push(this.message(client, this.host, q(id0, true), 'A stub asks its resolver, recursion desired'));
    const hit = this.get(name, TYPE_A, now);
    if (hit) return finish(hit, RCODE_OK, 0);
    // the deepest delegation still in the cache, else the root, whose address every resolver is configured with
    let server = servers[0];
    for (const s of servers.slice(1)) {
      if (!inZone(name, s.zone) || !this.get(s.zone, TYPE_NS, now)) continue;
      const ns = this.get(s.zone, TYPE_NS, now)!.data as string;
      if (this.get(ns, TYPE_A, now)) server = s;
    }
    let lookups = 0;
    for (let guard = 0; guard < 8; guard++) {
      const id = this.id++, ask = q(id, false);
      steps.push(this.message(this.host, server.host, ask, `Ask the ${server.zone ? `.${server.zone}` : 'root'} server`));
      const a = answerFrom(server, decodeDns(encodeDns(ask)));
      lookups++;
      const back = this.message(server.host, this.host, a, a.answer.length ? 'The authoritative answer' : a.rcode ? 'No such name' : `A referral: ask ${a.authority[0].data}`);
      steps.push(back);
      const heard = decodeDns(encodeDns(a));
      for (const r of [...heard.answer, ...heard.authority, ...heard.additional]) this.put(r, now);
      if (heard.answer.length) return finish(heard.answer[0], RCODE_OK, lookups);
      if (heard.rcode) return finish(null, heard.rcode, lookups);
      const nsName = heard.authority[0].data as string, ip = heard.additional.find((r) => r.name === nsName)!.data as number;
      server = servers.find((s) => hostIp(s.host) === ip)!;
    }
    return finish(null, RCODE_NXDOMAIN, lookups);
  }
}
