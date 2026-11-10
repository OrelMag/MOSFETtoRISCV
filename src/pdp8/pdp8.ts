// The DEC PDP-8 (the PDP-8/E's rules: BSW came later, and the 1965 machine had the MQ only with its optional EAE) as a golden model, DOM-free: 4096 words of 12-bit core, the accumulator AC with
// its link L, the program counter PC, the memory address and buffer registers MA / MB, the instruction register IR, the
// MQ, the switch register SR, the console teletype (keyboard and printer flags) and the interrupt system. It does what
// the instruction table (isa/presets.ts PDP8_PRESET) cannot say: indirect addressing through 0010–0017 adds 1 to the
// pointer first (auto-index), operate microinstructions act in a fixed order, the IOTs a device answers.
// Time is counted in memory cycles, the machine's major states: Fetch for every instruction, Defer for an indirect
// reference, Execute for AND / TAD / ISZ / DCA / JMS (a JMP has none, an operate or IOT is Fetch alone).
// Not modelled: the extended memory (one field of 4K), the EAE's multiply / divide (group 3 does CLA, MQA, MQL), the
// teleprinter's 10 characters a second (its flag rises right after a character is printed), other devices.

export const MASK = 0o7777;

export interface Pdp8Step {
  /** Address and word of the instruction. */
  pc: number; word: number;
  /** Memory cycles it took (an interrupt taken after it adds one). */
  cycles: number;
  /** The character it printed, if any. */
  printed?: string;
  /** It halted the machine (HLT), or the interrupt was taken after it. */
  halted?: boolean; interrupt?: boolean;
}

export interface Pdp8State {
  mem: number[]; ac: number; l: number; pc: number; ma: number; mb: number; ir: number; mq: number; sr: number;
  run: boolean; ie: boolean; ionDelay: boolean; prn: boolean; kbd: boolean; kbuf: number; keys: number[];
  out: string; cycles: number; instructions: number;
}

export class Pdp8 {
  mem = new Uint16Array(4096);
  ac = 0; l = 0; pc = 0; ma = 0; mb = 0; ir = 0; mq = 0;
  /** The switch register: the front panel's twelve toggles. */
  sr = 0;
  /** Running (the RUN lamp). */
  run = false;
  /** Interrupts enabled; ION's one-instruction delay. */
  ie = false; ionDelay = false;
  /** Teleprinter ready, keyboard has a character, its buffer, and the keys still to come. */
  prn = false; kbd = false; kbuf = 0; keys: number[] = [];
  /** What the teleprinter printed. */
  out = '';
  cycles = 0; instructions = 0;

  constructor(words: ArrayLike<number> = []) {
    this.load(words);
  }

  /** Core from address 0 (words past 4096 ignored). */
  load(words: ArrayLike<number>, at = 0): void {
    for (let i = 0; i < words.length && at + i < 4096; i++) this.mem[at + i] = words[i] & MASK;
  }

  // ---- the front panel's keys ----------------------------------------------------------------
  /** LOAD ADD: PC = SR. */
  loadAddress(): void { this.pc = this.sr & MASK; this.ma = this.pc; }
  /** DEP: core at PC = SR, then PC + 1. */
  deposit(): void { this.ma = this.pc; this.mb = this.sr & MASK; this.mem[this.ma] = this.mb; this.pc = (this.pc + 1) & MASK; }
  /** EXAM: MB = core at PC, then PC + 1. */
  examine(): void { this.ma = this.pc; this.mb = this.mem[this.ma]; this.pc = (this.pc + 1) & MASK; }
  /** START: AC, L and every flag cleared, interrupts off, running from PC. */
  start(): void {
    this.ac = 0; this.l = 0; this.mq = 0; this.ie = false; this.ionDelay = false; this.prn = false; this.kbd = false;
    this.run = true;
  }
  /** CONT: running again, nothing cleared. */
  cont(): void { this.run = true; }
  stop(): void { this.run = false; }
  /** A key typed at the teletype (taken when the keyboard buffer is free). */
  type(text: string): void {
    for (const ch of text) this.keys.push(ch.charCodeAt(0) & 0o177);
    this.feed();
  }

  private feed(): void {
    if (!this.kbd && this.keys.length) { this.kbuf = 0o200 | this.keys.shift()!; this.kbd = true; }
  }

  /** The effective address of a memory-reference word fetched from `at`, its Defer cycle and auto-index applied. */
  private address(word: number, at: number): { ea: number; defer: boolean } {
    const off = word & 0o177;
    let ea = word & 0o200 ? (at & 0o7600) | off : off;
    const defer = !!(word & 0o400);
    if (defer) {
      if (ea >= 0o10 && ea <= 0o17) this.mem[ea] = (this.mem[ea] + 1) & MASK;
      ea = this.mem[ea];
    }
    return { ea, defer };
  }

