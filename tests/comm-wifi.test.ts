// The DCF against what can be said of it without it: airtimes by the formula, Bianchi's closed form on throughput, a hidden pair colliding and RTS / CTS curing it; then the gates against the model, every output every clock.
import { describe, expect, it } from 'vitest';
import { ACK_US, Air, airtimeUs, bianchi, CW_MAX, CW_MIN, DIFS_US, DcfStation, KIND_ACK, lfsrNext, measureThroughput, RESP_TIMEOUT, RTS_US, SIFS_US, SLOT_US, STA_IN0, type AirOpts, type StaIn, W_BO, W_TX, W_WAIT } from '../src/comm/wifi';
import { dcfStation, wifiCell } from '../src/lib/wifi';
import { simulate } from '../src/sim/harness';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { lcg, out, set } from './util';
import { tick as yieldTick } from './yieldtick';

describe('802.11a numbers', () => {
  it('slot, SIFS and DIFS', () => {
    expect([SLOT_US, SIFS_US, DIFS_US]).toEqual([9, 16, 34]);
    expect([CW_MIN, CW_MAX]).toEqual([15, 1023]);
  });
  it('airtime: 1500 bytes at 54 Mb/s, ACK at 24 Mb/s', () => {
    expect(airtimeUs(1500, 216)).toBe(20 + 4 * Math.ceil(12022 / 216));
    expect(airtimeUs(1500, 216)).toBe(244);
    expect(ACK_US).toBe(28);
    expect(RTS_US).toBe(28);
  });
  it('the LFSR has period 1023', () => {
    let q = 1, n = 0;
    do { q = lfsrNext(q); n++; } while (q !== 1 && n < 5000);
    expect(n).toBe(1023);
  });
});

describe('the DCF alone', () => {
  const run = (f: (s: DcfStation, c: number) => Partial<StaIn>, n: number) => {
    const s = new DcfStation(), log: number[] = [];
    s.step({ ...STA_IN0, rst: 1, seed: 5 });
    for (let c = 0; c < n; c++) { log.push(s.st); s.step({ ...STA_IN0, ...f(s, c) }); }
    return { s, log };
  };
  it('waits DIFS, counts its backoff in slots, then sends', () => {
    const { log, s } = run(() => ({ pending: 1, len: 100 }), 34 + 1 + 15 * 9 + 2);
    const firstBo = log.indexOf(W_BO), firstTx = log.indexOf(W_TX);
    expect(firstBo).toBe(35);
    expect((firstTx - firstBo) % SLOT_US).toBeLessThanOrEqual(1);
    expect(firstTx).toBeGreaterThan(firstBo - 1);
    expect(s.cw).toBe(CW_MIN);
  });
  it('freezes when the medium goes busy, keeps the count, and waits DIFS again', () => {
    const s = new DcfStation();
    s.step({ ...STA_IN0, rst: 1, seed: 1021 });
    const i = { ...STA_IN0, pending: 1, len: 100 };
    while (s.st !== W_BO || s.bo < 2 || s.cnt !== 3) { s.step(i); if (s.st === W_TX) throw new Error('drew no backoff'); }
    const b = s.bo;
    s.step({ ...i, busy: 1 });
    expect(s.st).toBe(1);
    for (let k = 0; k < 50; k++) s.step({ ...i, busy: 1 });
    expect(s.bo).toBe(b);
    for (let k = 0; k < DIFS_US; k++) s.step(i);
    expect(s.st).toBe(W_BO);
    expect(s.bo).toBe(b);
  });
  it('no ACK: the contention window doubles up to its limit, the frame is dropped after 7 tries', () => {
    const s = new DcfStation(), seen: number[] = [];
    s.step({ ...STA_IN0, rst: 1, seed: 3 });
    let drops = 0, last = -1;
    for (let c = 0; c < 200000 && !drops; c++) {
      const i = { ...STA_IN0, pending: 1, len: 50 };
      if (s.cw !== last) { seen.push(s.cw); last = s.cw; }
      if (s.pulses(i).drop) drops++;
      s.step(i);
    }
    expect(drops).toBe(1);
    expect(seen).toEqual([15, 31, 63, 127, 255, 511, 1023]);
    expect(s.cw).toBe(15);
  });
  it('answers data with an ACK exactly SIFS after it ended', () => {
    const s = new DcfStation();
    s.step({ ...STA_IN0, rst: 1, seed: 3 });
    s.step({ ...STA_IN0, rx_data: 1 });
    for (let k = 0; k < SIFS_US; k++) { expect(s.out().tx).toBe(0); s.step(STA_IN0); }
    expect(s.out().kind).toBe(KIND_ACK);
    for (let k = 0; k < ACK_US; k++) { expect(s.out().tx).toBe(1); s.step(STA_IN0); }
    expect(s.out().tx).toBe(0);
  });
  it('a NAV holds it off although the air is quiet', () => {
    const s = new DcfStation();
    s.step({ ...STA_IN0, rst: 1, seed: 3 });
    s.step({ ...STA_IN0, nav_load: 1, nav_val: 500 });
    const i = { ...STA_IN0, pending: 1, len: 50 };
    let c = 0;
    while (s.st !== W_BO && c < 2000) { s.step(i); c++; }
    expect(c).toBeGreaterThanOrEqual(499 + DIFS_US);
    expect(s.cnt).toBeLessThan(2);
  });
});

