// The cycle-exact 6502 (src/m6502/iss.ts) against
//  - SingleStepTests 65x02 (MIT): every bus cycle, final registers and memory. A sample of 25 tests per
//    documented opcode is checked in (tests/m6502/singlestep-sample.json); the full sets (10 000 per
//    opcode) run when scripts/m6502/fetch-tests.mjs has cached them;
//  - Klaus Dormann's 6502 functional test (GPL, cached only): runs to its success trap;
//  - hand-written bus sequences for reset and the interrupt timing.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Cpu6502, FLAG, Ram64, type BusCycle } from '../src/m6502/iss';
import { OPCODES } from '../src/m6502/isa';
import { assemble, toImage } from '../src/m6502/asm';
import { PROGRAMS } from '../src/m6502/programs';
import { breathe } from './setup';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CACHE = here('./m6502/.cache/');

type State = [pc: number, s: number, a: number, x: number, y: number, p: number, ram: number[]];
type Case = [initial: State, final: State, cycles: number[]];

const DOCUMENTED = OPCODES.flatMap((o) => (o ? [o.op.toString(16).padStart(2, '0')] : []));

/** Runs one SingleStepTests case; returns a description of the first difference, or null. */
function runCase(ram: Ram64, [init, fin, cycles]: Case): string | null {
  for (let i = 0; i < init[6].length; i += 2) ram.mem[init[6][i]] = init[6][i + 1];
  const cpu = new Cpu6502(ram);
  [cpu.pc, cpu.s, cpu.a, cpu.x, cpu.y, cpu.p] = init;
  let err: string | null = null;
  const n = cycles.length / 3;
  for (let i = 0; i < n && !err; i++) {
    cpu.tick();
    const [addr, data, w] = [cycles[3 * i], cycles[3 * i + 1], cycles[3 * i + 2]];
    if (cpu.busAddr !== addr || cpu.busData !== data || cpu.busWrite !== (w === 1))
      err = `cycle ${i}: got ${cpu.busAddr.toString(16)} ${cpu.busData.toString(16)} ${cpu.busWrite ? 'w' : 'r'}, ` +
        `want ${addr.toString(16)} ${data.toString(16)} ${w ? 'w' : 'r'}`;
    if (!err && i === 0 && cpu.busSync !== 1) err = 'cycle 0: sync not 1';
    if (!err && i > 0 && cpu.busSync !== 0) err = `cycle ${i}: sync 1`;
  }
  if (!err && !cpu.atBoundary) err = `instruction not finished after ${n} cycles`;
  if (!err) {
    const got = [cpu.pc, cpu.s, cpu.a, cpu.x, cpu.y, cpu.p];
    const names = ['pc', 's', 'a', 'x', 'y', 'p'];
    for (let k = 0; k < 6 && !err; k++) if (got[k] !== fin[k]) err = `${names[k]} = ${got[k].toString(16)}, want ${fin[k].toString(16)}`;
    for (let i = 0; i < fin[6].length && !err; i += 2)
      if (ram.mem[fin[6][i]] !== fin[6][i + 1]) err = `ram[${fin[6][i].toString(16)}] = ${ram.mem[fin[6][i]]}, want ${fin[6][i + 1]}`;
  }
  for (let i = 0; i < init[6].length; i += 2) ram.mem[init[6][i]] = 0;
  for (let i = 0; i < fin[6].length; i += 2) ram.mem[fin[6][i]] = 0;
  return err;
}

interface RawState { pc: number; s: number; a: number; x: number; y: number; p: number; ram: [number, number][] }
interface RawCase { name: string; initial: RawState; final: RawState; cycles: [number, number, string][] }
const state = (s: RawState): State => [s.pc, s.s, s.a, s.x, s.y, s.p, s.ram.flat()];

