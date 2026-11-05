// The serial console capstone's bench (DOM-free): a UART with FIFOs built from its register map, judged at its pins by what a far end sees and
// sends. It looks at frames, flags and order, never at internal timing, so any design that meets the sheet passes. Senders and readers here
// run on their own clocks, up to CONSOLE_ERR off.

import type { CustomRun } from '../editor/challenges';
import { IE_RX, IE_TX, OVERSAMPLE, ST_FRAMING, ST_OVERRUN, ST_RXNE, ST_TXFULL, ST_TXIDLE } from '../comm/uart';
import type { ComponentDef } from '../sim/types';
import type { BitSim } from '../sim/bitsim';
import { BROADCAST, ETHERTYPE_LOCAL, frameBody, isGroup } from '../comm/ethframe';
import { hostMac } from '../comm/ethswitch';
import { finish, hex, simOf } from './commcheck';

/** How far the far end's clock may be from ours, fast or slow. */
export const CONSOLE_ERR = 0.035;
export const CONSOLE_DEPTH = 16;

const PINS = ['rx', 'push', 'data', 'pop', 'divWe', 'ieWe', 'clrWe', 'wval', 'clk', 'tx', 'rxData', 'status', 'irq'];

class Pins {
  tx: number[] = [];
  cycles = 0;
  /** What the far end's line does now, by cycle. */
  line: (cycle: number) => number = () => 1;
  constructor(private sim: BitSim) {
    for (const p of ['push', 'data', 'pop', 'divWe', 'ieWe', 'clrWe', 'wval']) sim.setInput(p, [0]);
    sim.setInput('rx', [1]);
  }
  /** One clock with these inputs, the rest idle. */
  step(i: Partial<Record<'push' | 'data' | 'pop' | 'divWe' | 'ieWe' | 'clrWe' | 'wval', number>> = {}): void {
    const s = this.sim;
    s.setInput('rx', [this.line(this.cycles)]);
    for (const p of ['push', 'data', 'pop', 'divWe', 'ieWe', 'clrWe', 'wval'] as const) s.setInput(p, [i[p] ?? 0]);
    s.cycle();
    this.cycles++;
    this.tx.push(s.get('tx', 1)[0]);
  }
  run(n: number): void { for (let k = 0; k < n; k++) this.step(); }
  get status(): number { return this.sim.get('status', 1)[0]; }
  get rxData(): number { return this.sim.get('rxData', 1)[0]; }
  get irq(): number { return this.sim.get('irq', 1)[0]; }
}

/** The frames on a recording of the line, read by a far end `err` off, in cycles per bit `unit`: bytes, and any frame it could not read. */
export function readFrames(line: readonly number[], unit: number, err = 0): { bytes: number[]; bad: string[] } {
  const bytes: number[] = [], bad: string[] = [], u = unit * (1 + err);
  let i = 0;
  while (i < line.length) {
    if (line[i] !== 0) { i++; continue; }
    const at = (bit: number) => line[Math.floor(i + (bit + 0.5) * u)];
    if (Math.floor(i + 9.5 * u) >= line.length) { bad.push(`a frame was cut short at cycle ${i}`); break; }
    if (at(0) !== 0) bad.push(`at cycle ${i} the line fell, and was up again by the middle of the start bit`);
    let v = 0;
    for (let b = 0; b < 8; b++) v |= at(1 + b) << b;
    if (at(9) !== 1) bad.push(`after ${hex(v)} the stop bit reads 0`);
    bytes.push(v);
    i = Math.floor(i + 9.5 * u); // the stop bit's middle: the next frame's fall may come any time after
    while (i < line.length && line[i] === 0) i++;
  }
  return { bytes, bad };
}

