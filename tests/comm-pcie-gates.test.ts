// PCIe in gates against comm/pcie.ts, every output after every clock: the whole link (both ports, requester, completer, the lane) on
// training, reads and writes, flipped symbols in each direction, and credit exhaustion; the port alone on random symbols. The credit gate on its spec.
import { describe, expect, it } from 'vitest';
import { creditOk, LINK_IN0, PciePort, PcieLink, PORT_IN0, tlpSymbols, tlpBytes, dllpSymbols, DLLP_ACK, DLLP_NAK, type LinkIn, type PortIn } from '../src/comm/pcie';
import { creditGate, pcieLane, pcieLink, pcieEpTl, pciePort, pcieRootTl, PORT_STATUS, readStatus } from '../src/lib/pcie';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';
import { lcg, out, set } from './util';
import { tick as yieldTick } from './yieldtick';

type Gate = ReturnType<typeof simulate>;
const edge = (s: Gate) => { set(s, { clk: 1 }); set(s, { clk: 0 }); };

const PORT_OUT = ['txd', 'txk', 't_ready', 'c_ok', 'r_valid'] as const;
const statusOf = (s: Gate, port: string) => readStatus(s.getBits(s.design.root.ports[port]));

function comparePort(s: Gate, m: PciePort, i: PortIn, at: string): void {
  const o = m.out(i) as unknown as Record<string, number>;
  for (const n of PORT_OUT) if (out(s, n) !== o[n]) throw new Error(`${at}: ${n} gates ${out(s, n)} model ${o[n]}`);
  const st = statusOf(s, 'status');
  for (const [n] of PORT_STATUS) if (st[n] !== o[n]) throw new Error(`${at}: ${n} gates ${st[n]} model ${o[n]}`);
  if (o.r_valid && out(s, 'r_data') !== o.r_data) throw new Error(`${at}: r_data gates ${out(s, 'r_data')} model ${o.r_data}`);
}
const toGates = (i: PortIn) => ({ rst: i.rst, rxdet: i.rxdet, rxd: i.rxd, rxk: i.rxk, t_data: i.t_data, t_valid: i.t_valid, t_last: i.t_last, r_ready: i.r_ready, c_want: i.c_want, c_np: i.c_np, consume: i.consume, rtn_ph: i.rtn_ph, rtn_pd: i.rtn_pd, rtn_nph: i.rtn_nph });

const LINK_OUT: [string, (w: ReturnType<PcieLink['out']>) => number][] = [];
for (const [p, side] of [['a_', 'a'], ['b_', 'b']] as const) for (const n of ['txd', 'txk'] as const) LINK_OUT.push([p + n, (w) => w[side][n]]);
LINK_OUT.push(['busy', (w) => w.ta.busy], ['wait', (w) => w.ta.wait], ['rd_valid', (w) => w.rd_valid], ['rd_done', (w) => w.rd_done], ['ep_st', (w) => w.te.ep_st]);

class Lock {
  s = simulate(pcieLink()); m = new PcieLink(); n = 0;
  constructor() {
    set(this.s, { rst: 1, plug: 1, go: 0, wr: 0, addr: 0, len: 1, seed: 0, flip_ab: 0, flip_ba: 0, clk: 0 });
    edge(this.s);
    this.m.step({ ...LINK_IN0, rst: 1 });
    set(this.s, { rst: 0 });
  }
  step(c: Partial<LinkIn> = {}): void {
    const i = { ...LINK_IN0, ...c };
    set(this.s, { rst: i.rst, plug: i.plug, go: i.go, wr: i.wr, addr: i.addr, len: i.len, seed: i.seed, flip_ab: i.flip_ab, flip_ba: i.flip_ba });
    const w = this.m.out(i);
    for (const [name, f] of LINK_OUT) {
      const g = out(this.s, name), v = f(w);
      if (g !== v) throw new Error(`clock ${this.n}: ${name} gates ${g} model ${v}`);
    }
    for (const side of ['a', 'b'] as const) {
      const st = statusOf(this.s, `${side}_status`), o = w[side] as unknown as Record<string, number>;
      for (const [n] of PORT_STATUS) if (st[n] !== o[n]) throw new Error(`clock ${this.n}: ${side}.${n} gates ${st[n]} model ${o[n]}`);
    }
    if (w.rd_valid && out(this.s, 'rd_data') !== w.rd_data) throw new Error(`clock ${this.n}: rd_data gates ${out(this.s, 'rd_data')} model ${w.rd_data}`);
    edge(this.s); this.m.step(i); this.n++;
  }
  async run(n: number, c: Partial<LinkIn> = {}): Promise<void> {
    for (let k = 0; k < n; k++) { this.step(c); if (k % 256 === 255) await yieldTick(); }
  }
  async cmd(c: Partial<LinkIn>): Promise<void> {
    let n = 0;
    while (this.m.ra.st !== 0 && n++ < 20000) { this.step(); if (n % 256 === 0) await yieldTick(); }
    this.step({ go: 1, ...c });
  }
}

