// Chapter 43's UART as a golden model, edge by edge (DOM-free). lib/uart.ts builds the same machine in gates and
// tests/comm-uart.test.ts compares them on every output every cycle; bus/model.ts wraps the same stepper as the
// computer's UART device, so the instruction-level model and the gates share one description of the timing.
//
// Frame: the 8N1 of comm/startstop.ts (line idles at 1; start 0, eight data bits LSB first, stop 1). Every unit is 16
// ticks of the baud generator, a tick being `div` clock cycles. Reset is all zeros in the gates; polarities are chosen
// so that zero is idle (the transmitter stores the inverse of its line, the receiver synchronizes the inverse of its
// input), and this model starts in exactly that state.

export const UART_DIV_BITS = 12;
export const FIFO_DEPTH = 16;
/** Ticks per bit: the oversampling factor. */
export const OVERSAMPLE = 16;

/** Receiver states (the 3-bit code in the gates). */
export const RX_IDLE = 0, RX_START = 1, RX_DATA = 2, RX_STOP = 3, RX_BREAK = 4;
export const RX_STATE_NAMES = ['idle', 'start', 'data', 'stop', 'break'];

/** Status register bits. */
export const ST_RXNE = 1, ST_TXFULL = 2, ST_TXIDLE = 4, ST_FRAMING = 8, ST_OVERRUN = 16;
/** Interrupt enable bits. */
export const IE_RX = 1, IE_TX = 2;

export interface UartIn {
  /** The line level at the receiving pin, before the edge. */
  rx: number;
  /** Write a byte to the transmit FIFO (dropped when it is full). */
  push?: boolean;
  data?: number;
  /** Take the oldest received byte. */
  pop?: boolean;
  /** Register writes, all with `wval`: the divisor (12 bits), the interrupt enables, a write-one-to-clear of the error flags. */
  divWe?: boolean;
  ieWe?: boolean;
  clrWe?: boolean;
  wval?: number;
}

/** Everything the core shows at its pins after an edge. */
export interface UartOut { tx: number; rxData: number; status: number; div: number; ie: number; irq: number }

/** The transmitter + receiver + FIFOs + registers (lib/uart.ts UART_CORE), one `edge` a rising clock edge. */
export class UartCore {
  // baud generator
  cnt = 0;
  div = 0;
  ie = 0;
  // transmitter
  txq: number[] = [];
  tBusy = false;
  tSh = 0;
  tTc = 0;
  tBc = 0;
  /** The inverse of the line level, so that zero is idle. */
  ntx = 0;
  // receiver: the inverse of the input through two flip-flops (1 = the line is low)
  n1 = 0;
  n2 = 0;
  st = RX_IDLE;
  rTc = 0;
  rBc = 0;
  sr = 0;
  rxq: number[] = [];
  fe = false;
  ovr = false;
  /** Pulses of the last edge, for the tests and the panels. */
  lastPush = false;
  lastFerr = false;
  lastLoad = false;
  ticks = 0;

  get tick(): boolean { return this.cnt <= 1; }
  get tx(): number { return this.ntx ? 0 : 1; }
  get txIdle(): boolean { return this.txq.length === 0 && !this.tBusy; }
  get rxData(): number { return this.rxq.length ? this.rxq[0] : 0; }
  get status(): number {
    return (this.rxq.length ? ST_RXNE : 0) | (this.txq.length === FIFO_DEPTH ? ST_TXFULL : 0) | (this.txIdle ? ST_TXIDLE : 0) | (this.fe ? ST_FRAMING : 0) | (this.ovr ? ST_OVERRUN : 0);
  }
  get irq(): number { return ((this.ie & IE_RX) && this.rxq.length) || ((this.ie & IE_TX) && this.txq.length === 0) ? 1 : 0; }
  out(): UartOut { return { tx: this.tx, rxData: this.rxData, status: this.status, div: this.div, ie: this.ie, irq: this.irq }; }

  edge(i: UartIn): void {
    const tick = this.tick, lo = this.n2 === 1;
    this.lastPush = this.lastFerr = this.lastLoad = false;

    // ---- receiver (from the state before the edge)
    let st = this.st, rTc = this.rTc, rBc = this.rBc, sr = this.sr;
    let push = false, ferr = false;
    if (tick) {
      const tc = this.rTc;
      rTc = (tc + 1) & 15;
      switch (this.st) {
        case RX_IDLE: if (lo) { st = RX_START; rTc = 0; } break;
        case RX_START:
          if (tc === 7) { if (lo) { st = RX_DATA; rTc = 0; rBc = 0; } else st = RX_IDLE; }
          break;
        case RX_DATA:
          if (tc === 15) {
            sr = (sr >> 1) | (lo ? 0 : 0x80);
            const b = this.rBc;
            rBc = (b + 1) & 7;
            if (b === 7) st = RX_STOP;
          }
          break;
        case RX_STOP:
          if (tc === 15) { if (!lo) { push = true; st = RX_IDLE; } else { ferr = true; st = RX_BREAK; } }
          break;
        default: if (!lo) st = RX_IDLE;
      }
    }

    // ---- transmitter
    const load = !this.tBusy && this.txq.length > 0;
    let tBusy = this.tBusy, tSh = this.tSh, tTc = this.tTc, tBc = this.tBc, ntx = this.ntx;
    if (load) {
      tSh = (1 << 9) | (this.txq[0] << 1);
      tBusy = true; tTc = 0; tBc = 0;
    } else if (this.tBusy && tick) {
      ntx = (this.tSh & 1) ? 0 : 1;
      tTc = (this.tTc + 1) & 15;
      if (this.tTc === 15) {
        tSh = (1 << 9) | (this.tSh >> 1);
        tBc = (this.tBc + 1) & 15;
        if (this.tBc === 9) tBusy = false;
      }
    }

    // ---- FIFOs and flags (full / empty before the edge)
    const txFull = this.txq.length === FIFO_DEPTH, rxFull = this.rxq.length === FIFO_DEPTH, rxEmpty = this.rxq.length === 0;
    const txq = this.txq.slice(), rxq = this.rxq.slice();
    if (load) txq.shift();
    if (i.push && !txFull) txq.push((i.data ?? 0) & 255);
    if (i.pop && !rxEmpty) rxq.shift();
    if (push && !rxFull) rxq.push(this.sr);
    const wval = i.wval ?? 0;
    const fe = (this.fe && !(i.clrWe && (wval & ST_FRAMING))) || ferr;
    const ovr = (this.ovr && !(i.clrWe && (wval & ST_OVERRUN))) || (push && rxFull);

    // ---- baud generator and registers
    const cnt = tick ? this.div : (this.cnt - 1) & ((1 << UART_DIV_BITS) - 1);
    if (i.divWe) this.div = wval & ((1 << UART_DIV_BITS) - 1);
    if (i.ieWe) this.ie = wval & 3;

    this.cnt = cnt;
    this.n2 = this.n1; this.n1 = i.rx ? 0 : 1;
    this.st = st; this.rTc = rTc; this.rBc = rBc; this.sr = sr;
    this.tBusy = tBusy; this.tSh = tSh; this.tTc = tTc; this.tBc = tBc; this.ntx = ntx;
    this.txq = txq; this.rxq = rxq; this.fe = fe; this.ovr = ovr;
    this.lastPush = push; this.lastFerr = ferr; this.lastLoad = load;
    this.ticks += tick ? 1 : 0;
  }
}