/** A far end sending these frames from cycle `from`, each bit `unit` cycles long on its clock; `stop` 0 sends a bad stop bit on that frame. */
function sender(bytes: readonly number[], unit: number, from: number, badStop = -1): (cycle: number) => number {
  return (c) => {
    const t = (c - from) / unit;
    if (t < 0) return 1;
    const frame = Math.floor(t / 10), bit = Math.floor(t - frame * 10);
    if (frame >= bytes.length) return 1;
    if (bit === 0) return 0;
    if (bit === 9) return frame === badStop ? 0 : 1;
    return (bytes[frame] >> (bit - 1)) & 1;
  };
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const list = (a: readonly number[]) => a.map((v) => hex(v)).join(' ');

/** The whole sheet, one scenario after another on one chip from power-on. Each failure says what the far end saw. */
export function runConsole(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the UART is gates'], tested: 0 };
  const sim = simOf(def, PINS);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const p = new Pins(sim), fails: string[] = [];
  let tested = 0;
  const check = (ok: boolean, why: string) => { tested++; if (!ok) fails.push(why); };
  const setDiv = (d: number) => p.step({ divWe: 1, wval: d });
  /** Every byte waiting in the receive FIFO, oldest first. */
  const drain = (): number[] => {
    const out: number[] = [];
    for (let k = 0; k < CONSOLE_DEPTH + 4 && p.status & ST_RXNE; k++) { out.push(p.rxData); p.step({ pop: 1 }); p.run(3); }
    return out;
  };
  const untilIdle = (limit: number) => { for (let k = 0; k < limit && !(p.status & ST_TXIDLE); k++) p.step(); };

  // ---- sending, at two divisors, read by a far end off in either direction
  for (const div of [1, 3]) {
    setDiv(div);
    p.run(4);
    const unit = OVERSAMPLE * div, out = [0x55, 0xa3, 0x00, 0xff, 0x01, 0x80], from = p.tx.length;
    for (const b of out) { p.step({ push: 1, data: b }); }
    check(!(p.status & ST_TXIDLE), `divisor ${div}: status still says transmitter idle with bytes queued`);
    untilIdle(unit * 10 * (out.length + 2));
    check(!!(p.status & ST_TXIDLE), `divisor ${div}: the transmitter never went idle after ${out.length} bytes`);
    p.run(unit);
    for (const err of [0, CONSOLE_ERR, -CONSOLE_ERR]) {
      const r = readFrames(p.tx.slice(from), unit, err);
      check(same(r.bytes, out) && !r.bad.length, `divisor ${div}: a far end ${(err * 100).toFixed(1)} % off read [${list(r.bytes)}]${r.bad[0] ? ` (${r.bad[0]})` : ''}, sent [${list(out)}]`);
    }
  }

  // ---- the transmit FIFO fills, and what fitted still goes out in order
  setDiv(3);
  p.run(2);
  {
    const unit = OVERSAMPLE * 3, from = p.tx.length, sent: number[] = [];
    let full = false;
    for (let k = 0; k < CONSOLE_DEPTH + 8; k++) {
      if (p.status & ST_TXFULL) { full = true; break; }
      const b = (k * 37 + 11) & 255;
      sent.push(b);
      p.step({ push: 1, data: b });
      p.run(2); // the sheet says what full means, not on which cycle it shows: software looks before each push
    }
    check(full, `the transmit FIFO never reported full after ${sent.length} bytes in a row`);
    check(sent.length >= CONSOLE_DEPTH, `full came after only ${sent.length} bytes: the FIFO holds ${CONSOLE_DEPTH}`);
    untilIdle(unit * 10 * (sent.length + 2));
    p.run(unit);
    const r = readFrames(p.tx.slice(from), unit);
    check(same(r.bytes, sent), `with the FIFO full the far end read [${list(r.bytes)}], sent [${list(sent)}]`);
  }

  // ---- receiving from a far end off in either direction, back to back
  for (const div of [3, 1]) {
    setDiv(div);
    p.run(2);
    for (const err of [0, CONSOLE_ERR, -CONSOLE_ERR]) {
      const bytes = [0x41, 0xc3, 0x00, 0xff, 0x5a, 0xa5, 0x0f, 0xf0], unit = OVERSAMPLE * div * (1 + err), from = p.cycles + 3;
      p.line = sender(bytes, unit, from);
      p.run(Math.ceil(unit * 10 * bytes.length) + 3 + OVERSAMPLE * 2 * div);
      p.line = () => 1;
      const got = drain();
      check(same(got, bytes), `divisor ${div}: a sender ${(err * 100).toFixed(1)} % off sent [${list(bytes)}], the FIFO gave [${list(got)}]`);
      check(!(p.status & (ST_FRAMING | ST_OVERRUN)), `divisor ${div}: a sender ${(err * 100).toFixed(1)} % off left error flags set: status ${hex(p.status)}`);
      check(!(p.status & ST_RXNE), 'status says data waiting after the FIFO was emptied');
    }
  }

  // ---- overrun: more than it holds, and nothing read
  {
    const bytes = Array.from({ length: CONSOLE_DEPTH + 3 }, (_, k) => (k * 13 + 1) & 255), unit = OVERSAMPLE, from = p.cycles + 3;
    p.line = sender(bytes, unit, from);
    p.run(unit * 10 * bytes.length + 3 + OVERSAMPLE * 2);
    p.line = () => 1;
    check(!!(p.status & ST_OVERRUN), `${bytes.length} bytes with no reader did not set overrun`);
    const got = drain();
    check(same(got, bytes.slice(0, CONSOLE_DEPTH)), `after an overrun the FIFO gave [${list(got)}]: it keeps the first ${CONSOLE_DEPTH}`);
    check(!!(p.status & ST_OVERRUN), 'overrun cleared itself: it stays until a write of 1');
    // both flags up: each clears only by a 1 in its own bit
    const at = p.cycles + 3;
    p.line = sender([0x77], OVERSAMPLE, at, 0);
    p.run(OVERSAMPLE * 12 + 3);
    p.line = () => 1;
    p.run(OVERSAMPLE * 2);
    check((p.status & (ST_FRAMING | ST_OVERRUN)) === (ST_FRAMING | ST_OVERRUN), `overrun and a framing error both happened, and status reads ${hex(p.status)}`);
    p.step({ clrWe: 1, wval: 0 });
    p.step();
    check((p.status & (ST_FRAMING | ST_OVERRUN)) === (ST_FRAMING | ST_OVERRUN), 'a clear with no bit set in wval cleared a flag');
    p.step({ clrWe: 1, wval: ST_OVERRUN });
    p.step();
    check(!(p.status & ST_OVERRUN), 'a write of 1 to its status bit did not clear overrun');
    check(!!(p.status & ST_FRAMING), 'clearing overrun cleared the framing error too');
    p.step({ clrWe: 1, wval: ST_FRAMING });
    p.step();
  }

  // ---- a bad stop bit: an error, no byte
  {
    const unit = OVERSAMPLE, from = p.cycles + 3;
    p.line = sender([0x77], unit, from, 0);
    p.run(unit * 10 + 3 + OVERSAMPLE * 2);
    p.line = () => 1;
    p.run(OVERSAMPLE * 2);
    check(!!(p.status & ST_FRAMING), 'a frame with a stop bit of 0 did not set the framing error');
    check(!(p.status & ST_RXNE), 'a frame with a bad stop bit went into the FIFO');
    // and it can still receive, with the flag staying up through the good byte and its pop
    const after = p.cycles + 3;
    p.line = sender([0x3c], unit, after);
    p.run(unit * 10 + 3 + OVERSAMPLE * 2);
    p.line = () => 1;
    const got = drain();
    check(same(got, [0x3c]), `after a framing error the next good byte gave [${list(got)}]`);
    check(!!(p.status & ST_FRAMING), 'the framing error cleared itself: it stays until a write of 1');
    p.step({ clrWe: 1, wval: ST_FRAMING });
    p.step();
    check(!(p.status & ST_FRAMING), 'a write of 1 to its status bit did not clear the framing error');
  }

  // ---- interrupts
  p.step({ ieWe: 1, wval: 0 });
  p.step();
  check(!p.irq, 'irq is high with both enables off');
  p.step({ ieWe: 1, wval: IE_TX });
  p.step();
  check(!!p.irq, 'irq is low with the transmit-empty enable on and the FIFO empty');
  p.step({ ieWe: 1, wval: IE_RX });
  p.step();
  check(!p.irq, 'irq is high with the receive enable on and nothing received');
  {
    const from = p.cycles + 3;
    p.line = sender([0x12], OVERSAMPLE, from);
    p.run(OVERSAMPLE * 10 + 3 + OVERSAMPLE * 2);
    p.line = () => 1;
    check(!!p.irq, 'irq is low with the receive enable on and a byte waiting');
    drain();
    check(!p.irq, 'irq stayed high after the byte was read');
  }
  {
    // the transmit enable with bytes queued: low while the FIFO holds any, high once it is empty, with the last byte still on the line
    const queued = [0x21, 0x22, 0x23];
    p.step({ ieWe: 1, wval: IE_TX });
    p.step();
    for (const b of queued) { p.step({ push: 1, data: b }); p.run(2); }
    check(!p.irq, 'irq is high on the transmit enable with bytes in the FIFO');
    for (let k = 0; k < OVERSAMPLE * 10 * queued.length && !p.irq; k++) p.step();
    check(!!p.irq, 'irq never rose on the transmit enable after the FIFO emptied');
    check(!(p.status & ST_TXIDLE), 'irq on the transmit enable waited for the line: it means the FIFO is empty, with the last byte still going out');
    // both enables: either cause raises it
    p.step({ ieWe: 1, wval: IE_TX | IE_RX });
    p.step();
    for (const b of queued) { p.step({ push: 1, data: b }); p.run(2); }
    check(!p.irq, 'irq is high with both enables, nothing received and bytes in the FIFO');
    const at = p.cycles + 3;
    p.line = sender([0x34], OVERSAMPLE, at);
    p.run(OVERSAMPLE * 12 + 3);
    p.line = () => 1;
    check(!!p.irq, 'irq is low with both enables and a byte waiting');
    drain();
    untilIdle(OVERSAMPLE * 10 * (queued.length + 2));
    p.step({ ieWe: 1, wval: 0 });
    p.step();
  }
  return finish(fails, tested, def, { cycles: p.cycles });
}

// ---- a switch from its spec -----------------------------------------------------------------------------------------------------------------
//
// Frames in, frames out, compared whole. The bench knows the rules (the learning table's, as a table of its own) and nothing about how the
// design buffers or schedules, so it compares what comes out of each port, not the cycle it comes out in.

const PORTS_N = 4;
export const SW_MAX_FRAME = 128;
/** Share of the line a permutation at full load must carry, on frames of SW_THROUGHPUT_BYTES. */
export const SW_THROUGHPUT = 0.8, SW_THROUGHPUT_BYTES = 64, SW_THROUGHPUT_GAP = 12;
const MAC = (h: number) => hostMac(h);
const key = (m: readonly number[]) => m.join(':');
/** How long the bench lets a host stay quiet before relying on the table remembering it: well under the sheet's 1000 cycles. */
export const AGE_MARGIN = 500;
const MULTICAST = [0x01, 0x00, 0x5e, 0x00, 0x00, 0x01];
/** No byte out for this long means the switch has finished with what it was given (the sheet's promise). */
export const SW_QUIET = 100;
const SW_SETTLE_MAX = 4000;

interface SwFrame { port: number; bytes: number[]; err?: boolean; name: string }

class SwitchPins {
  /** The frames each output delivered, whole. */
  out: number[][][] = [[], [], [], []];
  private cur: number[][] = [[], [], [], []];
  ready = [1, 1, 1, 1];
  /** Set, each output's ready follows this cycle by cycle. */
  wobble: ((cycle: number, port: number) => number) | null = null;
  /** When a byte last moved at an output. */
  private moved = 0;
  cycles = 0;
  constructor(private sim: BitSim) {
    for (let i = 0; i < PORTS_N; i++) { for (const p of ['rxData', 'rxValid', 'rxLast', 'rxErr']) sim.setInput(`${p}${i}`, [0]); sim.setInput(`txReady${i}`, [1]); }
  }
  /** One clock: `feed` per port is the byte to present, or none. A byte counts when its port's rxReady was 1 at the frame's first byte. */
  step(feed: ({ data: number; last: boolean; err: boolean } | null)[]): void {
    const s = this.sim;
    if (this.wobble) this.ready = this.ready.map((_, i) => this.wobble!(this.cycles, i));
    // a byte moves on the edge where valid and ready were both high before it
    for (let i = 0; i < PORTS_N; i++) {
      if (s.get(`txValid${i}`, 1)[0] && this.ready[i]) {
        this.moved = this.cycles;
        this.cur[i].push(s.get(`txData${i}`, 1)[0]);
        if (s.get(`txLast${i}`, 1)[0]) { this.out[i].push(this.cur[i]); this.cur[i] = []; }
      }
    }
    for (let i = 0; i < PORTS_N; i++) {
      const f = feed[i];
      s.setInput(`rxValid${i}`, [f ? 1 : 0]); s.setInput(`rxData${i}`, [f?.data ?? 0]); s.setInput(`rxLast${i}`, [f?.last ? 1 : 0]); s.setInput(`rxErr${i}`, [f?.err ? 1 : 0]);
      s.setInput(`txReady${i}`, [this.ready[i]]);
    }
    s.cycle();
    this.cycles++;
  }
  rxReady(i: number): number { return this.sim.get(`rxReady${i}`, 1)[0]; }
  idle(n: number): void { for (let k = 0; k < n; k++) this.step([null, null, null, null]); }
  /** Idle until no byte has moved at any output for SW_QUIET cycles: however long the design took, its frame is over. */
  settle(): void {
    const start = this.cycles;
    this.moved = this.cycles;
    while (this.cycles - this.moved < SW_QUIET && this.cycles - start < SW_SETTLE_MAX) this.idle(1);
  }
  /** One frame presented on its port once rxReady lets it start, and the switch given time to finish with it. False: rxReady refused it. */
  send(f: SwFrame, wait = 2000): boolean {
    for (let k = 0; k < wait && !this.rxReady(f.port); k++) this.idle(1);
    if (!this.rxReady(f.port)) return false;
    f.bytes.forEach((b, k) => {
      const feed: ({ data: number; last: boolean; err: boolean } | null)[] = [null, null, null, null];
      const last = k === f.bytes.length - 1;
      feed[f.port] = { data: b, last, err: !!f.err && last };
      this.step(feed);
    });
    this.settle();
    return true;
  }
  take(): number[][][] { const o = this.out; this.out = [[], [], [], []]; return o; }
}

const frameOf = (src: readonly number[], dst: readonly number[], id: number, bytes = 64): number[] => frameBody({
  dst, src, type: ETHERTYPE_LOCAL, payload: Array.from({ length: Math.max(4, bytes - 14) }, (_, k) => (k < 2 ? (id >> (8 * k)) & 255 : (id * 3 + k) & 255)),
});

/** `keep` sees each frame the design delivered, for a capture (scripts/tshark-oracle.ts reads the reference's). */
export function runSwitchSpec(def: ComponentDef, mode: 'gate' | 'switch', keep?: (f: number[]) => void): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the switch is gates'], tested: 0 };
  const names = [0, 1, 2, 3].flatMap((i) => [`rxData${i}`, `rxValid${i}`, `rxLast${i}`, `rxErr${i}`, `txReady${i}`, `rxReady${i}`, `txData${i}`, `txValid${i}`, `txLast${i}`]);
  const sim = simOf(def, ['clk', ...names]);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const p = new SwitchPins(sim), fails: string[] = [], table = new Map<string, number>(), heard = new Map<string, number>();
  let tested = 0, id = 1;
  const quiet = (what: string, m: string) => { if (fails.length < 12) fails.push(`${what}: ${m}`); };
  /** Sends one frame, and holds what comes out to the rule. */
  const expect1 = (what: string, port: number, src: readonly number[], dst: readonly number[], o: { err?: boolean; bytes?: number } = {}) => {
    // the sheet lets a table forget after 1000 cycles, so a host about to be relied on speaks up first, as a live one would
    const old = table.get(key(dst));
    if (old !== undefined && !isGroup(dst) && p.cycles - (heard.get(key(dst)) ?? 0) > AGE_MARGIN) expect1(`${what}: its destination announcing itself`, old, dst, BROADCAST);
    const bytes = frameOf(src, dst, id++, o.bytes);
    const known = table.get(key(dst));
    const want = o.err ? [] : isGroup(dst) || known === undefined ? [0, 1, 2, 3].filter((i) => i !== port) : known === port ? [] : [known];
    if (!o.err) { table.set(key(src), port); heard.set(key(src), p.cycles); }
    if (!p.send({ port, bytes, err: o.err, name: what })) { quiet(what, `rxReady on port ${port} stayed low on a switch with nothing to do`); return; }
    const out = p.take();
    tested++;
    const got = [0, 1, 2, 3].filter((i) => out[i].length > 0);
    if (got.join() !== want.join()) quiet(what, `came out of port${got.length === 1 ? '' : 's'} [${got.join(', ')}], and belongs on [${want.join(', ')}]`);
    for (const i of got) {
      if (out[i].length > 1) quiet(what, `port ${i} sent it ${out[i].length} times`);
      if (out[i][0].join() !== bytes.join()) quiet(what, `port ${i} changed the frame: ${out[i][0].length} bytes out for ${bytes.length} in`);
      keep?.(out[i][0]);
    }
  };

  p.idle(8);
  // ---- learning: nobody is known, then everybody is
  for (let h = 0; h < PORTS_N; h++) expect1(`host ${h}'s first frame, a broadcast`, h, MAC(h), BROADCAST);
  for (let a = 0; a < PORTS_N; a++) for (let b = 0; b < PORTS_N; b++) if (a !== b) expect1(`host ${a} to host ${b}, both known`, a, MAC(a), MAC(b));
  // ---- a group address that is not the broadcast one
  expect1('a frame to a group address', 1, MAC(1), MULTICAST);
  // ---- flooding to a stranger, then learning from its answer
  expect1('a frame to a host never heard', 0, MAC(0), MAC(9));
  expect1('that host\'s reply, from port 2', 2, MAC(9), MAC(0));
  expect1('a frame back to it, now known', 1, MAC(1), MAC(9));
  // ---- two hosts behind one port
  expect1('a second host on port 3', 3, MAC(5), BROADCAST);
  expect1('host 3 to its neighbour on the same port', 3, MAC(3), MAC(5));
  // ---- a host that moves
  expect1('host 1 moves to port 0', 0, MAC(1), BROADCAST);
  expect1('a frame to host 1 after it moved', 2, MAC(2), MAC(1));
  // ---- a damaged frame goes nowhere (whether its source teaches the table is the design's choice, so nothing relies on that host after)
  expect1('a frame the MAC found damaged', 2, MAC(7), MAC(0), { err: true });
  // ---- the longest frame
  expect1(`a frame of ${SW_MAX_FRAME} bytes`, 2, MAC(2), MAC(0), { bytes: SW_MAX_FRAME });

  // ---- a busy output holds its frames, and loses none
  {
    expect1('host 0 announcing itself before the wait', table.get(key(MAC(0)))!, MAC(0), BROADCAST);
    const dst = table.get(key(MAC(0)))!, from = (dst + 1) % PORTS_N, bytes = [frameOf(MAC(2), MAC(0), id++), frameOf(MAC(2), MAC(0), id++)];
    table.set(key(MAC(2)), from);
    p.ready[dst] = 0;
    // a design may lower rxReady once it has nowhere to put a frame: only what it took is owed
    const taken = bytes.filter((b) => p.send({ port: from, bytes: b, name: 'held' }, 300));
    p.take();
    p.ready[dst] = 1;
    p.settle();
    const out = p.take()[dst];
    tested++;
    if (!taken.length) quiet('an output that was held', 'its input refused the first frame, with nothing waiting');
    if (out.map((f) => f.join()).join('|') !== taken.map((f) => f.join()).join('|')) quiet('an output that was held, then released', `delivered ${out.length} frames of the ${taken.length} taken, or in another order`);
  }

  // ---- an output that keeps pausing inside the frame
  {
    expect1('host 0 announcing itself before the pauses', table.get(key(MAC(0)))!, MAC(0), BROADCAST);
    const dst = table.get(key(MAC(0)))!, from = (dst + 1) % PORTS_N, bytes = frameOf(MAC(2), MAC(0), id++);
    table.set(key(MAC(2)), from);
    p.wobble = (c, i) => (i === dst && c % 3 === 0 ? 0 : 1);
    p.send({ port: from, bytes, name: 'paused' });
    p.wobble = null;
    p.ready = [1, 1, 1, 1];
    const out = p.take();
    tested++;
    if (out[dst][0]?.join() !== bytes.join() || out[dst].length !== 1) quiet('an output whose txReady pauses inside the frame', `gave ${out[dst].length} frames, the first ${out[dst][0]?.length ?? 0} bytes long and ${out[dst][0]?.join() === bytes.join() ? 'right' : 'changed'}`);
  }

  // ---- teach again: the table may forget what it has not heard for 1000 cycles
  table.clear();
  p.idle(2000);
  p.take();
  for (let h = 0; h < PORTS_N; h++) expect1(`host ${h} announcing itself again`, h, MAC(h), BROADCAST);

  // ---- three inputs at once, all for one output: each frame comes out whole
  {
    expect1('host 0 announcing itself before the rush', 0, MAC(0), BROADCAST);
    for (const h of [1, 2, 3]) table.set(key(MAC(h)), h);
    const rush = [1, 2, 3].map((h) => frameOf(MAC(h), MAC(0), id++));
    for (let k = 0; k < 2000 && ![1, 2, 3].every((h) => p.rxReady(h)); k++) p.idle(1);
    for (let k = 0; k < rush[0].length; k++) p.step([null, ...rush.map((f) => ({ data: f[k], last: k === f.length - 1, err: false }))]);
    p.settle();
    const out = p.take();
    tested++;
    const had = out[0].map((f) => f.join()), lost = rush.filter((f) => !had.includes(f.join())).length;
    if (lost || out[0].length !== rush.length) quiet('three inputs at once to one output', `${out[0].length} frames came out for ${rush.length} sent, ${lost} of them missing or changed`);
    if (out[1].length + out[2].length + out[3].length) quiet('three inputs at once to one output', 'a frame came out of a port other than the destination\'s');
  }

  // ---- throughput: every port at full load, each to the next
  {
    const warm = 1000, cycles = 4000;
    const st = [0, 1, 2, 3].map((i) => ({ bytes: frameOf(MAC(i), MAC((i + 1) % PORTS_N), id++, SW_THROUGHPUT_BYTES), k: -1, gap: 0 }));
    let delivered = 0;
    // the first frames tell the table where every host is, whatever it forgot while it stood idle; only what follows counts
    for (let c = -warm; c < cycles; c++) {
      if (c === 0) p.take();
      const feed = st.map((s, i) => {
        if (s.k < 0) { if (s.gap > 0) { s.gap--; return null; } if (!p.rxReady(i)) return null; s.k = 0; s.bytes = frameOf(MAC(i), MAC((i + 1) % PORTS_N), id++, SW_THROUGHPUT_BYTES); }
        const data = s.bytes[s.k], last = s.k === s.bytes.length - 1;
        if (last) { s.k = -1; s.gap = SW_THROUGHPUT_GAP; } else s.k++;
        return { data, last, err: false };
      });
      p.step(feed);
    }
    const out = p.take();
    for (let j = 0; j < PORTS_N; j++) for (const f of out[j]) { delivered += f.length; if (key(f.slice(0, 6)) !== key(MAC(j))) quiet('at full load', `port ${j} delivered a frame for another host: flooded, so its table had lost the address`); }
    // a line carries a byte a cycle, less the idle cycles the bench leaves between frames
    const carried = delivered / (cycles * PORTS_N) / (SW_THROUGHPUT_BYTES / (SW_THROUGHPUT_BYTES + SW_THROUGHPUT_GAP));
    tested++;
    if (carried < SW_THROUGHPUT) quiet('at full load', `the outputs carried ${(100 * carried).toFixed(0)} % of the line rate; the sheet asks for ${(100 * SW_THROUGHPUT).toFixed(0)} %`);
  }
  return finish(fails, tested, def, { cycles: p.cycles });
}