describe('the air', () => {
  it('a single sender: data, SIFS, ACK, no retries, and the frames take the airtime they should', () => {
    const len = airtimeUs(1500, 216);
    const air = new Air({ n: 2, hears: () => true, lenUs: len, useRts: false, dest: (i) => 1 - i, saturated: [true, false] });
    for (let c = 0; c < 100000; c++) air.step();
    const del = air.stats.delivered[0];
    expect(air.stats.dropped[0]).toBe(0);
    expect(air.stats.sent[0]).toBe(del + (air.sta[0].st === W_WAIT || air.sta[0].st === W_TX ? 1 : 0));
    // a cycle is at least the exchange and DIFS, on average half of CWmin slots more (with a little bookkeeping)
    const per = 100000 / del, expected = len + SIFS_US + ACK_US + DIFS_US + 7.5 * SLOT_US;
    expect(per / expected).toBeGreaterThan(0.98); expect(per / expected).toBeLessThan(1.06);
    expect(air.stats.collisions).toBe(0);
  });
  it('throughput against Bianchi\'s closed form', async () => {
    const len = airtimeUs(1500, 216);
    for (const n of [2, 5, 10, 20]) {
      const m = measureThroughput(n, len, 600000), t = bianchi(n, len);
      expect(m.share / t.throughput, `n=${n}`).toBeGreaterThan(0.9);
      expect(m.share / t.throughput, `n=${n}`).toBeLessThan(1.1);
      await yieldTick();
    }
  }, 120000);
  it('Bianchi: more stations, more collisions, and the share falls; RTS / CTS costs little at many stations and a long frame', () => {
    const len = 2000;
    const a = bianchi(2, len), b = bianchi(50, len);
    expect(b.p).toBeGreaterThan(a.p); expect(b.throughput).toBeLessThan(a.throughput);
    expect(bianchi(50, len, true).throughput).toBeGreaterThan(b.throughput);
    expect(bianchi(2, 50, true).throughput).toBeLessThan(bianchi(2, 50).throughput);
  });
  const hidden = (useRts: boolean): AirOpts => ({
    n: 3, lenUs: 1500, useRts, dest: () => 1, saturated: [true, false, true], seeds: [101, 3, 300],
    hears: (i, j) => !((i === 0 && j === 2) || (i === 2 && j === 0)),
  });
  it('a hidden pair: most frames collide at the access point; RTS / CTS cures it', async () => {
    const a = new Air(hidden(false)), b = new Air(hidden(true));
    for (let c = 0; c < 1000000; c++) { a.step(); b.step(); if (c % 100000 === 0) await yieldTick(); }
    const dA = a.stats.delivered[0] + a.stats.delivered[2], dB = b.stats.delivered[0] + b.stats.delivered[2];
    expect(dB).toBeGreaterThan(3 * dA);
    expect(a.stats.dropped[0] + a.stats.dropped[2]).toBeGreaterThan(0);
    const fair = Math.min(b.stats.delivered[0], b.stats.delivered[2]) / Math.max(b.stats.delivered[0], b.stats.delivered[2]);
    expect(fair).toBeGreaterThan(0.5);
  }, 120000);
  it('RESP_TIMEOUT leaves room for the SIFS and the ACK', () => {
    expect(RESP_TIMEOUT).toBeGreaterThan(SIFS_US + ACK_US);
  });
});

const OUT = ['tx', 'kind', 'st', 'bo', 'cw', 'retry', 'nav', 'cnt'] as const;
type G = ReturnType<typeof simulate>;
const edge = (s: G) => { set(s, { clk: 1 }); set(s, { clk: 0 }); };

