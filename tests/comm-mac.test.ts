// Chapter 48's Ethernet MAC: the gate-level transmitter and receiver against the models of comm/mac.ts, every output after
// every clock; the bytes on the wire against comm/ethframe.ts; the shared wire, the station and the segment.

import { describe, expect, it } from 'vitest';
import { BIT_CLOCKS, captureRecord, GAP_CLOCKS, MacRx, MacTx, Segment, Station, type StationIn, WHY_ADDR, WHY_FCS, WHY_LONG, WHY_RUNT, type RxIn, type TxIn } from '../src/comm/mac';
import { frameBody, frameBytes, parseFrame, wireBytes, type FrameSpec } from '../src/comm/ethframe';
import { pcapFile, readPcap } from '../src/comm/pcap';
import { ethSegment, macRx, macTx, SEG_POSITIONS, STATION_SEEDS, stationMac } from '../src/lib/ethernet';
import { simulate } from '../src/sim/harness';
import { lcg, out, set } from './util';
import { tick as yieldTick } from './yieldtick';

type Gate = ReturnType<typeof simulate>;
const tickClk = (s: Gate) => { set(s, { clk: 1 }); set(s, { clk: 0 }); };
const TX_OUT = ['ready', 'txd', 'txen', 'restart', 'drop', 'sent', 'state', 'att', 'backoff', 'gap'] as const;
const txOut = (m: MacTx): Record<(typeof TX_OUT)[number], number> => ({ ready: m.ready, txd: m.txd, txen: m.txen, restart: m.restart, drop: m.drop, sent: m.sent, state: m.state, att: m.att, backoff: m.bo, gap: m.gap });
const RX_OUT = ['data', 'valid', 'last', 'err', 'why', 'drop', 'state'] as const;
const rxOut = (m: MacRx): Record<(typeof RX_OUT)[number], number> => ({ data: m.data, valid: m.valid, last: m.last, err: m.err, why: m.why, drop: m.drop, state: m.state });

const MAC_A = [2, 0, 0, 0, 0, 1], MAC_B = [2, 0, 0, 0, 0, 2];
const addrBus = (a: readonly number[]) => a.reduce((v, b, j) => v + b * 2 ** (8 * j), 0);
const spec = (payload: number, dst = MAC_B, src = MAC_A): FrameSpec => ({ dst, src, type: 0x0800, payload: Array.from({ length: payload }, (_, i) => (i * 7 + 3) & 0xff) });

/** The line as the receiver sees it: idle, then the bytes' bits (LSB first, BIT_CLOCKS clocks each) with the carrier up. */
function lineOf(bytes: number[], lead = 9, tail = 30, flip = -1): { rxd: number[]; crs: number[] } {
  const rxd: number[] = Array(lead).fill(0), crs: number[] = Array(lead).fill(0);
  let n = 0;
  for (const b of bytes) for (let k = 0; k < 8; k++, n++) {
    const v = ((b >> k) & 1) ^ (n === flip ? 1 : 0);
    for (let c = 0; c < BIT_CLOCKS; c++) { rxd.push(v); crs.push(1); }
  }
  for (let c = 0; c < tail; c++) { rxd.push(0); crs.push(0); }
  return { rxd, crs };
}

interface Got { bytes: number[]; last: number; err: number; why: number }
function receive(line: { rxd: number[]; crs: number[] }, addr: readonly number[], promisc = 0, ready = 1): Got[] {
  const m = new MacRx(), got: Got[] = [];
  let cur: number[] = [];
  m.step({ rst: 1, rxd: 0, crs: 0, ready: 1, promisc, addr });
  for (let c = 0; c < line.rxd.length; c++) {
    m.step({ rst: 0, rxd: line.rxd[c], crs: line.crs[c], ready, promisc, addr });
    if (m.valid) { cur.push(m.data); if (m.last) { got.push({ bytes: cur, last: 1, err: m.err, why: m.why }); cur = []; } }
  }
  return got;
}

