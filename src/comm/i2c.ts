// I²C, DOM-free: the controller and target that the gate-level circuits in lib/i2c.ts follow cycle for cycle, and a wired-AND
// bus to run them on. Lines are active low in the circuits: `sda_o` = 1 means "pull SDA to ground"; a line reads 1 only when
// nobody pulls it.

export const START = 0, WRITE = 1, READ = 2, STOP = 3;
export const CMD_NAMES = ['START', 'WRITE', 'READ', 'STOP'];

export interface CtlIn { rst: number; go: number; cmd: number; din: number; sda_i: number; scl_i: number }
export interface CtlOut { ready: number; dout: number; ack: number; lost: number; sda_o: number; scl_o: number }

/** Clocks per SCL phase: a bit cell has four phases (SCL low and SDA set, SCL released, SCL high and sampled, SCL pulled low). */
export const CLOCKS_PER_PHASE = 2;

/**
 * The controller: one command at a time (START, WRITE a byte and read the ACK, READ a byte and send ACK or NACK, STOP), each a
 * sequence of four phases of two clocks. SDA is sampled at the end of the SCL-high phase; a bit the controller released (sent as 1)
 * and then read as 0 has lost arbitration: it lets go of both lines at once. Phase 1 waits until SCL really reads high
 * (clock stretching, and the clock synchronization of two controllers).
 */
export class I2cController {
  act = 0; cmd = 0; ph = 0; pre = 0; bc = 0; sh = 0; ack = 0; lost = 0; sda_o = 0; scl_o = 0; sda_s = 1; scl_s = 1;
  step(i: CtlIn): void {
    const w = { ...this };
    this.sda_s = i.sda_i & 1; this.scl_s = i.scl_i & 1;
    if (i.rst) { this.act = 0; this.cmd = 0; this.ph = 0; this.pre = 0; this.bc = 0; this.sh = 0; this.ack = 0; this.lost = 0; this.sda_o = 0; this.scl_o = 0; return; }
    const byte = w.cmd === WRITE || w.cmd === READ;
    const goEff = !w.act && i.go && (!w.lost || i.cmd === START);
    const adv = w.act && w.pre === 1 && !(w.ph === 1 && !w.scl_s);
    const lostNow = adv && w.ph === 2 && w.cmd === WRITE && w.bc < 8 && ((w.sh >> 7) & 1) === 1 && w.sda_s === 0;
    const fin = adv && w.ph === 3 && (!byte || w.bc >= 8);
    this.pre = w.act && !w.pre ? 1 : 0;
    if (goEff) {
      this.act = 1; this.cmd = i.cmd & 3; this.ph = 0; this.pre = 0; this.bc = 0; this.sh = i.din & 255; this.ack = i.din & 1; this.lost = 0;
      this.drive(i.cmd & 3, 0, i.cmd === WRITE ? (i.din >> 7) & 1 : 1, 0);
      return;
    }
    if (!w.act) return;
    if (lostNow) { this.lost = 1; this.act = 0; this.sda_o = 0; this.scl_o = 0; this.pre = 0; return; }
    if (!adv) return;
    if (w.ph === 2 && w.cmd === READ && w.bc < 8) this.sh = ((w.sh << 1) | w.sda_s) & 255;
    if (w.ph === 2 && w.cmd === WRITE && w.bc >= 8) this.ack = w.sda_s ? 0 : 1;
    if (w.ph === 3 && w.cmd === WRITE && w.bc < 8) this.sh = (w.sh << 1) & 255;
    if (w.ph === 3 && byte) this.bc = w.bc + 1;
    this.ph = (w.ph + 1) & 3;
    if (fin) { this.act = 0; this.pre = 0; return; }
    // entering phase q of the cell: the line values for it
    const bcN = w.ph === 3 && byte ? w.bc + 1 : w.bc;
    const shN = w.ph === 3 && w.cmd === WRITE && w.bc < 8 ? (w.sh << 1) & 255 : w.sh;
    const sbit = w.cmd === WRITE ? (bcN < 8 ? (shN >> 7) & 1 : 1) : bcN < 8 ? 1 : w.ack ? 1 : 0;
    this.drive(w.cmd, (w.ph + 1) & 3, sbit, w.sda_o);
  }
  /** Line drives on entering phase q (START / STOP: a fixed table; a byte: SCL low in phases 0 and 3, SDA set once per cell). */
  private drive(cmd: number, q: number, sbit: number, holdSda: number): void {
    if (cmd === START) { this.scl_o = q === 0 || q === 3 ? 1 : 0; this.sda_o = q >= 2 ? 1 : 0; }
    else if (cmd === STOP) { this.scl_o = q === 0 ? 1 : 0; this.sda_o = q < 2 ? 1 : 0; }
    else { this.scl_o = q === 0 || q === 3 ? 1 : 0; this.sda_o = q === 0 ? 1 - sbit : holdSda; }
  }
  get out(): CtlOut { return { ready: this.act ? 0 : 1, dout: this.sh, ack: this.ack, lost: this.lost, sda_o: this.sda_o, scl_o: this.scl_o }; }
}

export interface TgtIn { rst: number; sda_i: number; scl_i: number; adr: number; stretch: number }
export interface TgtOut { sda_o: number; scl_o: number }
/** Target phases. */
export const T_IDLE = 0, T_ADDR = 1, T_AACK = 2, T_WR = 3, T_WACK = 4, T_RD = 5, T_RACK = 6;

