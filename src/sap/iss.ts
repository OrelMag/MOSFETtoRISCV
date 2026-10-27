// SAP-1's golden model, cycle exact: cycle() is one clock period of the hardware. The control word of the current
// step drives the bus; at the rising edge every register whose load line is on takes the bus (the PC counts with CE,
// the flags take the ALU's carry and zero with FI, RAM[MAR] takes the bus with RI); at the falling edge the step
// counter advances (and wraps after T4). HLT gates the clock: while the control word has HLT no edge happens, so the
// machine stays as it is (halted).

import { CTRL, microcode, SAP_STEPS } from './isa';

export interface SapState {
  pc: number; mar: number; ir: number; a: number; b: number; out: number; cf: number; zf: number; step: number;
  ram: number[]; bus: number; cw: number; cycles: number;
}

/** The ALU: A + B, or A − B as A + ¬B + 1; carry out of bit 7 (for SUB: no borrow), zero. */
export function sapAlu(a: number, b: number, su: number): { sum: number; cf: number; zf: number } {
  const s = a + (su ? ~b & 0xff : b) + (su ? 1 : 0);
  return { sum: s & 0xff, cf: s >> 8, zf: (s & 0xff) === 0 ? 1 : 0 };
}

export class SapISS {
  pc = 0;
  mar = 0;
  ir = 0;
  a = 0;
  b = 0;
  out = 0;
  cf = 0;
  zf = 0;
  step = 0;
  ram = new Uint8Array(16);
  /** The last cycle's bus value and control word (before its rising edge). */
  bus = 0;
  cw = 0;
  /** Clock periods run (a halted machine counts none). */
  cycles = 0;

  constructor(bytes: ArrayLike<number> = []) {
    for (let i = 0; i < Math.min(16, bytes.length); i++) this.ram[i] = bytes[i] & 0xff;
  }

  /** The control word of the current step. */
  control(): number { return microcode(this.ir >> 4, this.step, this.cf, this.zf); }

  /** HLT is on: the clock is gated off. */
  get halted(): boolean { return (this.control() & CTRL.hlt) !== 0; }

  /** What the bus carries under a control word (the OR of the enabled drivers: a disabled one reads 0) and how many drive it. */
  drive(cw = this.control()): { bus: number; drivers: number } {
    let bus = 0, drivers = 0;
    const on = (l: keyof typeof CTRL, v: number) => { if (cw & CTRL[l]) { bus |= v; drivers++; } };
    on('co', this.pc);
    on('ro', this.ram[this.mar]);
    on('io', this.ir & 15);
    on('ao', this.a);
    on('eo', sapAlu(this.a, this.b, cw & CTRL.su ? 1 : 0).sum);
    return { bus, drivers };
  }

  /** One clock period; false (nothing happens) while halted. */
  cycle(): boolean {
    const cw = this.control();
    const { bus } = this.drive(cw);
    this.cw = cw;
    this.bus = bus;
    if (cw & CTRL.hlt) return false;
    // rising edge: every load from the values before it
    const alu = sapAlu(this.a, this.b, cw & CTRL.su ? 1 : 0);
    const mar = this.mar;
    if (cw & CTRL.mi) this.mar = bus & 15;
    if (cw & CTRL.ri) this.ram[mar] = bus;
    if (cw & CTRL.ii) this.ir = bus;
    if (cw & CTRL.ai) this.a = bus;
    if (cw & CTRL.bi) this.b = bus;
    if (cw & CTRL.oi) this.out = bus;
    if (cw & CTRL.j) this.pc = bus & 15; // the 161's LOAD has priority over counting
    else if (cw & CTRL.ce) this.pc = (this.pc + 1) & 15;
    if (cw & CTRL.fi) { this.cf = alu.cf; this.zf = alu.zf; }
    // falling edge: the next step
    this.step = this.step + 1 >= SAP_STEPS ? 0 : this.step + 1;
    this.cycles++;
    return true;
  }

  /** Run until HLT or a cycle limit; OUT's values in order (each OUT instruction's value). */
  run(maxCycles = 10000): number[] {
    const outs: number[] = [];
    for (let i = 0; i < maxCycles && !this.halted; i++) {
      const oi = this.control() & CTRL.oi;
      this.cycle();
      if (oi) outs.push(this.out);
    }
    return outs;
  }

  save(): SapState {
    const { pc, mar, ir, a, b, out, cf, zf, step, bus, cw, cycles } = this;
    return { pc, mar, ir, a, b, out, cf, zf, step, bus, cw, cycles, ram: Array.from(this.ram) };
  }

  restore(s: SapState): void {
    ({ pc: this.pc, mar: this.mar, ir: this.ir, a: this.a, b: this.b, out: this.out, cf: this.cf, zf: this.zf, step: this.step,
      bus: this.bus, cw: this.cw, cycles: this.cycles } = s);
    this.ram = Uint8Array.from(s.ram);
  }
}
