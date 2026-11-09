// The bench of act 12's Forwarding path (l_fwd, chapter errors). The far end is a JavaScript model of a route table: longest prefix, the order of the tests, and the TTL and checksum
// of a real IPv4 header. The new checksum it expects is the whole header summed again (comm/netframes.ts), not the update the circuit is asked to make, so the two
// are independent. Lanes of a BitSim run one script each. No DOM.

import type { CustomRun } from '../editor/challenges';
import { checksum, ipText } from '../comm/netframes';
import type { ComponentDef } from '../sim/types';
import { finish, hex, simOf } from './commcheck';
import { rng } from './drills';

export const ACT_DROP = 0, ACT_FORWARD = 1, ACT_UP = 2;
export const FWD_ENTRIES = 4, PORT_UP = 3;
const ACT_NAMES = ['drop', 'forward', 'slow path'];

export interface Route { prefix: number; bytes: number; port: number }
export interface FwdHeader { dst: number; ttl: number; bad: number; src: number; id: number }
export type FwdOp = { w: number; r: Route } | { h: FwdHeader } | null;

const ip = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const be16 = (v: number) => [(v >> 8) & 255, v & 255];
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** A real header's 20 bytes for these fields, its checksum in place. */
export function headerOf(h: FwdHeader, ttl = h.ttl): number[] {
  const b = [0x45, 0, 0, 84, ...be16(h.id), 0x40, 0, ttl, 6, 0, 0, ...be32(h.src), ...be32(h.dst)], c = checksum(b);
  b[10] = c >> 8; b[11] = c & 255;
  return b;
}
export const checkOf = (h: FwdHeader, ttl = h.ttl): number => { const b = headerOf(h, ttl); return (b[10] << 8) | b[11]; };

/** The far end's table. */
export class FwdModel {
  slots: (Route | undefined)[] = Array(FWD_ENTRIES).fill(undefined);
  write(i: number, r: Route): void { this.slots[i] = r; }
  static matches(r: Route, dst: number): boolean {
    for (let k = 0; k < r.bytes; k++) if (((r.prefix >>> (24 - 8 * k)) & 255) !== ((dst >>> (24 - 8 * k)) & 255)) return false;
    return true;
  }
  /** The longest route that matches, of those in the table. */
  match(dst: number): Route | undefined {
    let best: Route | undefined;
    for (const r of this.slots) if (r && FwdModel.matches(r, dst) && (!best || r.bytes > best.bytes)) best = r;
    return best;
  }
  /** In the order a frame can fail: a bad header, then a TTL that has run out, then the lookup. */
  decide(h: FwdHeader): { act: number; port: number; why: 'bad' | 'ttl' | 'none' | 'local' | 'route'; route?: Route } {
    if (h.bad) return { act: ACT_DROP, port: 0, why: 'bad' };
    if (h.ttl <= 1) return { act: ACT_UP, port: PORT_UP, why: 'ttl' };
    const r = this.match(h.dst);
    if (!r) return { act: ACT_UP, port: PORT_UP, why: 'none' };
    if (r.port === PORT_UP) return { act: ACT_UP, port: PORT_UP, why: 'local', route: r };
    return { act: ACT_FORWARD, port: r.port, why: 'route', route: r };
  }
}

const routeText = (r: Route) => `${ipText(r.prefix)}/${8 * r.bytes} (port ${r.port})`;

