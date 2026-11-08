// The DCF against what can be said of it without it: airtimes by the formula, Bianchi's closed form on throughput, a hidden pair colliding and RTS / CTS curing it; then the gates against the model, every output every clock.
import { describe, expect, it } from 'vitest';
import { Clarke } from '../src/phys/radio';
import { rng } from '../src/phys/line';
import { aggregateMbps, capacity2x2, eigen2x2, goodputMbps, RATES, rateRun, ACK_US, Air, airtimeUs, bianchi, CW_MAX, CW_MIN, DIFS_US, DcfStation, KIND_ACK, lfsrNext, measureThroughput, RESP_TIMEOUT, RTS_US, SIFS_US, SLOT_US, STA_IN0, type AirOpts, type StaIn, W_BO, W_TX, W_WAIT } from '../src/comm/wifi';
import { dcfStation, wifiCell } from '../src/lib/wifi';
import { hiddenCompare } from '../src/widgets/wifi';
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
  it('on the air, an ACK starts exactly SIFS after the data ended, and a CTS and its data too', () => {
    for (const useRts of [false, true]) {
      const air = new Air({ n: 2, hears: () => true, lenUs: 100, useRts, dest: () => 1, saturated: [true, false] });
      let silent = -1, gaps = 0;
      for (let c = 0; c < 4000; c++) {
        const talking = air.sta.some((x) => x.out().tx === 1);
        if (talking) { if (silent >= 0 && silent < 30) { expect(silent).toBe(SIFS_US); gaps++; } silent = -1; } else if (silent >= 0) silent++;
        const was = air.sta.map((x) => x.out());
        air.step();
        if (was.some((x) => x.tx) && !air.sta.some((x) => x.out().tx === 1)) silent = 0;
      }
      expect(gaps).toBeGreaterThan(5);
    }
  });
  it('answers data with an ACK of its full length', () => {
    const s = new DcfStation();
    s.step({ ...STA_IN0, rst: 1, seed: 3 });
    s.step({ ...STA_IN0, rx_data: 1 });
    for (let k = 0; k < SIFS_US - 1; k++) { expect(s.out().tx).toBe(0); s.step(STA_IN0); }
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
    expect(air.stats.overlapUs).toBe(0);
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
  it('the share of the air with 1500-byte frames: a lone sender pays its whole backoff, so a few stations do better than one before the share falls (the chapter says so)', () => {
    const len = airtimeUs(1500, 216);
    expect(bianchi(1, len).throughput).toBeLessThan(bianchi(2, len).throughput);
    expect(bianchi(2, len).throughput).toBeGreaterThan(bianchi(20, len).throughput);
    expect(bianchi(20, len).throughput).toBeGreaterThan(0.4);
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
    expect(fair).toBeGreaterThan(0.35);   // fairness only comes over long runs: the prose says so
  }, 120000);
  it('the chapter\'s comparison: RTS / CTS delivers far more for the hidden pair', () => {
    const h = hiddenCompare();
    expect(h.rts).toBeGreaterThan(2 * h.plain);
    expect(h.plainDropped).toBeGreaterThan(0);
  });
  it('RESP_TIMEOUT leaves room for the SIFS and the ACK', () => {
    expect(RESP_TIMEOUT).toBeGreaterThan(SIFS_US + ACK_US);
  });
});