/**
 * A target with four 8-bit registers (a sensor, or a tiny EEPROM): after its address with R/W = 0 the first byte sets the register
 * pointer, later bytes are written at the pointer, and the pointer increments after each byte; with R/W = 1 it sends the register
 * at the pointer and goes on with the next while the controller ACKs. START, STOP, rising and falling SCL are found from the
 * sampled lines (two samples each). It can stretch SCL for `stretch` clocks before the first data bit of a read.
 */
export class I2cTarget {
  mem = [0, 0, 0, 0];
  sda_s = 1; scl_s = 1; sda_p = 1; scl_p = 1;
  phase = T_IDLE; n = 0; sh = 0; rw = 0; ptr = 0; pnext = 0; mack = 0; sda_o = 0; scl_o = 0; wpend = 0; scnt = 0;
  step(i: TgtIn): void {
    const w = { ...this };
    this.sda_s = i.sda_i & 1; this.scl_s = i.scl_i & 1; this.sda_p = w.sda_s; this.scl_p = w.scl_s;
    if (i.rst) { this.phase = T_IDLE; this.n = 0; this.sh = 0; this.rw = 0; this.ptr = 0; this.pnext = 0; this.mack = 0; this.sda_o = 0; this.scl_o = 0; this.wpend = 0; this.scnt = 0; return; }
    const rise = w.scl_s === 1 && w.scl_p === 0, fall = w.scl_s === 0 && w.scl_p === 1;
    const start = w.scl_s === 1 && w.scl_p === 1 && w.sda_p === 1 && w.sda_s === 0;
    const stop = w.scl_s === 1 && w.scl_p === 1 && w.sda_p === 0 && w.sda_s === 1;
    // the write the last byte asked for
    this.wpend = 0;
    if (w.wpend) { this.mem[w.ptr] = w.sh; this.ptr = (w.ptr + 1) & 3; }
    // stretching: SCL is held for `scnt` more clocks
    if (w.scl_o) { this.scnt = (w.scnt - 1) & 7; this.scl_o = this.scnt !== 0 ? 1 : 0; }
    if (start) { this.phase = T_ADDR; this.n = 0; this.sda_o = 0; return; }
    if (stop) { this.phase = T_IDLE; this.sda_o = 0; this.scl_o = 0; this.scnt = 0; return; }
    const rbit = w.sda_s;
    switch (w.phase) {
      case T_ADDR:
        if (rise) {
          const byte = ((w.sh << 1) | rbit) & 255;
          this.sh = byte; this.n = (w.n + 1) & 7;
          if (w.n === 7) {
            this.rw = byte & 1;
            this.phase = (byte >> 1) === (i.adr & 127) ? T_AACK : T_IDLE;
            this.pnext = 1;
          }
        }
        break;
      case T_AACK:
      case T_WACK:
        if (fall) {
          if (!w.sda_o) this.sda_o = 1;
          else {
            this.sda_o = 0; this.n = 0;
            if (w.phase === T_AACK && w.rw) {
              const d = this.mem[w.ptr];
              this.phase = T_RD; this.sh = d; this.sda_o = (d >> 7) & 1 ? 0 : 1;
              this.scnt = i.stretch & 7; this.scl_o = (i.stretch & 7) !== 0 ? 1 : 0;
            } else this.phase = T_WR;
          }
        }
        break;
      case T_WR:
        if (rise) {
          const byte = ((w.sh << 1) | rbit) & 255;
          this.sh = byte; this.n = (w.n + 1) & 7;
          if (w.n === 7) {
            if (w.pnext) { this.ptr = byte & 3; this.pnext = 0; } else this.wpend = 1;
            this.phase = T_WACK;
          }
        }
        break;
      case T_RD:
        if (fall) {
          if (w.n === 7) { this.sda_o = 0; this.phase = T_RACK; } else {
            this.sh = (w.sh << 1) & 255; this.n = w.n + 1; this.sda_o = (w.sh >> 6) & 1 ? 0 : 1;
          }
        }
        break;
      case T_RACK:
        if (rise) this.mack = rbit ? 0 : 1;
        if (fall) {
          if (w.mack) {
            const p = (w.ptr + 1) & 3;
            const d = this.mem[p];
            this.ptr = p; this.sh = d; this.sda_o = (d >> 7) & 1 ? 0 : 1; this.n = 0; this.phase = T_RD;
          } else this.phase = T_IDLE;
        }
        break;
      default:
    }
  }
  get out(): TgtOut { return { sda_o: this.sda_o, scl_o: this.scl_o }; }
}

// ---- a wired-AND bus ---------------------------------------------------------------------------------------------------

/** A line is 1 only if nobody pulls it low. */
export const wiredAnd = (pulls: number[]): number => (pulls.some((p) => p) ? 0 : 1);

/** One clock of a bus: every controller and target sees the lines as the drivers left them after the last clock. */
export interface BusAgent { step(sda: number, scl: number): { sda_o: number; scl_o: number } }
export function runBus(agents: BusAgent[], clocks: number, onClock?: (c: number, sda: number, scl: number) => void): void {
  let sda = 1, scl = 1;
  for (let c = 0; c < clocks; c++) {
    const outs = agents.map((a) => a.step(sda, scl));
    sda = wiredAnd(outs.map((o) => o.sda_o));
    scl = wiredAnd(outs.map((o) => o.scl_o));
    onClock?.(c, sda, scl);
  }
}
