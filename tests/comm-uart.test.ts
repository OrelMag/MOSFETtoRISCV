import { describe, expect, it } from 'vitest';
import { tolerance, UART_8N1 } from '../src/comm/startstop';
import { receive } from '../src/comm/startstop';
import { rxFrameLevels } from '../src/comm/uartdrive';
import { lineStream, receiveBytes, SLOW_LIMIT_BACK_TO_BACK, SLOW_LIMIT_ISOLATED, UART_TOLERANCE, UartCore, type UartIn } from '../src/comm/uart';
import { UART_CORE, UART_RX, UART_RX_BENCH, UART_TX } from '../src/lib/uart';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

function bench(def: ComponentDef) {
  const sim = new GateSim(flatten(def));
  sim.reset('zero');
  for (const p of def.ports) if (p.dir === 'in') sim.setInput(p.name, 0);
  sim.settle();
  const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
  const set = (p: string, v: number) => sim.setInput(p, v);
  const edge = () => { sim.settle(); sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
  return { sim, out, set, edge };
}

const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const bytesOf = (n: number, r: () => number) => Array.from({ length: n }, () => Math.floor(r() * 256));

interface Run { div: number; cycles: number; seed: number; line: (k: number, m: UartCore) => number; pushP?: number; popP?: number; extra?: (k: number, r: () => number) => Partial<UartIn> }
const NAMES = ['tx', 'rxData', 'status', 'div', 'ie', 'irq', 'tickOut'] as const;

/** Drive the gate-level core and the model with the same inputs; every output must agree after every edge. */
async function lockstep(o: Run) {
  const g = bench(UART_CORE), m = new UartCore(), r = rng(o.seed);
  const received: number[] = [], sent: number[] = [], popped: number[] = [];
  let ferrs = 0, irqs = 0;
  for (let k = 0; k < o.cycles; k++) {
    const i: UartIn = { rx: o.line(k, m), data: Math.floor(r() * 256), push: r() < (o.pushP ?? 0.02), pop: r() < (o.popP ?? 0.05) };
    if (k === 0) { i.divWe = true; i.wval = o.div; }
    Object.assign(i, o.extra?.(k, r));
    g.set('rx', i.rx); g.set('push', i.push ? 1 : 0); g.set('data', i.data!); g.set('pop', i.pop ? 1 : 0);
    g.set('divWe', i.divWe ? 1 : 0); g.set('ieWe', i.ieWe ? 1 : 0); g.set('clrWe', i.clrWe ? 1 : 0); g.set('wval', i.wval ?? 0);
    const accepted = i.push && m.txq.length < 16, head = m.rxData, willPop = i.pop && m.rxq.length > 0;
    g.edge(); m.edge(i);
    if (accepted) sent.push(i.data!);
    if (willPop) popped.push(head);
    if (m.lastPush) received.push(m.rxq[m.rxq.length - 1] ?? -1);
    if (m.lastFerr) ferrs++;
    if (m.irq) irqs++;
    const want = { tx: m.tx, rxData: m.rxData, status: m.status, div: m.div, ie: m.ie, irq: m.irq, tickOut: m.tick ? 1 : 0 };
    for (const n of NAMES) if (g.out(n) !== want[n]) expect.fail(`edge ${k}: ${n} gates ${g.out(n)} model ${want[n]}`);
    if (k % 3000 === 0) await tick();
  }
  return { m, sent, popped, ferrs, irqs, received };
}

describe('UART core: gates against the golden model, every output every cycle', () => {
  it('idle line, random writes and reads, divisors 1 and 3', async () => {
    for (const div of [1, 3]) await lockstep({ div, cycles: 3000, seed: div, line: () => 1, pushP: 0.05 });
  }, 120000);

  it('loopback at divisors 1, 2 and 5: every byte pushed is popped, in order', async () => {
    for (const div of [1, 2, 5]) {
      const r = await lockstep({ div, cycles: 6000 + 4000 * div, seed: 40 + div, line: (_k, m) => m.tx, pushP: 0.004, popP: 0.3 });
      expect(r.sent.length).toBeGreaterThan(5);
      expect(r.popped).toEqual(r.sent.slice(0, r.popped.length));
      expect(r.popped.length).toBeGreaterThan(r.sent.length / 2);
      expect(r.ferrs).toBe(0);
    }
  }, 240000);

  it('a stream from a clock 3 % fast and 3 % slow at an arbitrary phase; with nobody reading, the FIFO overruns', async () => {
    for (const [err, seed] of [[0.03, 1], [-0.03, 2]] as const) {
      const div = 2, bytes = bytesOf(24, rng(seed));
      const line = lineStream(bytes, 16 * div * (1 + err), 77.37, 0);
      const x = await lockstep({ div, cycles: Math.ceil(16 * div * 10 * 24 * 1.1) + 200, seed: 9, line, pushP: 0, popP: 0.5 });
      expect(x.popped).toEqual(bytes);
      expect(x.m.fe).toBe(false);
    }
    const bytes = bytesOf(20, rng(5));
    const o = await lockstep({ div: 1, cycles: 20 * 16 * 10 + 400, seed: 3, line: lineStream(bytes, 16, 33.5, 0), pushP: 0, popP: 0 });
    expect(o.received.length).toBe(20); // twenty frames arrived, the FIFO kept the first sixteen
    expect(o.m.ovr).toBe(true);
    expect(o.m.rxq).toEqual(bytes.slice(0, 16));
  }, 240000);

  it('framing error (stop bit low), a false start, a break, and the sticky flags cleared by a write of 1', async () => {
    const div = 2, bit = 16 * div;
    const wave = (k: number): number => {
      const u = k / bit - 2; // frame 1 (0x41, stop bit low) from bit time 2
      if (u >= 0 && u < 10) return u < 1 ? 0 : u >= 9 ? 0 : (0x41 >> Math.floor(u - 1)) & 1;
      const v = k / bit - 14; // frame 2 (0x42)
      if (v >= 0 && v < 10) return v < 1 ? 0 : v >= 9 ? 1 : (0x42 >> Math.floor(v - 1)) & 1;
      const gl = k - 26 * bit; // a false start: 3 ticks low
      if (gl >= 0 && gl < 3 * div) return 0;
      const br = k / bit - 30; // a break: low for 12 bit times
      if (br >= 0 && br < 12) return 0;
      return 1;
    };
    const clearAt = 44 * bit;
    const x = await lockstep({ div, cycles: 48 * bit, seed: 4, line: wave, pushP: 0, popP: 0.3, extra: (k) => (k === clearAt ? { clrWe: true, wval: 0x18 } : {}) });
    expect(x.ferrs).toBe(2); // the low stop, and the break (one frame of zeros; then it waits for the line to rise)
    expect(x.received).toEqual([0x42]);
    expect(x.m.fe).toBe(false); // cleared by the write at clearAt
  }, 240000);

  it('interrupt enables: rx not empty and tx FIFO empty', async () => {
    const x = await lockstep({ div: 1, cycles: 1500, seed: 6, line: (_k, m) => m.tx, pushP: 0.01, popP: 0.02, extra: (k) => (k === 3 ? { ieWe: true, wval: 3 } : k === 700 ? { ieWe: true, wval: 1 } : {}) });
    expect(x.irqs).toBeGreaterThan(10);
  }, 60000);
});

describe('transmitter and receiver alone', () => {
  it('the transmitter sends start, eight data bits LSB first, stop, 16 ticks each, and goes idle', () => {
    const t = bench(UART_TX), div = 3;
    const wave: number[] = [];
    let taken = -1;
    for (let k = 0; k < 12 * 16 * div; k++) {
      t.set('tick', k % div === 0 ? 1 : 0);
      t.set('go', k === 5 ? 1 : 0); t.set('din', 0xa5);
      t.sim.settle();
      if (t.out('taken') === 1 && taken < 0) taken = k;
      t.edge();
      wave.push(t.out('tx'));
    }
    expect(taken).toBe(5);
    const first = wave.indexOf(0), bit = 16 * div;
    const levels = Array.from({ length: 10 }, (_, i) => new Set(wave.slice(first + i * bit, first + (i + 1) * bit)));
    levels.forEach((s) => expect(s.size).toBe(1));
    expect(levels.map((s) => [...s][0])).toEqual([0, 1, 0, 1, 0, 0, 1, 0, 1, 1]); // start, 0xA5 = 10100101 LSB first, stop
    expect(wave.slice(first + 10 * bit).every((v) => v === 1)).toBe(true);
    expect(wave.slice(0, first).every((v) => v === 1)).toBe(true);
  });

  it('the receiver gives a byte and one push pulse', () => {
    const r = bench(UART_RX), div = 2, line = lineStream([0xc3], 16 * div, 10.5);
    let pushes = 0, data = -1;
    for (let k = 0; k < 14 * 16 * div; k++) {
      r.set('tick', k % div === 0 ? 1 : 0); r.set('rx', line(k)); r.sim.settle();
      if (r.out('push') === 1) { pushes++; data = r.out('data'); }
      r.edge();
    }
    expect(pushes).toBe(1);
    expect(data).toBe(0xc3);
  });
});

describe('the receiver tolerance to a clock that is off: predicted by comm/startstop.ts, measured here', () => {
  const PHASES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
  // the line's bit period is 16·div·(1 + err) receiver cycles: err > 0 is a sender slower than the receiver,
  // that is startstop's "receiver clock fast" case with the same sign of error
  const isolatedOk = (div: number, err: number): boolean => {
    for (let c = 0; c < 256; c++) for (const p of PHASES) {
      const r = receiveBytes(div, lineStream([c], 16 * div * (1 + err), 4 * div + p * div), 14 * 16 * div + 40);
      if (r.bytes.length !== 1 || r.bytes[0] !== c || r.framing) return false;
    }
    return true;
  };
  const streams: number[][] = [[0, 0, 0, 0, 0, 0, 0, 0], [255, 255, 255, 255, 255, 255], [0x80, 0x80, 0x80, 0x80, 0x80, 0x80], [0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa],
    ...Array.from({ length: 12 }, (_, i) => { const r = rng(i + 1); return Array.from({ length: 10 }, () => Math.floor(r() * 256)); })];
  const burstOk = (div: number, err: number): boolean => {
    for (const bytes of streams) for (const p of PHASES) {
      const r = receiveBytes(div, lineStream(bytes, 16 * div * (1 + err), 4 * div + p * div, 0), Math.ceil((bytes.length * 10 + 3) * 16 * div * Math.max(1, 1 + err)) + 100);
      if (r.bytes.length !== bytes.length || r.bytes.some((x, i) => x !== bytes[i]) || r.framing) return false;
    }
    return true;
  };

  it('every byte at every phase is received just inside each pinned limit and some fail 0.05 % beyond it, isolated and back to back', async () => {
    for (const m of UART_TOLERANCE.measured) {
      expect(isolatedOk(m.div, m.senderSlow)).toBe(true);
      expect(isolatedOk(m.div, m.senderSlow + 0.0005)).toBe(false);
      expect(isolatedOk(m.div, -m.senderFast)).toBe(true);
      expect(isolatedOk(m.div, -(m.senderFast + 0.0005))).toBe(false);
      await tick();
      expect(burstOk(m.div, m.backToBackSlow)).toBe(true);
      expect(burstOk(m.div, m.backToBackSlow + 0.0005)).toBe(false);
      expect(burstOk(m.div, -m.backToBackFast)).toBe(true);
      expect(burstOk(m.div, -(m.backToBackFast + 0.0005))).toBe(false);
      await tick();
    }
  }, 240000);

  it('agrees with startstop.tolerance and the closed forms', () => {
    const pred = tolerance(UART_8N1, { ticks: 16, pos: 0.5 }, 5e-4);
    expect(pred.fast).toBeCloseTo(UART_TOLERANCE.predicted.senderSlow, 4);
    expect(pred.slow).toBeCloseTo(UART_TOLERANCE.predicted.senderFast, 4);
    for (const m of UART_TOLERANCE.measured) {
      expect(m.senderSlow).toBeLessThanOrEqual(0.5 / 9);
      expect(m.senderSlow).toBeGreaterThan(0.5 / 9 - 0.0006);
      expect(Math.abs(m.senderFast - SLOW_LIMIT_ISOLATED)).toBeLessThan(0.0006);
      expect(Math.abs(m.backToBackFast - SLOW_LIMIT_BACK_TO_BACK)).toBeLessThan(0.0006);
      expect(Math.abs(m.senderFast - pred.slow)).toBeLessThan(0.001);
    }
  });

  it('the gate-level receiver agrees with the search: it takes every code just inside each limit and fails some just outside', () => {
    const div = 2, codes = [0x00, 0x80, 0xff, 0x7f, 0x55, 0xaa, 0x01, 0xfe];
    const r = bench(UART_RX_BENCH);
    const run = (err: number, code: number, phase: number): number => {
      const q = rxFrameLevels(div, code, err, phase);
      r.sim.reset('zero'); r.set('div', div); r.set('clk', 0); r.set('rx', 1); r.sim.settle();
      let data = -1;
      for (let k = 0; k < q.length + 8 * 16 * div; k++) { r.set('rx', k < q.length ? q[k] : 1); r.sim.settle(); if (r.out('push') === 1) data = r.out('data'); r.edge(); }
      return data;
    };
    const allOk = (err: number) => codes.every((c) => [0, 0.5, 0.99].every((p) => run(err, c, p) === c));
    const m = UART_TOLERANCE.measured[0];
    expect(allOk(m.senderSlow - 0.003)).toBe(true);
    expect(allOk(-(m.senderFast - 0.003))).toBe(true);
    expect(allOk(m.senderSlow + 0.012)).toBe(false);
    expect(allOk(-(m.senderFast + 0.012))).toBe(false);
  }, 240000);
});

describe('the receiver panel: the verdict drawn from the model is the gates\' verdict', () => {
  it('gates and receive() agree on every error and phase near both limits, at divisors 1, 2 and 3', () => {
    const r = bench(UART_RX_BENCH);
    const gates = (div: number, code: number, err: number, ph: number): boolean => {
      const q = rxFrameLevels(div, code, err, ph);
      r.sim.reset('zero'); r.set('div', div); r.set('clk', 0); r.set('rx', 1); r.sim.settle();
      let data = -1, ferr = 0;
      for (let k = 0; k < q.length + 8 * 16 * div; k++) { r.set('rx', k < q.length ? q[k] : 1); r.sim.settle(); if (r.out('push') === 1) data = r.out('data'); if (r.out('ferr') === 1) ferr++; r.edge(); }
      return data === code && ferr === 0;
    };
    let n = 0, disagree: string[] = [];
    for (const div of [1, 2, 3]) for (const code of [0x00, 0x80, 0x52, 0xff]) for (const err of [-0.06, -0.052, -0.05, -0.047, -0.04, 0.04, 0.05, 0.054, 0.057, 0.06]) for (const ph of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
      n++;
      const m = receive(UART_8N1, code, { err, ticks: 16, phase: ph }).ok, g = gates(div, code, err, ph);
      if (m !== g) disagree.push(`div ${div} 0x${code.toString(16)} e ${err} ph ${ph}: model ${m} gates ${g}`);
    }
    expect(n).toBe(840);
    expect(disagree).toEqual([]);
  }, 240000);
});