describe('rates, airtime, MIMO', () => {
  it('a 1500-byte exchange at 54 Mb/s has a goodput far under 54, and aggregation recovers it', () => {
    const r = RATES[7], g = goodputMbps(1500, r);
    expect(g).toBeGreaterThan(25); expect(g).toBeLessThan(35);
    expect(aggregateMbps(1500, 32, r)).toBeGreaterThan(45);
    expect(aggregateMbps(1500, 1, r)).toBeLessThan(g * 1.05);
  });
  it('rate adaptation: better than the wrong static rate, worse than an oracle', () => {
    const g = new Clarke(20, 3), rnd = rng(5), snr = (us: number) => { const c = g.at(us * 1e-6); return 22 + 20 * Math.log10(Math.max(1e-3, Math.hypot(c.re, c.im))); };
    const T = 5e6, arf = rateRun('arf', snr, rnd, 1500, T).mbps, oracle = rateRun('oracle', snr, rnd, 1500, T).mbps, stat = RATES.map((_, i) => rateRun(i, snr, rnd, 1500, T).mbps);
    expect(oracle).toBeGreaterThan(arf);
    expect(arf).toBeGreaterThan(stat[0]);
    expect(arf).toBeGreaterThan(stat[7]);
    expect(oracle).toBeGreaterThan(Math.max(...stat));
  });
  it('MIMO: eigenvalues of known channels; two streams at high SNR, one on a rank-1 channel', () => {
    const I: [number, number][] = [[1, 0], [0, 0], [0, 0], [1, 0]], one: [number, number][] = [[1, 0], [1, 0], [1, 0], [1, 0]];
    expect(eigen2x2(I)).toEqual([1, 1]);
    expect(eigen2x2(one)[0]).toBeCloseTo(4, 9); expect(eigen2x2(one)[1]).toBeCloseTo(0, 9);
    expect(capacity2x2(I, 100)).toBeCloseTo(2 * Math.log2(1 + 50), 9);
    expect(capacity2x2(one, 100)).toBeCloseTo(Math.log2(1 + 200), 9);
    expect(capacity2x2(I, 2000) - capacity2x2(I, 1000)).toBeCloseTo(2, 2);
    expect(capacity2x2(one, 2000) - capacity2x2(one, 1000)).toBeCloseTo(1, 2);
    // a random H against a direct determinant: log₂ det(I + (SNR/2) H Hᴴ)
    const h: [number, number][] = [[0.3, 0.1], [-0.7, 0.4], [1.1, -0.2], [0.2, 0.9]], k = 5;
    const n = (z: [number, number]) => z[0] * z[0] + z[1] * z[1];
    const p11 = 1 + k * (n(h[0]) + n(h[1])), p22 = 1 + k * (n(h[2]) + n(h[3]));
    const xr = h[0][0] * h[2][0] + h[0][1] * h[2][1] + h[1][0] * h[3][0] + h[1][1] * h[3][1], xi = h[0][1] * h[2][0] - h[0][0] * h[2][1] + h[1][1] * h[3][0] - h[1][0] * h[3][1];
    expect(capacity2x2(h, 2 * k)).toBeCloseTo(Math.log2(p11 * p22 - k * k * (xr * xr + xi * xi)), 8);
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
    // each stretch aims at part of the machine, and the end says that it got there
    const trans = new Set<string>();
    let drops = 0, dones = 0, cwMax = 0, retryMax = 0;
    for (let c = 0; c < 240000; c++) {
      const w = (n: number) => (r(n) === 0 ? 1 : 0), stretch = (c >> 15) & 3, rts = (c >> 17) & 1;
      const noAnswers = stretch === 1, quietIn = stretch === 2;
      const i: StaIn = {
        ...STA_IN0, seed: 0, pending: quietIn ? 0 : 1, len: 20 + (c >> 9) % 40, use_rts: rts,
        busy: noAnswers ? 0 : (c >> 7) % 4 === 0 ? 1 : w(50),
        rx_data: quietIn ? w(150) : w(800), rx_ack: noAnswers ? 0 : w(60), rx_rts: quietIn ? w(150) : w(800), rx_cts: noAnswers ? 0 : w(60), nav_load: noAnswers ? 0 : w(600), nav_val: r(300),
      };
      set(s, toIn(i));
      const o = m.out() as unknown as Record<string, number>;
      for (const n of OUT) if (out(s, n) !== o[n]) throw new Error(`clock ${c}: ${n} gates ${out(s, n)} model ${o[n]}`);
      const p = m.pulses(i);
      if (out(s, 'done') !== p.done || out(s, 'drop') !== p.drop) throw new Error(`clock ${c}: pulses`);
      drops += p.drop; dones += p.done; cwMax = Math.max(cwMax, m.cw); retryMax = Math.max(retryMax, m.retry);
      const was = m.st;
      edge(s); m.step(i);
      if (m.st !== was) trans.add(`${was}>${m.st}`);
      if (c % 2000 === 0) await yieldTick();
    }
    expect(drops).toBeGreaterThan(0); expect(dones).toBeGreaterThan(10);
    expect(cwMax).toBe(1023); expect(retryMax).toBe(6);
    for (const x of ['0>1', '0>5', '1>2', '1>5', '2>1', '2>3', '2>7', '2>5', '3>4', '4>0', '4>1', '5>6', '6>0', '6>1', '7>8', '8>9', '8>1', '8>0', '9>3']) expect(trans.has(x), x).toBe(true);
  }, 180000);
  it('a cell in gates on the air model: all outputs of every station every clock, open and hidden, with and without RTS', async () => {
    for (const [hidden, useRts] of [[false, false], [true, false], [true, true]] as const) {
      const opts: AirOpts = { n: 3, lenUs: 120, useRts, dest: () => 1, saturated: [true, false, true], seeds: [11, 22, 33], hears: (i, j) => !hidden || !((i === 0 && j === 2) || (i === 2 && j === 0)) };
      const s = simulate(wifiCell(3)), air = new Air(opts), ref = new Air(opts);
      const g: Record<string, number> = { clk: 0, rst: 1, len: opts.lenUs, use_rts: useRts ? 1 : 0 };
      for (let i = 0; i < 3; i++) Object.assign(g, { [`seed${i}`]: opts.seeds![i], [`pending${i}`]: 0, [`busy${i}`]: 0, [`rx_data${i}`]: 0, [`rx_ack${i}`]: 0, [`rx_rts${i}`]: 0, [`rx_cts${i}`]: 0, [`nav_load${i}`]: 0, [`nav_val${i}`]: 0 });
      set(s, g); edge(s); set(s, { rst: 0 });
      for (let c = 0; c < 30000; c++) {
        const outs = [0, 1, 2].map((i) => ({ tx: out(s, `tx${i}`), kind: out(s, `kind${i}`) }));
        ref.sta.forEach((m, i) => { const o = m.out() as unknown as Record<string, number>; for (const n of OUT) if (out(s, `${n}${i}`) !== o[n]) throw new Error(`clock ${c} station ${i}: ${n}`); });
        const ins = air.compute(outs), v: Record<string, number> = {};
        ins.forEach((x, i) => Object.assign(v, { [`pending${i}`]: x.pending, [`busy${i}`]: x.busy, [`rx_data${i}`]: x.rx_data, [`rx_ack${i}`]: x.rx_ack, [`rx_rts${i}`]: x.rx_rts, [`rx_cts${i}`]: x.rx_cts, [`nav_load${i}`]: x.nav_load, [`nav_val${i}`]: x.nav_val }));
        set(s, v);
        air.account(outs, [0, 1, 2].map((i) => ({ done: out(s, `done${i}`), drop: out(s, `drop${i}`) })));
        edge(s); ref.step();
        if (c % 2000 === 0) await yieldTick();
      }
      expect(air.stats.delivered).toEqual(ref.stats.delivered);
      expect(air.stats.delivered[0] + air.stats.delivered[2]).toBeGreaterThan(10);
    }
  }, 180000);
  it('the drawings route with no overlaps', () => {
    for (const d of [dcfStation(), wifiCell(4), ...netlistOf(dcfStation())!.instances.map((i) => i.def).filter((x) => x.id.startsWith('wifi_'))]) {
      const nl = netlistOf(d)!;
      expect(symbolOverlaps(nl), d.id).toEqual([]);
      expect(labelOverlaps(d, nl), d.id).toEqual([]);
      expect(wireOverlaps(routeNetlist(d, nl).nets), d.id).toEqual([]);
    }
  });
});