describe('MAC receiver model', () => {
  it('delivers destination to pad without preamble, SFD and FCS, last on the final byte, err 0 for a good frame', () => {
    for (const n of [0, 1, 18, 46, 47, 200, 1500]) {
      const f = spec(n);
      const g = receive(lineOf(wireBytes(f)), MAC_B);
      expect(g, `payload ${n}`).toHaveLength(1);
      expect(g[0].bytes).toEqual(frameBody(f));
      expect([g[0].err, g[0].why]).toEqual([0, 0]);
    }
  });
  it('a flipped bit anywhere in the frame fails the FCS; a wrong address, a runt and an overlong frame are reported', () => {
    const f = spec(30), w = wireBytes(f);
    for (const flip of [64, 100, 8 * 20 + 3, 8 * w.length - 1]) {
      const g = receive(lineOf(w, 9, 30, flip), MAC_B);
      expect(g[0].why & WHY_FCS, `flip ${flip}`).toBe(WHY_FCS);
      expect(g[0].err).toBe(1);
    }
    const other = receive(lineOf(wireBytes(spec(30, [2, 0, 0, 0, 0, 9]))), MAC_B);
    expect(other[0].why).toBe(WHY_ADDR);
    expect(receive(lineOf(wireBytes(spec(30, [2, 0, 0, 0, 0, 9]))), MAC_B, 1)[0].err).toBe(0);
    expect(receive(lineOf(wireBytes(spec(30, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))), MAC_B)[0].err).toBe(0);
    expect(receive(lineOf(wireBytes(spec(30, [0x01, 0, 0x5e, 0, 0, 1]))), MAC_B)[0].err).toBe(0);
    const runt = receive(lineOf([...wireBytes(f).slice(0, 8), ...frameBytes(f).slice(0, 40)]), MAC_B);
    expect(runt[0].why & WHY_RUNT).toBe(WHY_RUNT);
    const long = new Array(1501).fill(1);
    const lw = [0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0xd5, ...f.dst, ...f.src, 8, 0, ...long, 0, 0, 0, 0];
    expect(receive(lineOf(lw), MAC_B)[0].why & WHY_LONG).toBe(WHY_LONG);
  });
  it('a consumer that is not ready loses the frame; a fragment with no SFD delivers nothing', () => {
    const g = receive(lineOf(wireBytes(spec(30))), MAC_B, 0, 0);
    expect(g[0].why & 16).toBe(16);
    expect(receive(lineOf(Array(20).fill(0x55)), MAC_B)).toHaveLength(0);
  });
  it('back-to-back frames with a short gap are both delivered', () => {
    const a = lineOf(wireBytes(spec(20)), 9, 24), b = lineOf(wireBytes(spec(50)), 0, 30);
    const g = receive({ rxd: [...a.rxd, ...b.rxd], crs: [...a.crs, ...b.crs] }, MAC_B);
    expect(g.map((x) => x.err)).toEqual([0, 0]);
    expect(g[1].bytes).toEqual(frameBody(spec(50)));
  });
});