/** Receiver samples are taken at tick 8 after the detecting tick, then every 16: the instants, in ticks after the detecting tick. */
export const sampleTicks = (n = 10): number[] => Array.from({ length: n }, (_, k) => 8 + 16 * k);

// ---- line stimulus ---------------------------------------------------------------------------------------------------------

/**
 * The line level a transmitter whose bit lasts `bitClocks` receiver clock cycles (not necessarily an integer: its clock is
 * off) shows to the receiver at its clock edge k, for the frames of `bytes` starting at receiver cycle `t0` (any real
 * number: the start edge falls anywhere in a receiver tick), `gap` idle bit times between frames.
 */
export function lineStream(bytes: readonly number[], bitClocks: number, t0: number, gap = 0): (k: number) => number {
  const frame = 10 + gap;
  return (k) => {
    const u = (k - t0) / bitClocks;
    if (u < 0) return 1;
    const f = Math.floor(u / frame), r = u - f * frame;
    if (f >= bytes.length || r >= 10) return 1;
    const unit = Math.floor(r);
    return unit === 0 ? 0 : unit === 9 ? 1 : (bytes[f] >> (unit - 1)) & 1;
  };
}

/** Run a receiver (a UartCore with the divisor set) over a line, edge by edge; returns the bytes it pushed, the flags raised. */
export function receiveBytes(div: number, line: (k: number) => number, edges: number): { bytes: number[]; framing: number; overrun: boolean } {
  const u = new UartCore();
  u.edge({ rx: 1, divWe: true, wval: div });
  const bytes: number[] = [];
  let framing = 0, ovr = false;
  for (let k = 0; k < edges; k++) {
    u.edge({ rx: line(k), pop: u.rxq.length > 0 });
    if (u.lastPush) bytes.push(u.rxq[u.rxq.length - 1]);
    if (u.lastFerr) framing++;
    if (u.ovr) ovr = true;
  }
  return { bytes, framing, overrun: ovr };
}

// ---- rates -----------------------------------------------------------------------------------------------------------------

/** The divisor that gets nearest to `baud` from `clockHz` (a tick every `div` cycles, 16 ticks a bit), and what it gives. */
export function divisorFor(clockHz: number, baud: number): { div: number; actual: number; error: number } {
  const ideal = clockHz / (OVERSAMPLE * baud);
  const div = Math.max(1, Math.min((1 << UART_DIV_BITS) - 1, Math.round(ideal)));
  const actual = clockHz / (OVERSAMPLE * div);
  return { div, actual, error: actual / baud - 1 };
}

/** Bytes per second at `baud` for an 8N1 frame. */
export const bytesPerSecond = (baud: number): number => baud / 10;

/**
 * How many bytes a FIFO of `depth` holds back for: the time before it overflows when nobody drains it, at `baud`,
 * in microseconds, and how many interrupts a second one every `level` bytes costs.
 */
export function fifoBudget(baud: number, depth: number, level: number): { fillUs: number; irqPerSecond: number; slackUs: number } {
  const byteUs = 1e6 * 10 / baud;
  return { fillUs: depth * byteUs, irqPerSecond: baud / 10 / level, slackUs: (depth - level) * byteUs };
}

/**
 * The receiver's tolerance to a sender whose bit is off, as a fraction of a bit: the prediction of comm/startstop.ts
 * (tolerance(UART_8N1, { ticks: 16, pos: 0.5 }, 5e-4)) and what the model, equal to the gates, measures at three divisors
 * (tests/comm-uart.test.ts pins both). A sender slower than the receiver is the receiver being fast; the stop bit's sample
 * then lands early. The difference is the synchronizer's two cycles, 2 / (16 · div) of a bit, and the 0.0005 search step.
 */
export const UART_TOLERANCE = {
  predicted: { senderFast: 0.0485, senderSlow: 0.0555 },
  measured: [
    { div: 1, senderFast: 0.05, senderSlow: 0.0555 },
    { div: 4, senderFast: 0.05, senderSlow: 0.0555 },
    { div: 16, senderFast: 0.049, senderSlow: 0.056 },
  ],
} as const;