export const FWD_LANES: { name: string; ops: FwdOp[] }[] = (() => {
  const r0 = rng(5101);
  let id = 1;
  const H = (dst: number, ttl = 64, bad = 0, src = ip(192, 168, 1, 7)): FwdOp => ({ h: { dst, ttl, bad, src, id: id++ } });
  const W = (w: number, prefix: number, bytes: number, port: number): FwdOp => ({ w, r: { prefix, bytes, port } });
  const NEST = [W(0, ip(10, 0, 0, 0), 1, 0), W(1, ip(10, 1, 0, 0), 2, 1), W(2, ip(10, 1, 2, 0), 3, 2), W(3, ip(10, 1, 2, 9), 4, 0)];
  /** A source that makes this header's checksum have 0xFF in its high byte: the update must carry round. */
  const carrying = (dst: number): FwdOp => {
    for (let s = 0; s < 400000; s++) {
      const h = { dst, ttl: 64, bad: 0, src: (ip(172, 16, 0, 0) + s) >>> 0, id: 7 };
      if (checkOf(h) >>> 8 === 0xff) return { h };
    }
    throw new Error('no carrying header');
  };
  /** The header RFC 1624 is about: a checksum of 0xFEFF, where adding 0x0100 to the field gives 0xFFFF and the sum says 0. */
  const minusZero = (dst: number): FwdOp => {
    for (let s = 0; s < 800000; s++) {
      const h = { dst, ttl: 64, bad: 0, src: (ip(172, 16, 0, 0) + s) >>> 0, id: 9 };
      if (checkOf(h) === 0xfeff) return { h };
    }
    throw new Error('no such header');
  };
  const random = (seed: number): FwdOp[] => {
    const q = rng(seed), pick = (n: number) => Math.floor(q() * n), ops: FwdOp[] = [];
    const nets = [ip(10, 0, 0, 0), ip(10, 1, 0, 0), ip(10, 1, 2, 0), ip(172, 16, 0, 0), ip(172, 16, 9, 0), ip(8, 8, 8, 8)];
    for (let t = 0; t < 70; t++) {
      const v = q();
      if (v < 0.15) { ops.push(null); continue; }
      if (v < 0.3) { const n = nets[pick(nets.length)], bytes = 1 + pick(4); ops.push({ w: pick(4), r: { prefix: (n | pick(256)) >>> 0, bytes, port: pick(4) } }); continue; }
      const n = nets[pick(nets.length)], dst = (n | (pick(2) ? pick(256) : pick(65536))) >>> 0;
      ops.push({ h: { dst, ttl: q() < 0.12 ? pick(2) : 2 + pick(254), bad: q() < 0.1 ? 1 : 0, src: Math.floor(q() * 2 ** 32) >>> 0, id: pick(65536) } });
    }
    // a slot rewritten can leave two routes alike: a route of the same prefix and length is left out, the table never holds both
    const seen = new Map<number, string>();
    return ops.filter((o) => {
      if (!o || !('w' in o)) return true;
      const k = `${(o.r.prefix >>> (32 - 8 * o.r.bytes)) >>> 0}/${o.r.bytes}`;
      for (const [slot, was] of seen) if (slot !== o.w && was === k) return false;
      seen.set(o.w, k);
      return true;
    });
  };
  void r0;
  return [
    { name: 'an empty table: everything goes up', ops: [H(ip(10, 1, 2, 3)), H(ip(8, 8, 8, 8))] },
    { name: 'one route, an address in it and one out of it', ops: [W(0, ip(10, 1, 2, 0), 3, 2), H(ip(10, 1, 2, 77)), H(ip(10, 1, 3, 77)), H(ip(11, 1, 2, 77))] },
    { name: 'routes nested in each other: the longest wins', ops: [...NEST, H(ip(10, 200, 0, 1)), H(ip(10, 1, 200, 1)), H(ip(10, 1, 2, 200)), H(ip(10, 1, 2, 9)), H(ip(11, 0, 0, 1))] },
    { name: 'the same routes in the other order: the slot means nothing', ops: [W(3, ip(10, 0, 0, 0), 1, 0), W(2, ip(10, 1, 0, 0), 2, 1), W(1, ip(10, 1, 2, 0), 3, 2), W(0, ip(10, 1, 2, 9), 4, 0), H(ip(10, 200, 0, 1)), H(ip(10, 1, 200, 1)), H(ip(10, 1, 2, 200)), H(ip(10, 1, 2, 9))] },
    { name: 'a default route under a longer one', ops: [W(0, 0, 0, 1), W(3, ip(10, 1, 0, 0), 2, 2), H(ip(10, 1, 9, 9)), H(ip(200, 1, 2, 3)), H(ip(0, 0, 0, 0)), H(ip(255, 255, 255, 255))] },
    { name: 'bits past the prefix length mean nothing, in the table or the address', ops: [W(1, ip(10, 1, 77, 88), 2, 1), W(2, ip(172, 99, 99, 99), 1, 2), H(ip(10, 1, 0, 0)), H(ip(10, 1, 255, 255)), H(ip(172, 0, 0, 0)), H(ip(10, 2, 77, 88))] },
    { name: 'a slot rewritten: the old route is gone', ops: [W(0, ip(10, 1, 0, 0), 2, 1), H(ip(10, 1, 0, 1)), W(0, ip(10, 2, 0, 0), 2, 2), H(ip(10, 1, 0, 1)), H(ip(10, 2, 0, 1))] },
    { name: 'the router\'s own address goes up, wherever the rest of its network goes', ops: [W(0, ip(10, 1, 2, 0), 3, 1), W(1, ip(10, 1, 2, 1), 4, PORT_UP), H(ip(10, 1, 2, 1)), H(ip(10, 1, 2, 2))] },
    { name: 'TTL: 0 and 1 go up, 2 and 255 go on one lower', ops: [W(0, 0, 0, 1), H(ip(1, 2, 3, 4), 0), H(ip(1, 2, 3, 4), 1), H(ip(1, 2, 3, 4), 2), H(ip(1, 2, 3, 4), 255)] },
    { name: 'an expired TTL with no route: the TTL is tested first', ops: [H(ip(1, 2, 3, 4), 1)] },
    { name: 'a checksum whose high byte is 0xFF: the update carries round', ops: [W(0, 0, 0, 2), carrying(ip(9, 9, 9, 9)), carrying(ip(9, 9, 9, 10)), carrying(ip(77, 1, 1, 1))] },
    { name: 'a checksum of 0xFEFF: the one case where adding 0x0100 to the field is wrong', ops: [W(0, 0, 0, 1), minusZero(ip(9, 9, 9, 9)), minusZero(ip(9, 9, 9, 10))] },
    { name: 'a bad header goes nowhere, even with its TTL out or no route', ops: [W(0, ip(10, 1, 0, 0), 2, 1), H(ip(10, 1, 0, 1), 64, 1), H(ip(10, 1, 0, 1), 1, 1), H(ip(99, 1, 0, 1), 64, 1), H(ip(10, 1, 0, 1), 64, 0)] },
    { name: 'a header every clock, with and without gaps', ops: [W(0, ip(10, 0, 0, 0), 1, 1), H(ip(10, 0, 0, 1)), H(ip(11, 0, 0, 1)), H(ip(10, 0, 0, 2)), null, null, H(ip(10, 0, 0, 3)), W(1, ip(11, 0, 0, 0), 1, 2), H(ip(11, 0, 0, 1)), null] },
    { name: 'random traffic 1', ops: random(21) }, { name: 'random traffic 2', ops: random(22) }, { name: 'random traffic 3', ops: random(23) }, { name: 'random traffic 4', ops: random(24) },
  ];
})();