  /** One instruction (also when stopped: SING INST). */
  step(): Pdp8Step {
    const at = this.pc;
    this.ma = at; this.mb = this.mem[at]; this.ir = this.mb >> 9;
    const word = this.mb;
    this.pc = (this.pc + 1) & MASK;
    let cycles = 1;
    this.ionDelay = false;
    let printed: string | undefined;
    const op = word >> 9;
    if (op < 6) {
      const { ea, defer } = this.address(word, at);
      if (defer) cycles++;
      this.ma = ea;
      switch (op) {
        case 0: this.mb = this.mem[ea]; this.ac &= this.mb; cycles++; break;
        case 1: {
          this.mb = this.mem[ea];
          const s = this.ac + this.mb;
          if (s > MASK) this.l ^= 1;
          this.ac = s & MASK; cycles++; break;
        }
        case 2: this.mb = (this.mem[ea] + 1) & MASK; this.mem[ea] = this.mb; if (!this.mb) this.pc = (this.pc + 1) & MASK; cycles++; break;
        case 3: this.mb = this.ac; this.mem[ea] = this.ac; this.ac = 0; cycles++; break;
        case 4: this.mb = this.pc; this.mem[ea] = this.pc; this.pc = (ea + 1) & MASK; cycles++; break;
        case 5: this.pc = ea; break;
      }
    } else if (op === 6) printed = this.iot(word);
    else this.operate(word);
    this.instructions++;
    this.cycles += cycles;
    const r: Pdp8Step = { pc: at, word, cycles };
    if (printed !== undefined) r.printed = printed;
    if (!this.run) r.halted = true;
    // an interrupt: a JMS 0 between instructions; ION's own instruction runs one more first. A HLT stops the machine
    // before it: the interrupt waits for CONT (the gates take it at the next Fetch, before the next instruction).
    if (this.run && this.ie && !this.ionDelay && (this.prn || this.kbd)) {
      this.mem[0] = this.pc; this.pc = 1; this.ie = false;
      this.cycles++; r.cycles++; r.interrupt = true;
    }
    return r;
  }

  /** Steps while running, at most n instructions; the number run. */
  runFor(n: number): number {
    let i = 0;
    while (this.run && i < n) { this.step(); i++; }
    return i;
  }

  private iot(word: number): string | undefined {
    const dev = (word >> 3) & 0o77, p = word & 7;
    let printed: string | undefined;
    const skip = () => { this.pc = (this.pc + 1) & MASK; };
    if (dev === 0) {
      if (p === 1) this.ionDelay = this.ie = true;
      else if (p === 2) this.ie = false;
    } else if (dev === 3) { // keyboard: the pulses in order 1, 2, 4
      if (p & 1 && this.kbd) skip();
      if (p & 2) { this.ac = 0; this.kbd = false; }
      if (p & 4) this.ac |= this.kbuf;
      if (p & 2) this.feed();
    } else if (dev === 4) { // teleprinter
      if (p & 1 && this.prn) skip();
      if (p & 2) this.prn = false;
      if (p & 4) {
        const c = this.ac & 0o177;
        printed = String.fromCharCode(c);
        if (c !== 0) this.out += printed;
        this.prn = true;
      }
    }
    return printed;
  }

  private operate(word: number): void {
    const b = (bit: number) => !!(word & bit);
    if (!b(0o400)) { // group 1: CLA CLL, then CMA CML, then IAC, then the rotates (or BSW)
      if (b(0o200)) this.ac = 0;
      if (b(0o100)) this.l = 0;
      if (b(0o40)) this.ac ^= MASK;
      if (b(0o20)) this.l ^= 1;
      if (b(0o1)) { const s = this.ac + 1; if (s > MASK) this.l ^= 1; this.ac = s & MASK; }
      const twice = b(0o2), right = b(0o10), left = b(0o4);
      if (right && !left) for (let k = twice ? 2 : 1; k; k--) { const lo = this.ac & 1; this.ac = (this.ac >> 1) | (this.l << 11); this.l = lo; }
      else if (left && !right) for (let k = twice ? 2 : 1; k; k--) { const hi = this.ac >> 11; this.ac = ((this.ac << 1) & MASK) | this.l; this.l = hi; }
      else if (twice && !left && !right) this.ac = ((this.ac & 0o77) << 6) | (this.ac >> 6);
    } else if (!b(0o1)) { // group 2: the skip test, then CLA, then OSR, then HLT
      const neg = !!(this.ac & 0o4000), zero = this.ac === 0, link = this.l === 1;
      const skip = b(0o10)
        ? (!b(0o100) || !neg) && (!b(0o40) || !zero) && (!b(0o20) || !link)
        : (b(0o100) && neg) || (b(0o40) && zero) || (b(0o20) && link);
      if (skip) this.pc = (this.pc + 1) & MASK;
      if (b(0o200)) this.ac = 0;
      if (b(0o4)) this.ac |= this.sr & MASK;
      if (b(0o2)) this.run = false;
    } else { // group 3 (the MQ): CLA, then MQA / MQL
      if (b(0o200)) this.ac = 0;
      const a = this.ac, q = this.mq;
      if (b(0o100) && b(0o20)) { this.ac = q; this.mq = a; }
      else if (b(0o100)) this.ac = a | q;
      else if (b(0o20)) { this.mq = a; this.ac = 0; }
    }
  }

  save(): Pdp8State {
    return { mem: [...this.mem], ac: this.ac, l: this.l, pc: this.pc, ma: this.ma, mb: this.mb, ir: this.ir, mq: this.mq, sr: this.sr,
      run: this.run, ie: this.ie, ionDelay: this.ionDelay, prn: this.prn, kbd: this.kbd, kbuf: this.kbuf, keys: [...this.keys],
      out: this.out, cycles: this.cycles, instructions: this.instructions };
  }

  restore(s: Pdp8State): void {
    this.mem.set(s.mem);
    Object.assign(this, { ac: s.ac, l: s.l, pc: s.pc, ma: s.ma, mb: s.mb, ir: s.ir, mq: s.mq, sr: s.sr, run: s.run, ie: s.ie, ionDelay: s.ionDelay,
      prn: s.prn, kbd: s.kbd, kbuf: s.kbuf, keys: [...s.keys], out: s.out, cycles: s.cycles, instructions: s.instructions });
  }
}

/** A 12-bit word in octal, four digits. */
export const oct4 = (w: number) => (w & MASK).toString(8).padStart(4, '0');
