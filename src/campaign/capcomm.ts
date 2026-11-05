// The serial console capstone's bench (DOM-free): a UART with FIFOs built from its register map, judged at its pins by what a far end sees and
// sends. It looks at frames, flags and order, never at internal timing, so any design that meets the sheet passes. Senders and readers here
// run on their own clocks, up to CONSOLE_ERR off.

import type { CustomRun } from '../editor/challenges';
import { IE_RX, IE_TX, OVERSAMPLE, ST_FRAMING, ST_OVERRUN, ST_RXNE, ST_TXFULL, ST_TXIDLE } from '../comm/uart';
import type { ComponentDef } from '../sim/types';
import type { BitSim } from '../sim/bitsim';
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
    for (let k = 0; k < CONSOLE_DEPTH + 4 && p.status & ST_RXNE; k++) { out.push(p.rxData); p.step({ pop: 1 }); p.step(); }
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
    }
    check(full, `the transmit FIFO never reported full after ${sent.length} bytes in a row`);
    check(sent.length >= CONSOLE_DEPTH, `full came after only ${sent.length} bytes: the FIFO holds ${CONSOLE_DEPTH}`);
    untilIdle(unit * 10 * (sent.length + 2));
    p.run(unit);
    const r = readFrames(p.tx.slice(from), unit);
    check(same(r.bytes, sent), `with the FIFO full the far end read [${list(r.bytes)}], sent [${list(sent)}]`);
  }

  // ---- receiving from a far end off in either direction, back to back
  setDiv(1);
  p.run(2);
  for (const err of [0, CONSOLE_ERR, -CONSOLE_ERR]) {
    const bytes = [0x41, 0xc3, 0x00, 0xff, 0x5a, 0xa5, 0x0f, 0xf0], unit = OVERSAMPLE * (1 + err), from = p.cycles + 3;
    p.line = sender(bytes, unit, from);
    p.run(Math.ceil(unit * 10 * bytes.length) + 3 + OVERSAMPLE * 2);
    p.line = () => 1;
    const got = drain();
    check(same(got, bytes), `a sender ${(err * 100).toFixed(1)} % off sent [${list(bytes)}], the FIFO gave [${list(got)}]`);
    check(!(p.status & (ST_FRAMING | ST_OVERRUN)), `a sender ${(err * 100).toFixed(1)} % off left error flags set: status ${hex(p.status)}`);
    check(!(p.status & ST_RXNE), 'status says data waiting after the FIFO was emptied');
    p.step({ clrWe: 1, wval: ST_FRAMING | ST_OVERRUN });
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
    p.step({ clrWe: 1, wval: ST_OVERRUN });
    p.step();
    check(!(p.status & ST_OVERRUN), 'a write of 1 to its status bit did not clear overrun');
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
    p.step({ clrWe: 1, wval: ST_FRAMING });
    p.step();
    check(!(p.status & ST_FRAMING), 'a write of 1 to its status bit did not clear the framing error');
    // and it can still receive
    const after = p.cycles + 3;
    p.line = sender([0x3c], unit, after);
    p.run(unit * 10 + 3 + OVERSAMPLE * 2);
    p.line = () => 1;
    const got = drain();
    check(same(got, [0x3c]), `after a framing error the next good byte gave [${list(got)}]`);
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
  return finish(fails, tested, def, { cycles: p.cycles });
}