describe('MAC receiver gates', () => {
  it('every output equals the model after every clock: good frames, flipped bits, runts, other addresses, glitches on crs', async () => {
    const gate = simulate(macRx());
    const model = new MacRx();
    const rnd = lcg(48);
    let line: { rxd: number[]; crs: number[] } = { rxd: [], crs: [] };
    const frames = [spec(0), spec(46), spec(100, [2, 0, 0, 0, 0, 7]), spec(20, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), spec(300)];
    frames.forEach((f, k) => {
      const w = wireBytes(f);
      const l = lineOf(k === 3 ? [...w.slice(0, 30)] : w, 5 + rnd(9), 20 + rnd(30), k === 1 ? 200 : -1);
      line = { rxd: [...line.rxd, ...l.rxd], crs: [...line.crs, ...l.crs] };
    });
    // noise: random carrier bursts with random bits
    for (let n = 0; n < 40; n++) for (let c = 0, len = 20 + rnd(60); c < len; c++) { line.rxd.push(rnd(2)); line.crs.push(rnd(5) === 0 ? 0 : 1); }
    for (let c = 0; c < 40; c++) { line.rxd.push(0); line.crs.push(0); }
    const addr = addrBus(MAC_B);
    set(gate, { rst: 1, rxd: 0, crs: 0, ready: 1, promisc: 0, addr });
    tickClk(gate); model.step({ rst: 1, rxd: 0, crs: 0, ready: 1, promisc: 0, addr: MAC_B });
    let valid = 0, errs = 0;
    for (let c = 0; c < line.rxd.length; c++) {
      const i: RxIn = { rst: 0, rxd: line.rxd[c], crs: line.crs[c], ready: rnd(97) === 0 ? 0 : 1, promisc: 0, addr: MAC_B };
      set(gate, { rst: 0, rxd: i.rxd, crs: i.crs, ready: i.ready, promisc: 0, addr });
      tickClk(gate); model.step(i);
      const o = rxOut(model);
      for (const k of RX_OUT) expect(out(gate, k), `${k} @${c}`).toBe(o[k]);
      if (o.valid) valid++;
      if (o.err) errs++;
      if (c % 400 === 0) await yieldTick();
    }
    expect(valid).toBeGreaterThan(300);
    expect(errs).toBeGreaterThan(0);
  });
});

/** A frame source for the transmitter: bytes with valid held, last on the final one. */
class Src {
  i = 0;
  constructor(public bytes: number[]) {}
  get valid(): number { return this.i < this.bytes.length ? 1 : 0; }
  get data(): number { return this.bytes[this.i] ?? 0; }
  get last(): number { return this.i === this.bytes.length - 1 ? 1 : 0; }
}

const bytesOf = (bits: number[]): number[] => {
  const sent: number[] = [];
  for (let k = 0; k + 8 <= bits.length; k += 8) sent.push(bits.slice(k, k + 8).reduce((v, b, j) => v | (b << j), 0));
  return sent;
};

/** Bits the model sends for one frame with a quiet cable. */
function transmit(f: FrameSpec): { sent: number[]; t0: number; t1: number } {
  const m = new MacTx(), src = new Src(frameBody(f));
  const seed = 0x155;
  m.step({ rst: 1, data: 0, valid: 0, last: 0, crs: 0, col: 0, seed });
  const bits: number[] = [];
  let t0 = -1, t1 = -1, run = 0;
  for (let c = 0; c < 60000 && t1 < 0; c++) {
    const inp: TxIn = { rst: 0, data: src.data, valid: src.valid, last: src.last, crs: 0, col: 0, seed };
    if (m.ready && src.valid) src.i++;
    if (m.txen) { if (t0 < 0) t0 = c; if (run % BIT_CLOCKS === 0) bits.push(m.txd); else expect(m.txd).toBe(bits[bits.length - 1]); run++; }
    m.step(inp);
    if (m.sent) t1 = c + 1;
  }
  return { sent: bytesOf(bits), t0, t1 };
}