describe('SingleStepTests sample (checked in)', () => {
  const sample = JSON.parse(readFileSync(here('./m6502/singlestep-sample.json'), 'utf8')) as Record<string, Case[]>;
  it('covers every documented opcode', () => {
    expect(DOCUMENTED.length).toBe(151);
    expect(Object.keys(sample).sort()).toEqual([...DOCUMENTED].sort());
  });
  it('matches every bus cycle, register and byte', () => {
    const ram = new Ram64();
    const fails: string[] = [];
    for (const op of DOCUMENTED) sample[op].forEach((c, i) => {
      const err = runCase(ram, c);
      if (err) fails.push(`${op} #${i}: ${err}`);
    });
    expect(fails.slice(0, 20)).toEqual([]);
  });
});

const fullCached = DOCUMENTED.every((op) => existsSync(CACHE + op + '.json'));
describe.skipIf(!fullCached)('SingleStepTests full sets (cached)', () => {
  for (const op of DOCUMENTED) {
    it(`opcode ${op}: 10 000 tests`, () => {
      const tests = JSON.parse(readFileSync(CACHE + op + '.json', 'utf8')) as RawCase[];
      const ram = new Ram64();
      const fails: string[] = [];
      for (const t of tests) {
        const err = runCase(ram, [state(t.initial), state(t.final), t.cycles.flatMap(([a, d, k]) => [a, d, k === 'write' ? 1 : 0])]);
        if (err && fails.length < 5) fails.push(`${t.name}: ${err}`);
      }
      expect(fails).toEqual([]);
    });
  }
});

const KLAUS = CACHE + '6502_functional_test.bin';
describe.skipIf(!existsSync(KLAUS))('Klaus Dormann functional test (cached)', () => {
  // The success trap of the standard binary (6502_functional_test.lst: "success" at $3469).
  const SUCCESS = 0x3469;
  it('reaches the success trap', async () => {
    const ram = new Ram64();
    ram.load(readFileSync(KLAUS), 0);
    const cpu = new Cpu6502(ram);
    cpu.pc = 0x0400;
    const t0 = performance.now();
    let prev = -1;
    for (let chunk = 0; chunk < 200 && cpu.pc !== prev; chunk++) {
      for (let i = 0; i < 1_000_000; i++) {
        prev = cpu.pc;
        cpu.step();
        if (cpu.pc === prev || cpu.illegal !== null) break;
      }
      await breathe();
    }
    const secs = (performance.now() - t0) / 1000;
    console.log(`Klaus functional test: ${cpu.cycles} cycles in ${secs.toFixed(2)} s, ${(cpu.cycles / secs / 1e6).toFixed(1)} M cycles/s`);
    expect(cpu.illegal).toBeNull();
    expect(cpu.pc.toString(16)).toBe(SUCCESS.toString(16));
  }, 60_000);
});

// ---- hand-written bus sequences ----

/** A CPU on RAM loaded with `src` (assembled), PC at `start` unless reset is used. */
function machine(src: string) {
  const asm = assemble(src);
  expect(asm.errors).toEqual([]);
  const ram = new Ram64();
  ram.mem.set(toImage(asm));
  return { cpu: new Cpu6502(ram), ram, asm };
}
const r = (addr: number, data: number, sync: 0 | 1 = 0): BusCycle => ({ addr, data, rw: 'r', sync });
const w = (addr: number, data: number): BusCycle => ({ addr, data, rw: 'w', sync: 0 });
const cycles = (cpu: Cpu6502, n: number) => Array.from({ length: n }, () => cpu.cycle());

describe('reset', () => {
  it('runs the 7-cycle sequence, then fetches at the vector', () => {
    const { cpu } = machine(`*= $0200\n start: lda #1\n *= $FFFC\n .word start`);
    cpu.reset();
    expect(cycles(cpu, 8)).toEqual([
      r(0x0000, 0), r(0x0000, 0), r(0x0100, 0), r(0x01ff, 0), r(0x01fe, 0), r(0xfffc, 0x00), r(0xfffd, 0x02),
      r(0x0200, 0xa9, 1),
    ]);
    expect(cpu.s).toBe(0xfd);
    expect(cpu.p).toBe(FLAG.U | FLAG.I);
  });
  it('step() runs it as one step', () => {
    const { cpu } = machine(`*= $0200\n start: nop\n *= $FFFC\n .word start`);
    cpu.reset();
    expect(cpu.step()).toBe(7);
    expect(cpu.pc).toBe(0x200);
    expect(cpu.step()).toBe(2);
  });
});

