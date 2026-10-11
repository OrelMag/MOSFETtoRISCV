// The 4-bit CPU's golden model: one instruction per step (the hardware takes one clock for each),
// the 4004's arithmetic (SUB and DAC with carry = no borrow, DAA, TCS), a three-level return stack
// that drops its oldest entry on a fourth call, SRC + WRR to five output ports, RDR from the
// switches, the TEST pin for JCN. Halts on a JUN to itself.

import { decode4, JCN, PORTS4 } from './isa4';

export interface Step4 {
  pc: number;
  instr: number;
  name: string;
  /** Register written (INC, ISZ, XCH, FIM writes two). */
  regs?: number[];
  /** Output port written (WRR). */
  port?: { n: number; value: number };
}

export interface Iss4State {
  pc: number; a: number; cy: number; src: number; steps: number; halted: boolean;
  r: number[]; stack: number[]; ports: number[];
}

export class Iss4 {
  pc = 0;
  a = 0;
  cy = 0;
  /** Index registers R0–R15 (pair Pn = R2n:R2n+1, the even one high). */
  r = new Uint8Array(16);
  /** Return stack, top first. */
  stack = new Uint8Array(3);
  /** Port address (SRC). */
  src = 0;
  ports = new Uint8Array(PORTS4);
  /** Inputs: the TEST pin and the switches (RDR). */
  test = 0;
  switches = 0;
  steps = 0;
  halted = false;
  readonly rom: Uint16Array;

  constructor(program: ArrayLike<number>) {
    this.rom = new Uint16Array(256);
    for (let i = 0; i < Math.min(256, program.length); i++) this.rom[i] = program[i] & 0xffff;
  }

  pairOf(p: number): number { return (this.r[2 * p] << 4) | this.r[2 * p + 1]; }

  step(): Step4 {
    const pc = this.pc, w = this.rom[pc];
    const d = decode4(w);
    const st: Step4 = { pc, instr: w, name: d.name };
    let next = (pc + 1) & 0xff;
    const { opa, lo } = d;
    const add = (x: number, y: number, c: number) => {
      const s = x + y + c;
      this.a = s & 15;
      this.cy = s >> 4;
    };
    switch (d.name) {
      case 'JCN': {
        const t = ((opa & JCN.AZ) && this.a === 0) || ((opa & JCN.CY) && this.cy === 1) || ((opa & JCN.TEST0) && this.test === 0);
        if (Boolean(t) !== Boolean(opa & JCN.INVERT)) next = lo;
        break;
      }
      case 'FIM': this.r[opa] = lo >> 4; this.r[opa + 1] = lo & 15; st.regs = [opa, opa + 1]; break;
      case 'SRC': this.src = this.pairOf(opa >> 1); break;
      case 'JIN': next = this.pairOf(opa >> 1); break;
      case 'JUN': next = lo; break;
      case 'JMS': this.stack[2] = this.stack[1]; this.stack[1] = this.stack[0]; this.stack[0] = next; next = lo; break;
      case 'INC': this.r[opa] = (this.r[opa] + 1) & 15; st.regs = [opa]; break;
      case 'ISZ':
        this.r[opa] = (this.r[opa] + 1) & 15;
        st.regs = [opa];
        if (this.r[opa] !== 0) next = lo;
        break;
      case 'ADD': add(this.a, this.r[opa], this.cy); break;
      case 'SUB': add(this.a, ~this.r[opa] & 15, this.cy ^ 1); break;
      case 'LD': this.a = this.r[opa]; break;
      case 'XCH': { const t = this.r[opa]; this.r[opa] = this.a; this.a = t; st.regs = [opa]; break; }
      case 'BBL': next = this.stack[0]; this.stack[0] = this.stack[1]; this.stack[1] = this.stack[2]; this.a = opa; break;
      case 'LDM': this.a = opa; break;
      case 'WRR': {
        const n = this.src >> 4;
        if (n < PORTS4) { this.ports[n] = this.a; st.port = { n, value: this.a }; }
        break;
      }
      case 'RDR': this.a = this.switches & 15; break;
      case 'CLB': this.a = 0; this.cy = 0; break;
      case 'CLC': this.cy = 0; break;
      case 'IAC': add(this.a, 1, 0); break;
      case 'CMC': this.cy ^= 1; break;
      case 'CMA': this.a = ~this.a & 15; break;
      case 'RAL': { const c = this.a >> 3; this.a = ((this.a << 1) | this.cy) & 15; this.cy = c; break; }
      case 'RAR': { const c = this.a & 1; this.a = (this.cy << 3) | (this.a >> 1); this.cy = c; break; }
      case 'TCC': this.a = this.cy; this.cy = 0; break;
      case 'DAC': add(this.a, 15, 0); break;
      case 'TCS': this.a = 9 + this.cy; this.cy = 0; break;
      case 'STC': this.cy = 1; break;
      case 'DAA':
        if (this.a > 9 || this.cy) {
          const s = this.a + 6;
          this.a = s & 15;
          if (s > 15) this.cy = 1;
        }
        break;
    }
    if (w === (0x4000 | pc)) this.halted = true;
    this.pc = next;
    this.steps++;
    return st;
  }

  /** Step until halted or `max` steps; returns the steps taken. */
  run(max = 100000): number {
    const s0 = this.steps;
    while (!this.halted && this.steps - s0 < max) this.step();
    return this.steps - s0;
  }

  save(): Iss4State {
    return {
      pc: this.pc, a: this.a, cy: this.cy, src: this.src, steps: this.steps, halted: this.halted,
      r: [...this.r], stack: [...this.stack], ports: [...this.ports],
    };
  }

  restore(s: Iss4State): void {
    Object.assign(this, { pc: s.pc, a: s.a, cy: s.cy, src: s.src, steps: s.steps, halted: s.halted });
    this.r.set(s.r);
    this.stack.set(s.stack);
    this.ports.set(s.ports);
  }
}