describe('MAC transmitter model', () => {
  it('sends the bytes of ethframe.wireBytes, padded to 64, a bit every four clocks, after a 96-bit-time gap', () => {
    for (const n of [0, 5, 46, 47, 100, 1500]) {
      const f = spec(n), r = transmit(f), w = wireBytes(f);
      expect(r.sent, `payload ${n}`).toEqual(w);
      expect(r.t0).toBe(GAP_CLOCKS + 1);
      expect(r.t1 - r.t0).toBe(w.length * 8 * BIT_CLOCKS);
    }
  });
  it('an underrun (valid drops mid-frame) ends the frame: padded and checked like a short one', () => {
    const f = spec(100), body = frameBody(f);
    const m = new MacTx(), src = new Src(body.slice(0, 20));
    m.step({ rst: 1, data: 0, valid: 0, last: 0, crs: 0, col: 0, seed: 7 });
    const bits: number[] = [];
    let run = 0, done = false;
    for (let c = 0; c < 20000 && !done; c++) {
      const inp: TxIn = { rst: 0, data: src.data, valid: src.valid, last: 0, crs: 0, col: 0, seed: 7 };
      if (m.ready && src.valid) src.i++;
      if (m.txen) { if (run % 4 === 0) bits.push(m.txd); run++; }
      m.step(inp);
      done = m.sent === 1;
    }
    const got = receive(lineOf(bytesOf(bits)), MAC_B, 1);
    expect(got[0].err).toBe(0);
    expect(got[0].bytes.slice(0, 20)).toEqual(body.slice(0, 20));
    expect(got[0].bytes).toHaveLength(60);
  });
});

/** A copy of the model, advanced without disturbing it. */
const clone = (m: MacTx): MacTx => Object.assign(new MacTx(), m);