describe('interrupts', () => {
  const SRC = `
    *= $0200
    start: cli
    loop:  nop
           nop
           jmp loop
    irq:   rti
    nmi:   rti
    *= $FFFA
    .word nmi, start, irq`;
  const boot = () => {
    const m = machine(SRC);
    m.cpu.reset();
    m.cpu.step(); // reset
    m.cpu.s = 0xff;
    m.cpu.step(); // cli
    return m;
  };

  it('IRQ: polled from the second-to-last cycle; 7-cycle sequence with B = 0', () => {
    const { cpu, asm } = boot();
    const irq = asm.symbols.get('irq')!;
    // nop at $0201: asserting IRQ during its first cycle is seen by the poll in its last cycle.
    cpu.irq = true;
    expect(cpu.cycle()).toEqual(r(0x0201, 0xea, 1));
    expect(cpu.cycle()).toEqual(r(0x0202, 0xea)); // the nop's dummy read (poll: IRQ pending)
    expect(cpu.interruptPending).toBe(true);
    cpu.irq = false; // already taken: releasing it now changes nothing
    expect(cycles(cpu, 7)).toEqual([
      r(0x0202, 0xea, 1), r(0x0202, 0xea), w(0x01ff, 0x02), w(0x01fe, 0x02), w(0x01fd, 0x20),
      r(0xfffe, irq & 0xff), r(0xffff, irq >> 8),
    ]);
    expect(cpu.pc).toBe(irq);
    expect(cpu.p & FLAG.I).toBe(FLAG.I);
    // rti: 6 cycles back to $0202, I clear again.
    expect(cycles(cpu, 6)).toEqual([
      r(irq, 0x40, 1), r(irq + 1, 0x40), r(0x01fc, 0), r(0x01fd, 0x20), r(0x01fe, 0x02), r(0x01ff, 0x02),
    ]);
    expect(cpu.pc).toBe(0x0202);
    expect(cpu.p & FLAG.I).toBe(0);
  });

  it('IRQ asserted only during the last cycle waits one instruction', () => {
    const { cpu } = boot();
    cpu.cycle(); // nop fetch
    cpu.irq = true;
    cpu.cycle(); // nop's last cycle: polls the state of the fetch cycle (not asserted)
    expect(cpu.interruptPending).toBe(false);
    expect(cpu.step()).toBe(2); // next nop: polls the IRQ
    expect(cpu.interruptPending).toBe(true);
    expect(cpu.step()).toBe(7);
  });

  it('IRQ is masked by I; CLI takes effect one instruction late', () => {
    const m = machine(`*= $0200\n start: sei\n cli\n nop\n nop\n irq: rti\n *= $FFFA\n .word irq, start, irq`);
    const { cpu } = m;
    cpu.reset(); cpu.step();
    cpu.irq = true;
    cpu.step(); // sei
    expect(cpu.interruptPending).toBe(false);
    cpu.step(); // cli: polls with I still set
    expect(cpu.interruptPending).toBe(false);
    cpu.step(); // nop: I clear now
    expect(cpu.interruptPending).toBe(true);
    expect(cpu.pc).toBe(0x0203);
    expect(cpu.step()).toBe(7);
    expect(m.ram.mem[0x01fb]).toBe(0x20); // pushed P: I clear, B clear
  });

  it('NMI: edge-triggered, B = 0, vector $FFFA; a held line does not retrigger', () => {
    const { cpu, asm, ram } = boot();
    const nmi = asm.symbols.get('nmi')!;
    cpu.nmi = true;
    cpu.step(); // nop: edge seen in its first cycle
    expect(cpu.interruptPending).toBe(true);
    expect(cpu.step()).toBe(7);
    expect(cpu.pc).toBe(nmi);
    expect(ram.mem[0x01fd] & FLAG.B).toBe(0);
    cpu.step(); // rti, line still low
    expect(cpu.step()).toBe(2);
    expect(cpu.interruptPending).toBe(false);
    cpu.nmi = false;
    cpu.step();
    cpu.nmi = true;
    cpu.step();
    expect(cpu.interruptPending).toBe(true);
  });

  it('NMI during BRK before the P push hijacks the vector (B still pushed 1)', () => {
    const m = machine(`*= $0200\n start: brk\n .byte 0\n irq: rti\n nmi: rti\n *= $FFFA\n .word nmi, start, irq`);
    const { cpu, asm, ram } = m;
    cpu.reset(); cpu.step(); cpu.s = 0xff;
    cycles(cpu, 3); // brk: fetch, pad, push PCH
    cpu.nmi = true;
    cpu.cycle(); // push PCL: the edge is sampled at its end
    const rest = cycles(cpu, 3);
    expect(rest[0]).toEqual(w(0x01fd, 0x34)); // P after reset ($24) with B
    expect(rest[1].addr).toBe(0xfffa);
    expect(cpu.pc).toBe(asm.symbols.get('nmi'));
    expect(ram.mem[0x01fd] & FLAG.B).toBe(FLAG.B);
  });

  it('NMI one cycle later is too late: BRK goes to $FFFE, the NMI follows after one instruction', () => {
    const m = machine(`*= $0200\n start: brk\n .byte 0\n irq: nop\n rti\n nmi: rti\n *= $FFFA\n .word nmi, start, irq`);
    const { cpu, asm } = m;
    cpu.reset(); cpu.step(); cpu.s = 0xff;
    cycles(cpu, 4);
    cpu.nmi = true;
    const rest = cycles(cpu, 3);
    expect(rest[1].addr).toBe(0xfffe);
    expect(cpu.interruptPending).toBe(false); // the sequence does not poll
    expect(cpu.step()).toBe(2); // the handler's first instruction runs
    expect(cpu.interruptPending).toBe(true);
    cpu.step();
    expect(cpu.pc).toBe(asm.symbols.get('nmi'));
  });

  it('a taken branch within a page does not poll on its last cycle', () => {
    const m = machine(`*= $0200\n start: cli\n clc\n bcc next\n next: nop\n nop\n irq: rti\n *= $FFFA\n .word irq, start, irq`);
    const { cpu } = m;
    cpu.reset(); cpu.step(); cpu.step(); cpu.step(); // reset, cli, clc
    cpu.cycle(); // bcc fetch
    cpu.cycle(); // operand: polls (nothing)
    cpu.irq = true;
    cpu.cycle(); // taken, same page: no poll
    expect(cpu.atBoundary).toBe(true);
    expect(cpu.interruptPending).toBe(false);
    expect(cpu.step()).toBe(2); // nop runs first
    expect(cpu.interruptPending).toBe(true);
  });

  it('a taken branch across a page polls at its fix-up cycle', () => {
    const m = machine(`*= $02FB
 start: cli
 clc
 bcc next
 nop
 next: nop
 irq: rti
 *= $FFFA
 .word irq, start, irq`);
    const { cpu } = m;
    cpu.reset(); cpu.step(); cpu.step(); cpu.step();
    expect(cpu.pc).toBe(0x02fd);
    expect(cycles(cpu, 2)).toEqual([r(0x02fd, 0x90, 1), r(0x02fe, 0x01)]); // operand: polls (nothing)
    cpu.irq = true;
    expect(cpu.cycle()).toEqual(r(0x02ff, 0xea)); // taken: reads the next opcode, adds to PCL
    expect(cpu.interruptPending).toBe(false);
    expect(cpu.cycle()).toEqual(r(0x0200, 0)); // PCH not fixed yet: reads $0200; polls the cycle before
    expect(cpu.interruptPending).toBe(true);
    expect(cpu.pc).toBe(0x0300);
  });

  it('illegal opcodes stop the CPU on the opcode', () => {
    const { cpu } = machine(`*= $0200\n start: nop\n .byte $02\n *= $FFFC\n .word start`);
    cpu.reset(); cpu.step(); cpu.step();
    expect(cpu.step()).toBe(1);
    expect(cpu.illegal).toBe(0x02);
    expect(cpu.pc).toBe(0x0201);
    expect(cpu.cycle()).toEqual(r(0x0201, 0x02));
  });

  it('save / restore mid-instruction replays the same cycles', () => {
    const { cpu, ram } = machine(`*= $0200\n start: ldx #$FF\n inc $10F0,X\n jsr sub\n sub: jmp sub\n *= $FFFC\n .word start`);
    cpu.reset(); cpu.step(); cpu.step();
    cycles(cpu, 3);
    const st = cpu.save(), mem = ram.mem.slice();
    const a = cycles(cpu, 12);
    cpu.restore(st); ram.mem.set(mem);
    expect(cycles(cpu, 12)).toEqual(a);
    expect(a.slice(0, 4).map((c) => c.addr)).toEqual([0x10ef, 0x11ef, 0x11ef, 0x11ef]);
  });
});