describe('the gates', () => {
  it('one station on random inputs: every output every clock', async () => {
    const s = simulate(dcfStation()), m = new DcfStation(), r = lcg(9);
    const toIn = (i: StaIn) => ({ rst: i.rst, seed: i.seed, pending: i.pending, len: i.len, use_rts: i.use_rts, busy: i.busy, rx_data: i.rx_data, rx_ack: i.rx_ack, rx_rts: i.rx_rts, rx_cts: i.rx_cts, nav_load: i.nav_load, nav_val: i.nav_val });
    set(s, { ...toIn({ ...STA_IN0, rst: 1, seed: 0 }), clk: 0 }); edge(s); m.step({ ...STA_IN0, rst: 1, seed: 0 });
    expect(out(s, 'cw')).toBe(15);
    for (let c = 0; c < 60000; c++) {
      const w = (n: number) => (r(n) === 0 ? 1 : 0), rts = (c >> 12) & 1;
      const i: StaIn = { ...STA_IN0, seed: 0, pending: (c >> 10) & 1 ? 1 : w(3), len: 20 + (c >> 9) % 40, use_rts: rts, busy: (c >> 7) % 4 === 0 ? 1 : w(50), rx_data: w(800), rx_ack: w(60), rx_rts: w(800), rx_cts: w(60), nav_load: w(600), nav_val: r(300) };
      set(s, toIn(i));
      const o = m.out() as unknown as Record<string, number>;
      for (const n of OUT) if (out(s, n) !== o[n]) throw new Error(`clock ${c}: ${n} gates ${out(s, n)} model ${o[n]}`);
      const p = m.pulses(i);
      if (out(s, 'done') !== p.done || out(s, 'drop') !== p.drop) throw new Error(`clock ${c}: pulses`);
      edge(s); m.step(i);
      if (c % 2000 === 0) await yieldTick();
    }
  }, 120000);
  it('a cell in gates on the air model: the same frames as the model stations', async () => {
    const opts: AirOpts = { n: 3, lenUs: 120, useRts: false, dest: () => 1, saturated: [true, false, true], hears: () => true, seeds: [11, 22, 33] };
    const s = simulate(wifiCell(3)), air = new Air(opts), ref = new Air(opts);
    const g: Record<string, number> = { clk: 0, rst: 1, len: opts.lenUs, use_rts: 0 };
    for (let i = 0; i < 3; i++) Object.assign(g, { [`seed${i}`]: opts.seeds![i], [`pending${i}`]: 0, [`busy${i}`]: 0, [`rx_data${i}`]: 0, [`rx_ack${i}`]: 0, [`rx_rts${i}`]: 0, [`rx_cts${i}`]: 0, [`nav_load${i}`]: 0, [`nav_val${i}`]: 0 });
    set(s, g); edge(s); set(s, { rst: 0 });
    for (let c = 0; c < 40000; c++) {
      const outs = [0, 1, 2].map((i) => ({ tx: out(s, `tx${i}`), kind: out(s, `kind${i}`) }));
      const ins = air.compute(outs), v: Record<string, number> = {};
      ins.forEach((x, i) => Object.assign(v, { [`pending${i}`]: x.pending, [`busy${i}`]: x.busy, [`rx_data${i}`]: x.rx_data, [`rx_ack${i}`]: x.rx_ack, [`rx_rts${i}`]: x.rx_rts, [`rx_cts${i}`]: x.rx_cts, [`nav_load${i}`]: x.nav_load, [`nav_val${i}`]: x.nav_val }));
      set(s, v);
      air.account(outs, [0, 1, 2].map((i) => ({ done: out(s, `done${i}`), drop: out(s, `drop${i}`) })));
      edge(s); ref.step();
      if (c % 2000 === 0) await yieldTick();
    }
    expect(air.stats.delivered).toEqual(ref.stats.delivered);
    expect(air.stats.delivered[0]).toBeGreaterThan(10);
  }, 120000);
  it('the drawings route with no overlaps', () => {
    for (const d of [dcfStation(), wifiCell(4), ...netlistOf(dcfStation())!.instances.map((i) => i.def).filter((x) => x.id.startsWith('wifi_'))]) {
      const nl = netlistOf(d)!;
      expect(symbolOverlaps(nl), d.id).toEqual([]);
      expect(labelOverlaps(d, nl), d.id).toEqual([]);
      expect(wireOverlaps(routeNetlist(d, nl).nets), d.id).toEqual([]);
    }
  });
});
