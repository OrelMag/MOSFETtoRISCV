import { describe, expect, it } from 'vitest';
import { BusModel } from '../src/bus/model';
import { busComputer } from '../src/lib/soc';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { randomProgram32 } from '../src/riscv/randprog32';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { ramLeafState } from '../src/lib/bigmem';

const IMEM_K = 8, RAM_K = 10;
const words = (src: string) => {
  const a = assemble(src);
  if (a.errors.length) throw new Error(a.errors[0].message);
  return a.words;
};

/**
 * Run a program on the bus computer at gate level and on the golden model over the same memory map.
 * lock: compare registers and PC after every retired instruction; else only at the end (DMA programs,
 * where the hardware copy takes cycles and the model's is instant).
 */
function run(program: number[], flash: number[] = [], lock = true, max = 30000) {
  const sim = new GateSim(flatten(busComputer(program, flash, { imemK: IMEM_K, ramK: RAM_K })));
  sim.reset('zero');
  sim.setInput('clk', 0); sim.setInput('switches', 0); sim.settle();
  const bus = new BusModel(RAM_K, flash);
  const iss = new ISS(program, { system: true, imemWords: 2 ** IMEM_K, bus });
  const root = sim.design.root, cpu = root.children!.get('cpu')!, rf = cpu.children!.get('rf')!;
  const out = (p: string) => pack(sim.getBits(root.ports[p]));
  const regs = () => [0, ...Array.from({ length: 31 }, (_, i) => pack(sim.getBits(rf.children!.get(`w${i + 1}`)!.ports.q)) >>> 0)];
  let gateConsole = '', cycles = 0, retired = 0;
  for (; cycles < max && !iss.halted; cycles++) {
    const retire = out('retire') === 1;
    if (out('consoleValid') === 1) gateConsole += String.fromCharCode(out('consoleData'));
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    if (!retire) continue;
    retired++;
    if (!lock) continue;
    const info = iss.step();
    const x = regs();
    for (let r = 1; r < 32; r++) expect(x[r], `x${r} after ${info.text} at 0x${info.pc.toString(16)}`).toBe(iss.x[r] >>> 0);
    expect(out('pcOut') >>> 0, `pc after ${info.text}`).toBe(iss.pc >>> 0);
  }
  if (!lock) { let n = 0; while (!iss.halted && n++ < 100000) iss.step(); }
  // RAM: the four byte lanes' leaf states
  const ramNode = root.children!.get('ram')!;
  const lanes = [0, 1, 2, 3].map((i) => ramLeafState(sim, ramNode.children!.get(`lane${i}`))!);
  const ram = (i: number) => ((lanes[0].mem[i] | (lanes[1].mem[i] << 8) | (lanes[2].mem[i] << 16) | (lanes[3].mem[i] << 24)) >>> 0);
  return { iss, bus, regs, cycles, retired, gateConsole, ram };
}

const FIB = `# Fibonacci numbers into RAM, then byte and halfword accesses
        li   t0, 0
        li   t1, 1
        li   t2, 10
        li   a0, 0x100
loop:   add  t3, t0, t1
        mv   t0, t1
        mv   t1, t3
        sw   t3, 0(a0)
        addi a0, a0, 4
        addi t2, t2, -1
        bnez t2, loop
        lw   a1, -4(a0)
        sb   a1, 1(a0)
        lh   a2, 0(a0)
        lbu  a3, 1(a0)
done:   j    done`;

const RAM_CODE = `# write a routine into RAM at 0x400, call it there, come back to the ROM
        li   t1, 0x400
        li   t0, 0x00558593
        sw   t0, 0(t1)
        li   t0, 0x00758593
        sw   t0, 4(t1)
        li   t0, 0x00008067
        sw   t0, 8(t1)
        li   a1, 100
        jalr ra, 0(t1)
        addi a1, a1, 1
done:   j    done`;

/** Runs from RAM at 0x400 after the boot ROM copied it there: prints OK. */
const PAYLOAD = `        li   t0, 0x80000000
        li   t1, 79
        sw   t1, 0(t0)
        li   t1, 75
        sw   t1, 0(t0)
        li   t1, 10
        sw   t1, 0(t0)
        li   a0, 42
done:   j    done`;

const BOOT = `# the boot ROM: copy 16 words from flash to RAM 0x400 by DMA, wait for it, jump there
        li   t0, 0x40000000
        li   t1, 0x10000000
        sw   t1, 0(t0)
        li   t1, 0x400
        sw   t1, 4(t0)
        li   t1, 16
        sw   t1, 8(t0)
        li   t1, 1
        sw   t1, 12(t0)
wait:   lw   t1, 12(t0)
        andi t1, t1, 2
        beqz t1, wait
        li   t1, 0x400
        jr   t1`;

describe('the system CPU on a bus, against the golden model', () => {
  it('loads and stores RAM over the bus, every instruction in lock-step', () => {
    const r = run(words(FIB));
    expect(r.retired).toBeGreaterThan(70);
    expect(r.ram(0x100 / 4 + 9)).toBe(89);
    expect(r.cycles).toBeGreaterThan(r.retired); // every load and store waits for the bus
  });

  it('runs code it wrote into RAM: fetched over the bus', () => {
    const r = run(words(RAM_CODE));
    expect(r.iss.x[11]).toBe(113);
    expect(r.regs()[11]).toBe(113);
  });

  it.each([1, 2, 3, 4, 5, 6])('random program %i in lock-step', (seed) => {
    run(words(randomProgram32(seed, { n: 40, sub: true, dmemWords: 32 })));
  });

  it('boots from flash: the boot ROM copies a program into RAM by DMA and jumps to it', () => {
    const r = run(words(BOOT), words(PAYLOAD), false, 20000);
    expect(r.gateConsole).toBe('OK\n');
    expect(r.iss.console).toBe('OK\n');
    expect(r.regs()[10]).toBe(42);
    expect(r.bus.copied).toBe(16);
    for (let i = 0; i < 16; i++) expect(r.ram(0x400 / 4 + i), `RAM word ${i}`).toBe(r.bus.ram[0x400 / 4 + i]);
  });
});