describe('sample programs', () => {
  const run = (name: string, opts: { irqEvery?: number } = {}) => {
    const prog = PROGRAMS.find((p) => p.name === name)!;
    const asm = assemble(prog.source);
    expect(asm.errors).toEqual([]);
    const out: number[] = [];
    let irqLine = false;
    const ram = new Ram64();
    ram.mem.set(toImage(asm));
    const bus = {
      read: (a: number) => ram.mem[a],
      write: (a: number, v: number) => { if (a === 0xf001) out.push(v); else if (a === 0xf002) irqLine = false; else ram.mem[a] = v; },
    };
    const cpu = new Cpu6502(bus);
    cpu.reset();
    let prev = -1;
    for (let i = 0; i < 200_000; i++) {
      if (opts.irqEvery && i % opts.irqEvery === 0) irqLine = true;
      cpu.irq = irqLine;
      prev = cpu.pc;
      cpu.step();
      if (cpu.pc === prev && cpu.atBoundary) break;
    }
    expect(cpu.illegal).toBeNull();
    expect(cpu.pc).toBe(prev);
    return { cpu, ram, out, asm };
  };
  it('hello', () => {
    expect(String.fromCharCode(...run('hello').out)).toBe('HELLO, 6502!');
  });
  it('fib', () => {
    const { ram, asm } = run('fib');
    const lo = asm.symbols.get('FIBLO')!, hi = asm.symbols.get('FIBHI')!;
    const fib = [0, 1];
    while (fib.length < 24) fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
    expect(fib.map((_, i) => ram.mem[lo + i] | (ram.mem[hi + i] << 8))).toEqual(fib);
  });
  it('sort', () => {
    const { ram, asm } = run('sort');
    const at = asm.symbols.get('data')!, n = asm.symbols.get('LEN')!;
    const got = [...ram.mem.slice(at, at + n)];
    expect(got).toEqual([...got].sort((a, b) => a - b));
    expect(got).toEqual([0, 3, 7, 7, 42, 64, 88, 150, 199, 255]);
  });
  it('mul', () => {
    const { ram } = run('mul');
    expect(ram.mem[0x12] | (ram.mem[0x13] << 8)).toBe(200 * 123);
  });
  it('bcd', () => {
    const { ram } = run('bcd');
    expect([ram.mem[0x10], ram.mem[0x11]]).toEqual([0x34, 0x12]);
  });
  it('irq', () => {
    const { ram } = run('irq', { irqEvery: 50 });
    expect(ram.mem[0x10]).toBe(5);
  });
});