describe('MAC transmitter gates', () => {
  it('every output equals the model after every clock, with random valid / last / crs / col (collisions, jams, backoffs, drops)', async () => {
    const gate = simulate(macTx());
    const model = new MacTx();
    const rnd = lcg(480);
    const seed = 0x2b7;
    const I = (i: TxIn) => ({ rst: i.rst, data: i.data, valid: i.valid, last: i.last, crs: i.crs, col: i.col, seed: i.seed });
    const first: TxIn = { rst: 1, data: 0, valid: 0, last: 0, crs: 0, col: 0, seed };
    set(gate, I(first)); tickClk(gate); model.step(first);
    const body = frameBody(spec(80));
    const src = new Src(body);
    let sent = 0, restarts = 0, crsHold = 0, colHold = 0;
    const states = new Set<number>();
    for (let c = 0; c < 90000; c++) {
      if (rnd(3000) === 0 && crsHold === 0) crsHold = 1 + rnd(900);
      if (model.txen && !model.jam && rnd(300) === 0) {
        // a collision whose draw is small, so the test sees the backoff end
        const p = clone(model);
        p.step({ rst: 0, data: 0, valid: 1, last: 0, crs: 0, col: 1, seed });
        for (let n = 0; !p.restart && !p.drop && n < 300; n++) p.step({ rst: 0, data: 0, valid: 1, last: 0, crs: 0, col: 0, seed });
        if (p.restart && p.bo <= 2) colHold = 1 + rnd(3);
      }
      const inp: TxIn = { rst: c === 0 ? 0 : (rnd(30000) === 0 ? 1 : 0), data: src.data, valid: src.valid, last: src.last, crs: crsHold > 0 ? 1 : 0, col: colHold > 0 && model.txen ? 1 : 0, seed };
      if (crsHold > 0) crsHold--;
      if (colHold > 0) colHold--;
      if (model.ready && src.valid) src.i++;
      if (model.restart || model.sent || model.drop) src.i = 0;
      set(gate, I(inp)); tickClk(gate); model.step(inp);
      const o = txOut(model);
      for (const k of TX_OUT) expect(out(gate, k), `${k} @${c}`).toBe(o[k]);
      sent += model.sent; restarts += model.restart; states.add(model.state);
      if (c % 500 === 0) await yieldTick();
    }
    expect(sent).toBeGreaterThan(0);
    expect(restarts).toBeGreaterThan(2);
    expect([...states].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('MAC transmitter attempt limit', () => {
  it('sixteen collisions in a row drop the frame (the LFSR draws are steered to 0 so the test is short); gates equal the model throughout', async () => {
    const gate = simulate(macTx());
    const model = new MacTx();
    const seed = 0x0c3;
    const I = (i: TxIn) => ({ rst: i.rst, data: i.data, valid: i.valid, last: i.last, crs: i.crs, col: i.col, seed: i.seed });
    const first: TxIn = { rst: 1, data: 0, valid: 0, last: 0, crs: 0, col: 0, seed };
    set(gate, I(first)); tickClk(gate); model.step(first);
    const src = new Src(frameBody(spec(60)));
    const atts: number[] = [];
    let drops = 0, restarts = 0;
    for (let c = 0; c < 200000 && drops === 0; c++) {
      let col = 0;
      if (model.pre || model.dat || model.fcs) {
        // would a collision now give a draw of 0? run a copy through the jam
        const p = clone(model);
        p.step({ rst: 0, data: 0, valid: 1, last: 0, crs: 0, col: 1, seed });
        let n = 0;
        while (!p.restart && !p.drop && n++ < 300) p.step({ rst: 0, data: 0, valid: 1, last: 0, crs: 0, col: 0, seed });
        if ((p.restart && p.bo === 0) || p.drop) col = 1;
      }
      const inp: TxIn = { rst: 0, data: src.data, valid: src.valid, last: src.last, crs: 0, col, seed };
      if (model.ready && src.valid) src.i++;
      if (model.restart) { src.i = 0; atts.push(model.att); }
      if (model.sent || model.drop) src.i = 0;
      set(gate, I(inp)); tickClk(gate); model.step(inp);
      const o = txOut(model);
      for (const k of TX_OUT) expect(out(gate, k), `${k} @${c}`).toBe(o[k]);
      restarts += model.restart; drops += model.drop;
      if (c % 500 === 0) await yieldTick();
    }
    expect(drops).toBe(1);
    expect(restarts).toBe(15);
    expect(atts).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  }, 120000);
});

// ---- the segment: four stations on a cable, gates against the software segment ----------------------------------------

interface Op { sel: number; wa: number; wd: number; we: number; len: number; go: number }
const NOOP: Op = { sel: 0, wa: 0, wd: 0, we: 0, len: 0, go: 0 };

/** The host's cycles for loading a frame into station k and sending it: one write a clock, then go. */
function loadOps(k: number, bytes: number[]): Op[] {
  return [...bytes.map((b, i) => ({ ...NOOP, sel: k, wa: i, wd: b, we: 1 })), { ...NOOP, sel: k, len: bytes.length, go: 1 }];
}

function newSegment(promisc = [0, 0, 0, 0]): Segment {
  return new Segment(SEG_POSITIONS.map((_, i) => new Station(stationMac(i), STATION_SEEDS[i], promisc[i])), SEG_POSITIONS);
}

describe('segment', () => {
  it('four stations, a collision and a broadcast: every output of the gates equals the software segment after every clock; frames arrive intact', async () => {
    const gate = simulate(ethSegment(4));
    const seg = newSegment([0, 0, 0, 1]);
    const f01 = frameBody({ dst: stationMac(1), src: stationMac(0), type: 0x0800, payload: Array.from({ length: 50 }, (_, i) => i + 1) });
    const f10 = frameBody({ dst: stationMac(0), src: stationMac(1), type: 0x0806, payload: Array.from({ length: 10 }, (_, i) => 0xa0 + i) });
    const fb = frameBody({ dst: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], src: stationMac(2), type: 0x0800, payload: [9, 8, 7] });
    // both loads are queued first and go together: the stations start in the same clock and collide
    const ops: Op[] = [{ ...NOOP }, ...loadOps(0, f01).slice(0, -1), ...loadOps(1, f10).slice(0, -1), ...loadOps(2, fb).slice(0, -1),
      { ...NOOP, sel: 0, len: f01.length, go: 1 }, { ...NOOP, sel: 1, len: f10.length, go: 1 }];
    // station 2 goes later, while the others are busy: it defers
    const goLater = 9000;
    set(gate, { rst: 1, sel: 0, wa: 0, wd: 0, we: 0, len: 0, go: 0, ra: 0, hrd: 0, promisc: 8 });
    tickClk(gate); tickClk(gate);
    seg.step(seg.st.map(() => ({ rst: 1, go: 0, len: 0 }))); seg.step(seg.st.map(() => ({ rst: 1, go: 0, len: 0 })));
    const seen = { restart: 0, sent: 0, good: 0, bad: 0, clash: 0 };
    for (let c = 0; c < 60000; c++) {
      const op: Op = c < ops.length ? ops[c] : c === goLater ? { ...NOOP, sel: 2, len: fb.length, go: 1 } : NOOP;
      const ins: StationIn[] = seg.st.map((_, k) => (op.sel === k ? { rst: 0, go: op.go, len: op.len, we: op.we, wa: op.wa, wd: op.wd } : { rst: 0, go: 0, len: 0 }));
      set(gate, { rst: 0, sel: op.sel, wa: op.wa, wd: op.wd, we: op.we, len: op.len, go: op.go, ra: 0, hrd: 0, promisc: 8 });
      tickClk(gate); seg.step(ins);
      const bitsOf = (f: (s: Station) => number) => seg.st.reduce((v, s, i) => v | (f(s) << i), 0);
      const exp: Record<string, number> = {
        txen: bitsOf((s) => s.tx.txen), busy: bitsOf((s) => s.busy), sent: bitsOf((s) => s.tx.sent), restart: bitsOf((s) => s.tx.restart), drop: bitsOf((s) => s.tx.drop),
        rxgood: bitsOf((s) => (s.rx.valid && s.rx.last && !s.rx.err ? 1 : 0)), rxbad: bitsOf((s) => (s.rx.valid && s.rx.last && s.rx.err ? 1 : 0)), clash: seg.wire.clash,
      };
      for (const k of Object.keys(exp)) expect(out(gate, k), `${k} @${c}`).toBe(exp[k]);
      seen.restart += seg.st.reduce((n, s) => n + s.tx.restart, 0); seen.sent += seg.st.reduce((n, s) => n + s.tx.sent, 0); seen.clash += seg.wire.clash;
      if (c % 100 === 0) {
        const wide = (f: (s: Station) => number, w: number) => seg.st.reduce((v, s, i) => v + f(s) * 2 ** (w * i), 0);
        expect(out(gate, 'ngood'), `ngood @${c}`).toBe(wide((s) => s.ngood, 8));
        expect(out(gate, 'nbad'), `nbad @${c}`).toBe(wide((s) => s.nbad, 8));
        expect(out(gate, 'ncol'), `ncol @${c}`).toBe(wide((s) => s.ncol, 8));
        expect(out(gate, 'cp'), `cp @${c}`).toBe(wide((s) => s.cp, 11));
        expect(out(gate, 'txstate'), `txstate @${c}`).toBe(wide((s) => s.tx.state, 3));
        expect(out(gate, 'att'), `att @${c}`).toBe(wide((s) => s.tx.att, 4));
        expect(out(gate, 'rxstate'), `rxstate @${c}`).toBe(wide((s) => s.rx.state, 2));
      }
      if (c % 400 === 0) await yieldTick();
    }
    expect(seen.clash).toBeGreaterThan(0);
    expect(seen.restart).toBeGreaterThan(1);
    expect(seen.sent).toBe(3);
    // station 1 kept f01 (addressed to it) and the broadcast, 0 kept f10 and the broadcast, 2 sent the broadcast and kept nothing,
    // 3 is promiscuous and kept all three
    expect([seg.st[0].ngood, seg.st[1].ngood, seg.st[2].ngood, seg.st[3].ngood]).toEqual([2, 2, 0, 3]);
    // the bytes in station 1's receive buffer: f01 and the broadcast, each as a whole frame, in the order they were kept
    const kept = seg.st[1].frameAt(0, seg.st[1].cp);
    expect(kept).toHaveLength(f01.length + fb.length);
    const first = kept.slice(0, 60), second = kept.slice(60);
    expect([first, second]).toSatisfy((p: number[][]) => (JSON.stringify(p) === JSON.stringify([f01, fb])) || (JSON.stringify(p) === JSON.stringify([fb, f01])));
  }, 180000);
});

describe('capture', () => {
  it('a promiscuous station on the gate-level segment keeps every frame; they go through pcapFile, readPcap and parseFrame with their fields and FCS intact', async () => {
    const gate = simulate(ethSegment(4));
    const f01: FrameSpec = { dst: stationMac(1), src: stationMac(0), type: 0x0800, payload: Array.from({ length: 80 }, (_, i) => (i * 5) & 0xff) };
    const f12: FrameSpec = { dst: stationMac(2), src: stationMac(1), type: 0x0806, payload: Array.from({ length: 28 }, (_, i) => 0x40 + i) };
    const bodies = [frameBody(f01), frameBody(f12)];
    const host = (o: Partial<Op> & { ra?: number; hrd?: number; rst?: number }) => set(gate, { rst: 0, sel: 0, wa: 0, wd: 0, we: 0, len: 0, go: 0, ra: 0, hrd: 0, promisc: 8, ...o });
    host({ rst: 1 }); tickClk(gate); tickClk(gate);
    for (const [k, b] of [[0, bodies[0]], [1, bodies[1]]] as const) {
      b.forEach((v, i) => { host({ sel: k, wa: i, wd: v, we: 1 }); tickClk(gate); });
    }
    host({ sel: 0, len: bodies[0].length, go: 1 }); tickClk(gate);
    host({});
    const cpOf = () => Math.floor(out(gate, 'cp') / 2 ** 33);
    const marks: { clock: number; from: number; to: number }[] = [];
    let last = 0;
    for (let c = 0; c < 9000; c++) {
      if (c === 3500) { host({ sel: 1, len: bodies[1].length, go: 1 }); tickClk(gate); host({}); } else tickClk(gate);
      const cp = cpOf();
      if (cp !== last) { marks.push({ clock: c, from: last, to: cp }); last = cp; }
      if (c % 400 === 0) await yieldTick();
    }
    expect(marks).toHaveLength(2);
    const frames = marks.map((mk) => {
      const bytes: number[] = [];
      for (let a = mk.from; a < mk.to; a++) { host({ sel: 3, ra: a, hrd: 1 }); bytes.push(out(gate, 'rd')); }
      return captureRecord(mk.clock, bytes);
    });
    const file = pcapFile(frames);
    const back = readPcap(file);
    expect(back).toHaveLength(2);
    const parsed = back.map((r) => { const b = Array.from(r.bytes); return parseFrame([...b, ...frameBytes({ dst: b.slice(0, 6), src: b.slice(6, 12), type: (b[12] << 8) | b[13], payload: b.slice(14) }).slice(-4)]); });
    expect(back.map((r) => Array.from(r.bytes))).toEqual(bodies); // the bytes the gates received are the bytes the other station's gates sent
    const sorted = parsed.map((p) => p.src[5]).sort();
    expect(sorted).toEqual([1, 2]);
    for (const p of parsed) { expect(p.fcsOk).toBe(true); expect(p.runt).toBe(false); }
    const byFirst = (src: number) => parsed[parsed.findIndex((p) => p.src[5] === src)];
    expect(byFirst(1).dst).toEqual(stationMac(1)); // frame f01: destination station 2's address 02:..:02, source station 1
    expect(byFirst(1).type).toBe(0x0800);
    expect(byFirst(1).payload.slice(0, 80)).toEqual(f01.payload);
    expect(byFirst(2).type).toBe(0x0806);
    expect(byFirst(2).payload.slice(0, 28)).toEqual(f12.payload);
    expect(back[1].us).toBeGreaterThan(back[0].us);
  }, 120000);
});
