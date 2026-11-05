// The TLS computer for the harness: FastISS as the system CPU with M (cycles = mtime: one per instruction, a divide 34), RAM of TLS_RAM_WORDS,
// and a device window at IO.base whose registers the program writes to send, receive and mark. DOM-free; no node: imports.

import { DEV, FastISS } from '../../riscv/fastiss';
import { IO, MEM, TLS_RAM_WORDS } from './layout';

export interface Mark { id: number; cycles: number; instrs: number }
export type MachineRequest = { kind: 'send'; addr: number; len: number } | { kind: 'recv'; addr: number; len: number } | { kind: 'idle' } | { kind: 'budget' };

export class TlsMachine extends FastISS {
  private ioAddr = 0;
  private ioLen = 0;
  private req: MachineRequest | null = null;
  /** Markers written since the last drain (id, cycle count, instructions retired at the write). */
  marks: Mark[] = [];

  /** m: false makes every M instruction illegal (a trap to address 0): a run to the end is proof that the program is plain RV32I. */
  constructor(words: ArrayLike<number>, opts: { m?: boolean } = {}) {
    super(words, { system: true, m: opts.m ?? true, dmemWords: TLS_RAM_WORDS, imemWords: 2 ** Math.ceil(Math.log2(words.length + 1)) });
    this.region[IO.base >>> 28] = DEV;
  }

  protected override ioRead(addr: number): number {
    if (addr >>> 28 !== IO.base >>> 28) return super.ioRead(addr);
    return addr >>> 0 === IO.addr ? this.ioAddr : addr >>> 0 === IO.len ? this.ioLen : 0;
  }

  protected override ioWrite(addr: number, f3: number, v: number): void {
    if (addr >>> 28 !== IO.base >>> 28) { super.ioWrite(addr, f3, v); return; }
    switch (addr >>> 0) {
      case IO.addr: this.ioAddr = v >>> 0; break;
      case IO.len: this.ioLen = v >>> 0; break;
      case IO.send: this.req = { kind: 'send', addr: this.ioAddr, len: this.ioLen }; this.yieldNow = true; break;
      case IO.recv: this.req = { kind: 'recv', addr: this.ioAddr, len: this.ioLen }; this.yieldNow = true; break;
      case IO.mark: this.marks.push({ id: v & 0xffff, cycles: this.mtime, instrs: this.retiredNow }); break;
      case IO.idle: this.req = { kind: 'idle' }; this.yieldNow = true; break;
      default: break;
    }
  }

  /** Run until the program asks the harness for something (send, recv, idle) or `budget` instructions have run. */
  runToRequest(budget: number): MachineRequest {
    this.req = null;
    let left = budget;
    while (this.req === null && left > 0) {
      const n = Math.min(left, 2_000_000);
      left -= this.run(n);
      if (this.halted) throw new Error('the TLS program halted');
    }
    return this.req ?? { kind: 'budget' };
  }

  /** Cycles so far (the system CPU's mtime: 1 per instruction, 34 per divide). */
  get cycles(): number { return this.mtime; }

  // ---- RAM access for the harness ----
  bytes(addr: number, n: number): Uint8Array { return this.d8.slice(addr, addr + n); }
  put(addr: number, b: ArrayLike<number>): void { this.d8.set(b as ArrayLike<number> & Iterable<number>, addr); }
  word(addr: number): number { return this.dmem[addr >>> 2] | 0; }
  setWord(addr: number, v: number): void { this.dmem[addr >>> 2] = v >>> 0; }

  /** Run one command of the mailbox to completion (primitives that never talk to the peer); returns the result word. */
  call(cmd: number, args: number[], budget = 2_000_000_000): number {
    args.forEach((a, i) => this.setWord(MEM.cmd + 4 + 4 * i, a));
    this.setWord(MEM.cmd, cmd);
    for (;;) {
      const r = this.runToRequest(budget);
      if (r.kind === 'idle' && this.word(MEM.cmd) === 0) return this.word(MEM.cmd + 64);
      if (r.kind === 'budget') throw new Error(`command ${cmd}: out of budget`);
      if (r.kind !== 'idle') throw new Error(`command ${cmd} asked for ${r.kind}`);
    }
  }
}