describe('credit gate', () => {
  it('equals the standard\'s test, around the wrap too', () => {
    for (const w of [8, 12]) {
      const s = simulate(creditGate(w)), r = lcg(w), mx = 2 ** w;
      for (let k = 0; k < 2000; k++) {
        const near = k % 2 === 0, cc = r(mx), lim = near ? (cc + r(40)) % mx : r(mx), want = r(32);
        set(s, { limit: lim, consumed: cc, want });
        expect(out(s, 'ok')).toBe(creditOk(lim, cc, want, w) ? 1 : 0);
      }
    }
  });
});

describe('the drawings', () => {
  it('every box routes with no overlaps', () => {
    const kids = (d: ComponentDef): ComponentDef[] => { const nl = netlistOf(d); return nl ? nl.instances.map((i) => i.def).filter((c) => c.id.startsWith('pcie_')) : []; };
    const seen = new Set<string>(), walk: ComponentDef[] = [pcieLink()];
    for (const d of walk) { if (seen.has(d.id)) continue; seen.add(d.id); walk.push(...kids(d)); }
    expect(seen.size).toBeGreaterThan(6);
    for (const d of walk) {
      if (!d.id.startsWith('pcie_')) continue;
      const nl = netlistOf(d)!;
      expect(symbolOverlaps(nl), d.id).toEqual([]);
      expect(labelOverlaps(d, nl), d.id).toEqual([]);
      expect(wireOverlaps(routeNetlist(d, nl).nets), d.id).toEqual([]);
    }
    void pcieLane; void pcieEpTl; void pcieRootTl;
  });
});

describe('the port alone', () => {
  it('random symbols, well formed and not: every output every clock', async () => {
    const r = lcg(2026), s = simulate(pciePort()), m = new PciePort();
    set(s, { ...toGates({ ...PORT_IN0, rst: 1 }), clk: 0 }); edge(s); m.step({ ...PORT_IN0, rst: 1 });
    let n = 0;
    const feed = async (d: number, k: number) => {
      const i: PortIn = { ...PORT_IN0, rxd: d, rxk: k, r_ready: r(2) };
      set(s, toGates(i));
      comparePort(s, m, i, `clock ${n}`);
      edge(s); m.step(i); n++;
      if (n % 256 === 0) await yieldTick();
    };
    // training: TS1, TS2, idle
    const ts = async (id: number, c: number) => { for (let t = 0; t < c; t++) for (const [d, k] of [[0xbc, 1], [0xf7, 1], [0xf7, 1], [0x10, 0], [2, 0], [0, 0], ...Array.from({ length: 10 }, () => [id, 0])] as [number, number][]) await feed(d, k); };
    await ts(0x4a, 20); await ts(0x45, 20);
    for (let k = 0; k < 40; k++) await feed(0, 0);
    expect(m.lt).toBe(4);
    const pkt = async (syms: { d: number; k: number }[]) => { for (const x of syms) await feed(x.d, x.k); await feed(0, 0); };
    for (const c of [0x40, 0x50, 0x60, 0xc0, 0xd0, 0xe0]) await pkt(dllpSymbols(c, c === 0x40 || c === 0xc0 ? (8 << 14) | 32 : c === 0x50 || c === 0xd0 ? 8 << 14 : 0));
    for (let k = 0; k < 40; k++) await feed(0, 0);
    expect(m.dl).toBe(3);
    // TLPs in order, repeated, out of order, damaged; Acks and Naks; random noise in the middle
    let seq = 0;
    for (let t = 0; t < 120; t++) {
      const body = tlpBytes({ kind: 'MWr', len: 1 + r(4), tag: t & 31, addr: r(256) * 4, data: [] });
      const payload = Array.from({ length: (((body[3]) & 31)) * 4 }, () => r(256));
      const syms = tlpSymbols(seq & 0xfff, [...body, ...payload]);
      const c = r(10);
      if (c === 0) syms[3 + r(8)].d ^= 1 << r(8);                 // damaged
      if (c === 1) syms.splice(1, 2, ...tlpSymbols((seq + 2) & 0xfff, [...body, ...payload]).slice(1, 3)); // out of order, LCRC wrong too
      if (c === 2) { await pkt(tlpSymbols((seq - 1) & 0xfff, [...body, ...payload])); } // a duplicate
      if (c === 3) { syms[syms.length - 1] = { d: 0xfe, k: 1 }; }     // nullified
      if (c === 4) { for (let k = 0; k < 20; k++) await feed(r(256), r(8) === 0 ? 1 : 0); await pkt([{ d: 0xfd, k: 1 }]); }
      await pkt(syms);
      seq = m.nextRcv;
      if (r(3) === 0) await pkt(dllpSymbols(r(2) ? DLLP_ACK : DLLP_NAK, r(4096)));
      if (t === 60) { for (let k = 0; k < 2200; k++) await feed(0, 0); } // the FC timer and whatever else counts
    }
    expect(n).toBeGreaterThan(3000);
  }, 120000);
});

