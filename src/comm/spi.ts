// SPI, DOM-free: the master and the target the gate-level circuits in lib/spi.ts follow, cycle for cycle, and the
// mode table (which edge samples and which changes the line) the chapter's waveform widget draws.

/** The four modes: clock polarity (idle level of SCLK) and phase (CPHA = 0: the first edge samples; 1: the first edge changes). */
export interface SpiMode { cpol: 0 | 1; cpha: 0 | 1 }
export const SPI_MODES: SpiMode[] = [{ cpol: 0, cpha: 0 }, { cpol: 0, cpha: 1 }, { cpol: 1, cpha: 0 }, { cpol: 1, cpha: 1 }];
export const modeNumber = (m: SpiMode): number => 2 * m.cpol + m.cpha;

/** Sixteen edges move eight bits; edge e (0 = first) is a rising edge when e is even for CPOL 0, odd for CPOL 1. */
export function edgeKind(m: SpiMode, e: number): { rising: boolean; sample: boolean } {
  const rising = (e + m.cpol) % 2 === 0;
  return { rising, sample: (e % 2 === 0) === (m.cpha === 0) };
}

/** What a mode puts on the wire for one byte each way, as piecewise-constant traces on a grid of half periods. */
export interface SpiTrace { sclk: number[]; mosi: (number | null)[]; miso: (number | null)[]; sampleAt: number[]; changeAt: number[] }
export function spiTrace(m: SpiMode, tx: number, rx: number): SpiTrace {
  // slot k (0 .. 17): the level in the k-th half period; edge e happens at the start of slot e + 1; slot 0 is the idle level
  const sclk: number[] = [m.cpol];
  for (let e = 0; e < 16; e++) sclk.push(e % 2 === 0 ? 1 - m.cpol : m.cpol);
  sclk.push(m.cpol);
  const mosi: (number | null)[] = Array(18).fill(null), miso: (number | null)[] = Array(18).fill(null);
  const sampleAt: number[] = [], changeAt: number[] = [];
  for (let e = 0; e < 16; e++) (edgeKind(m, e).sample ? sampleAt : changeAt).push(e + 1);
  // a bit is on the line from the change before its sample to the change after it (CPHA 0: bit 7 from before the first edge)
  for (let i = 0; i < 8; i++) {
    const s = sampleAt[i];
    const from = m.cpha === 0 ? (i === 0 ? 0 : s - 1) : s - 1, to = m.cpha === 0 ? (i === 7 ? 17 : s + 1) : (i === 7 ? 17 : s + 1);
    for (let k = from; k < to; k++) { mosi[k] = (tx >> (7 - i)) & 1; miso[k] = (rx >> (7 - i)) & 1; }
  }
  return { sclk, mosi, miso, sampleAt, changeAt };
}

// ---- the master -------------------------------------------------------------------------------------------------------

export interface MasterIn { rst: number; start: number; hold: number; cpol: number; cpha: number; tx: number; miso: number }
export interface MasterOut { sclk: number; mosi: number; cs_n: number; rx: number; busy: number; done: number }

/**
 * Registers: busy, ph (the prescaler: SCLK edges every second clock), cnt (5 bits: edges so far, 16 = the tail), sh (transmit bits
 * leave at the top as receive bits enter at the bottom), mo (the MOSI flip-flop), sclk, done. CS is not a flip-flop: cs_n = not (busy or hold), where hold is an input that keeps CS low between the bytes of one transaction.
 */