export function runFwd(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the path is gates'], tested: 0 };
  const sim = simOf(def, ['clk', 'rst', 'we', 'slot', 'prefix', 'bytes', 'port_in', 'go', 'dst', 'ttl', 'check', 'bad', 'ovalid', 'act', 'port', 'ttl_o', 'check_o']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const lanes = FWD_LANES, n = lanes.length, fails: string[] = [];
  const models = lanes.map(() => new FwdModel());
  const len = Math.max(...lanes.map((l) => l.ops.length));
  const count = lanes.map(() => 0);
  const quiet = (i: number, m: string) => { if (!fails.some((f) => f.startsWith(lanes[i].name))) fails.push(`${lanes[i].name}: ${m}`); };
  for (let t = 0; t < len + 3; t++) {
    const ops = lanes.map((l) => (t >= 1 && t <= l.ops.length ? l.ops[t - 1] : null));
    const wr = ops.map((o) => (o && 'w' in o ? o : null)), hd = ops.map((o) => (o && 'h' in o ? o.h : null));
    sim.setInput('rst', t === 0 ? 1 : 0);
    sim.setInput('we', wr.map((w) => (w ? 1 : 0))); sim.setInput('slot', wr.map((w) => w?.w ?? 0));
    sim.setInput('prefix', wr.map((w) => w?.r.prefix ?? 0)); sim.setInput('bytes', wr.map((w) => w?.r.bytes ?? 0)); sim.setInput('port_in', wr.map((w) => w?.r.port ?? 0));
    sim.setInput('go', hd.map((h) => (h ? 1 : 0))); sim.setInput('dst', hd.map((h) => h?.dst ?? 0)); sim.setInput('ttl', hd.map((h) => h?.ttl ?? 0));
    sim.setInput('check', hd.map((h) => (h ? checkOf(h) : 0))); sim.setInput('bad', hd.map((h) => h?.bad ?? 0));
    sim.cycle();
    const ov = sim.get('ovalid', n), act = sim.get('act', n), port = sim.get('port', n), to = sim.get('ttl_o', n), co = sim.get('check_o', n);
    for (let i = 0; i < n; i++) {
      if (t === 0) continue;
      const w = wr[i], h = hd[i];
      if (w) models[i].write(w.w, w.r);
      if (!h) { if (ov[i]) quiet(i, `clock ${t}: ovalid = 1 with go = 0: nothing is decided without a go`); continue; }
      count[i]++;
      const want = models[i].decide(h), who = `header ${count[i]} (to ${ipText(h.dst)}, TTL ${h.ttl}${h.bad ? ', checksum bad' : ''})`;
      if (!ov[i]) { quiet(i, `clock ${t}: ovalid = 0 in the clock after go: the answer comes at once, a router has no time to wait`); continue; }
      if (act[i] !== want.act) {
        const said = ACT_NAMES[act[i]] ?? String(act[i]);
        const reason = want.why === 'bad' ? 'a header whose checksum failed goes nowhere, not even up: its addresses cannot be trusted, so nothing can answer it'
          : want.why === 'ttl' ? `a TTL of ${h.ttl} cannot go one lower and still leave here: it goes up to the slow path, which sends the ICMP "time exceeded"; this is tested before the lookup`
            : want.why === 'none' ? 'no route matches: it goes up to the slow path, which answers "no route"'
              : want.why === 'local' ? `the longest match is ${routeText(want.route!)}, the router itself: port ${PORT_UP} is the slow path`
                : `the longest match is ${routeText(want.route!)}`;
        quiet(i, `${who}: act = ${said}, expected ${ACT_NAMES[want.act]}: ${reason}`);
        continue;
      }
      if (port[i] !== want.port) {
        const beaten = models[i].slots.find((r) => r && r !== want.route && r.port === port[i] && r.bytes < (want.route?.bytes ?? 0) && FwdModel.matches(r, h.dst));
        quiet(i, want.act === ACT_DROP ? `${who}: port = ${port[i]}, expected 0 for a dropped frame` : want.act === ACT_UP ? `${who}: port = ${port[i]}, expected ${PORT_UP}: the slow path is port ${PORT_UP}` : `${who}: port = ${port[i]}, expected ${want.port}: the longest prefix wins, and that is ${routeText(want.route!)}${beaten ? `, not ${routeText(beaten)}` : ''}; the slot it sits in means nothing`);
        continue;
      }
      if (want.act !== ACT_FORWARD) continue;
      if (to[i] !== h.ttl - 1) { quiet(i, `${who}: ttl_o = ${to[i]}, expected ${h.ttl - 1}: every router lowers it by one`); continue; }
      const c = checkOf(h, h.ttl - 1);
      if (co[i] !== c) {
        const old = checkOf(h), plain = (old + 0x100) & 0xffff;
        quiet(i, `${who}: check_o = ${hex(co[i], 4)}, expected ${hex(c, 4)} (the whole header summed again, from ${hex(old, 4)}): ${old === 0xfeff && co[i] === 0xffff ? 'this is the case RFC 1624 corrected: adding 0x0100 to the field gives 0xFFFF, but a sum of non-zero words is never 0, so the checksum cannot be 0xFFFF. Work on the complement: ~(~HC + 0xFEFF)' : co[i] === plain ? 'the carry ran off the top: in ones\' complement it comes back in at the bottom' : 'complement the old checksum, add 0xFEFF, bring the carry round, complement again'}`);
      }
    }
  }
  return finish(fails, n, def);
}