describe('the link, gates against the model', () => {
  it('training, flow control, writes and reads of every length', async () => {
    const l = new Lock();
    while (l.m.a.dl !== 3 || l.m.b.dl !== 3) { l.step(); if (l.n > 4000) throw new Error('no link'); if (l.n % 256 === 0) await yieldTick(); }
    for (const len of [1, 2, 3, 4, 5, 8, 15, 16]) {
      await l.cmd({ wr: 1, addr: 8 * len, len, seed: len * 3 });
      await l.cmd({ wr: 0, addr: 8 * len, len });
    }
    await l.run(1500);
    expect(l.m.ra.tag).toBe(16);
    expect(l.m.a.ackd).toBe(15);
    expect(statusOf(l.s, 'a_status').ackd).toBe(15);
  }, 120000);
  it('flips in both directions at every kind of symbol; replays and Recovery', async () => {
    const l = new Lock(), r = lcg(7);
    await l.run(1400);
    expect(l.m.a.dl).toBe(3);
    for (let t = 0; t < 40; t++) {
      await l.cmd({ wr: r(2), addr: r(200), len: 1 + r(16), seed: r(256) });
      for (let k = 0; k < 60; k++) l.step({ flip_ab: r(16) === 0 ? 1 : 0, flip_ba: r(16) === 0 ? 1 : 0 });
      await yieldTick();
    }
    await l.run(1000);
    // a burst long enough to roll REPLAY_NUM
    await l.cmd({ wr: 1, addr: 1, len: 2, seed: 5 });
    await l.run(4000, { flip_ab: 1 });
    await l.run(3000);
    expect(l.m.a.lt).toBe(4); expect(l.m.b.lt).toBe(4);
  }, 180000);
  it('unplugged and plugged again, mid-transfer', async () => {
    const l = new Lock();
    await l.run(1400);
    await l.cmd({ wr: 1, addr: 3, len: 16, seed: 1 });
    await l.run(10);
    await l.run(50, { plug: 0 });
    await l.run(1400);
    expect(l.m.a.dl).toBe(3);
  }, 120000);
  it('runs on the cycle engine too, with the same outputs', async () => {
    const fast = new DualSim(flatten(pcieLink())), slow = simulate(pcieLink());
    fast.preferFast = true; fast.prepare();
    const both = (v: Record<string, number>) => { set(fast, v); set(slow, v); };
    both({ rst: 1, plug: 1, go: 0, wr: 0, addr: 0, len: 1, seed: 0, flip_ab: 0, flip_ba: 0, clk: 0 });
    both({ clk: 1 }); both({ clk: 0 }); both({ rst: 0 });
    for (let k = 0; k < 1700; k++) {
      if (k === 1400) both({ go: 1, wr: 1, addr: 3, len: 4, seed: 7 });
      if (k === 1401) both({ go: 0 });
      both({ clk: 1 }); both({ clk: 0 });
      for (const n of ['a_txd', 'b_txd']) if (out(fast, n) !== out(slow, n)) throw new Error(`clock ${k}: ${n}`);
      for (const n of ['a_status', 'b_status']) if (statusOf(fast as unknown as Gate, n).seq !== statusOf(slow, n).seq) throw new Error(`clock ${k}: ${n}`);
      if (k % 200 === 0) await yieldTick();
    }
    expect(fast.whyNot).toBe('');
    expect(fast.engine).toBe('cycle');
    expect(statusOf(slow, 'a_status').ackd).toBe(0);
  }, 120000);
});