export class SpiMaster {
  busy = 0; ph = 0; cnt = 0; sh = 0; mo = 0; sclk = 0; done = 0; hold = 0;
  step(i: MasterIn): void {
    this.hold = i.hold & 1;
    if (i.rst) { this.busy = 0; this.ph = 0; this.cnt = 0; this.sh = 0; this.mo = 0; this.sclk = 0; this.done = 0; return; }
    if (!this.busy) {
      this.done = 0;
      this.sclk = i.cpol;
      this.cnt = 0;
      this.ph = 0;
      if (i.start) { this.busy = 1; this.sh = i.tx & 255; this.mo = i.cpha ? 0 : (i.tx >> 7) & 1; }
      return;
    }
    const tick = this.ph === 1, tail = (this.cnt & 16) !== 0;
    this.ph ^= 1;
    if (!tick) return;
    this.cnt = (this.cnt + 1) & 31;
    if (tail) { this.busy = 0; this.done = 1; return; }
    this.sclk ^= 1;
    const sample = ((this.cnt - 1) & 1) === (i.cpha ? 1 : 0);
    if (sample) this.sh = ((this.sh << 1) | (i.miso & 1)) & 255;
    else this.mo = (this.sh >> 7) & 1;
  }
  get out(): MasterOut { return { sclk: this.sclk, mosi: this.mo, cs_n: this.busy || this.hold ? 0 : 1, rx: this.sh, busy: this.busy, done: this.done }; }
}

// ---- the target -------------------------------------------------------------------------------------------------------

export const SPI_READ = 0x03, SPI_WRITE = 0x02;

/**
 * A 256-byte memory behind SPI (a subset of the 25-series command set, mode 0): byte 1 the command (0x03 read, 0x02 write), byte 2 the
 * address, then data bytes at address, address + 1 … while CS stays low. Inputs are sampled on rising SCLK edges; MISO changes on falling ones.
 */
export class SpiTarget {
  mem = new Uint8Array(256);
  cnt = 0; sh = 0; any = 0;
  st = 0; rd = 0; wr = 0; addr = 0; osh = 0;
  csHigh(): void { this.cnt = 0; this.sh = 0; this.any = 0; this.st = 0; this.rd = 0; this.wr = 0; this.addr = 0; this.osh = 0; }
  rising(mosi: number): void {
    this.cnt = (this.cnt + 1) & 7;
    this.sh = ((this.sh << 1) | (mosi & 1)) & 255;
    this.any = 1;
  }
  falling(): void {
    const bc = this.cnt === 0 && this.any === 1;
    if (!bc) { this.osh = (this.osh << 1) & 255; return; }
    if (this.st === 0) {
      this.rd = this.sh === SPI_READ ? 1 : 0;
      this.wr = this.sh === SPI_WRITE ? 1 : 0;
      this.osh = this.mem[this.sh];
      this.st = 1;
    } else if (this.st === 1) {
      this.addr = this.sh;
      this.osh = this.mem[this.sh];
      this.st = 2;
    } else {
      if (this.wr) this.mem[this.addr] = this.sh;
      this.addr = (this.addr + 1) & 255;
      this.osh = this.mem[this.addr];
    }
  }
  get miso(): number { return this.rd && this.st === 2 ? (this.osh >> 7) & 1 : 0; }
}

/** A whole transaction as a master with a loopback to a target: the bytes a master would read back for the bytes it sent. */
export function spiTransfer(t: SpiTarget, bytes: number[]): number[] {
  t.csHigh();
  const got: number[] = [];
  for (const tx of bytes) {
    let rx = 0;
    for (let i = 0; i < 8; i++) {
      // mode 0 / 3 targets sample on the rising edge, change on the falling one; the master reads MISO just before the rising edge
      rx = (rx << 1) | t.miso;
      t.rising((tx >> (7 - i)) & 1);
      t.falling();
    }
    got.push(rx);
  }
  t.csHigh();
  return got;
}

/**
 * What a peer in `m` puts on MISO after `changes` change edges of one byte (CPHA 0: bit 7 is on the line before the first
 * edge; CPHA 1: it appears at the first, leading edge).
 */
export function peerMiso(m: SpiMode, byte: number, changes: number): number {
  const i = m.cpha === 0 ? changes : changes - 1;
  return i >= 0 && i <= 7 ? (byte >> (7 - i)) & 1 : 0;
}
