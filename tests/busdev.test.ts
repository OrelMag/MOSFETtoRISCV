import { describe, expect, it } from 'vitest';
import { BusModel } from '../src/bus/model';
import { deviceIn } from '../src/dram/controller';
import { ramLeafState } from '../src/lib/bigmem';
import { busComputer, socDevices, type SocOptions, SYSTEM_COMPUTER } from '../src/lib/soc';
import { bootSource, SYSTEM_SOURCE, SYSTEM_WORDS } from '../src/bus/programs';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { randomProgram32 } from '../src/riscv/randprog32';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

// Chapter 35's computer with every slave (DRAM, screen, keyboard) at gate level, in lock-step with the
// golden model over the same map (bus/model.ts BusModel with the devices).

const IMEM_K = 8, RAM_K = 10;
const ALL: SocOptions = { imemK: IMEM_K, ramK: RAM_K, dram: true, screen: true, keys: true };
const words = (src: string) => {
  const a = assemble(src);
  if (a.errors.length) throw new Error(a.errors[0].message);
  return a.words;
};

function run(program: number[], keys: number[] = [], max = 40000, flash: number[] = [], lock = true) {
  const sim = new GateSim(flatten(busComputer(program, flash, ALL)));
  sim.reset('zero');
  sim.setInput('clk', 0); sim.setInput('switches', 0);
  const root = sim.design.root, node = (...p: string[]) => p.reduce((n, k) => n.children!.get(k)!, root);
  sim.poke(node('kbd').leafIndex!, { q: keys.slice(), clk: 0, ack: 0 });
  sim.settle();
  const bus = new BusModel(RAM_K, flash, 4096, socDevices(ALL));
  bus.keys!.push(...keys);
  const iss = new ISS(program, { system: true, imemWords: 2 ** IMEM_K, bus });
  const rf = node('cpu', 'rf');
  const out = (p: string) => pack(sim.getBits(root.ports[p]));
  const regs = () => [0, ...Array.from({ length: 31 }, (_, i) => pack(sim.getBits(rf.children!.get(`w${i + 1}`)!.ports.q)) >>> 0)];
  /** Cycles each retired instruction took (from the previous retirement), by its address. */
  const took: { pc: number; text: string; cycles: number }[] = [];
  let cycles = 0, last = 0, gateConsole = '';
  for (; cycles < max && !iss.halted; cycles++) {
    const retire = out('retire') === 1;
    if (out('consoleValid') === 1) gateConsole += String.fromCharCode(out('consoleData'));
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    if (!retire || !lock) continue;
    const info = iss.step();
    took.push({ pc: info.pc, text: info.text, cycles: cycles + 1 - last });
    last = cycles + 1;
    const x = regs();
    for (let r = 1; r < 32; r++) expect(x[r], `x${r} after ${info.text} at 0x${info.pc.toString(16)}`).toBe(iss.x[r] >>> 0);
    expect(out('pcOut') >>> 0, `pc after ${info.text}`).toBe(iss.pc >>> 0);
  }
  const dev = deviceIn(sim.leafState(node('dram', 'dev').leafIndex!))!;
  const lanes = [0, 1, 2, 3].map((i) => ramLeafState(sim, node('screen', `lane${i}`))!);
  const screen = (i: number) => ((lanes[0].mem[i] | (lanes[1].mem[i] << 8) | (lanes[2].mem[i] << 16) | (lanes[3].mem[i] << 24)) >>> 0);
  const kq = (sim.leafState(node('kbd').leafIndex!) as { q: number[] }).q;
  return { iss, bus, dev, screen, kq, took, cycles, gateConsole };
}

const DRAM = `# words, halfwords and bytes in DRAM; two rows of one bank, then the other bank
        li   s0, 0x20000000
        li   t0, 0x11223344
        sw   t0, 0(s0)
        li   t1, 0xAB
        sb   t1, 1(s0)
        li   t1, -2
        sh   t1, 6(s0)
        lw   a0, 0(s0)
        lbu  a1, 1(s0)
        lh   a2, 6(s0)
        lw   a3, 4(s0)
        li   t2, 0x200
        add  t2, s0, t2
        sw   t0, 0(t2)
        lw   a4, 0(t2)
        lw   a5, 0(s0)
        sw   a5, 64(s0)
        lb   a6, 65(s0)
done:   j    done`;

const SCREEN_KEYS = `# a pixel row on the screen, then two keys from the keyboard to the console
        li   s0, 0x50000000
        li   t0, 0
        li   t1, 64
row:    sb   t0, 128(s0)
        addi s0, s0, 1
        addi t0, t0, 3
        addi t1, t1, -1
        bnez t1, row
        li   s1, 0x60000000
        li   s2, 0x80000000
        li   t2, 2
key:    lw   t0, 4(s1)
        andi t0, t0, 1
        beqz t0, key
        lw   a0, 0(s1)
        sw   a0, 0(s2)
        addi t2, t2, -1
        bnez t2, key
        lw   a1, 0(s1)
        lw   a2, 4(s1)
done:   j    done`;

describe('chapter 35\'s computer with DRAM, screen and keyboard, against the golden model', () => {
  it('DRAM: words, halfwords and bytes (the data mask), in lock-step', () => {
    const r = run(words(DRAM));
    expect(r.iss.x[10]).toBe(0x1122ab44);
    expect(r.iss.x[12] >>> 0).toBe(0xfffffffe);
    expect(r.iss.x[16] >>> 0).toBe(0xffffffab); // 0xAB sign-extended
    for (let i = 0; i < 32; i++) expect(r.dev.read(i), `DRAM word ${i}`).toBe(r.bus.dram![i]);
    expect(r.dev.read(0x200 / 4)).toBe(0x11223344);
    expect(r.dev.err).toBe(false);
  });

  it('DRAM: a load costs the bus and the controller (row hit, closed bank, row conflict)', () => {
    const r = run(words(DRAM));
    // the first store finds bank 0 closed (ACT first), the next accesses hit its open row; 0x200 is another
    // row of bank 0 (a conflict: PRE, ACT), and so is the way back to 0; 0x40 is the first line of bank 1 (closed)
    const dram = r.took.filter((t) => /^(lw|sw|sb|sh|lb|lh)/.test(t.text) && t.pc >= 4 * 3).map((t) => `${t.text.split(' ')[0]} ${t.cycles}`);
    expect(dram).toEqual(['sw 14', 'sb 10', 'sh 10', 'lw 10', 'lbu 10', 'lh 10', 'lw 10', 'sw 18', 'lw 10', 'lw 18', 'sw 14', 'lb 10']);
  });

  it('the screen takes byte stores; the keyboard gives its keys in order, then 0', () => {
    const r = run(words(SCREEN_KEYS), [72, 105]);
    for (let i = 0; i < 16; i++) expect(r.screen(32 + i), `screen word ${32 + i}`).toBe(r.bus.screen![32 + i]);
    expect(r.screen(32)).toBe(0x09060300);
    expect(r.iss.console).toBe('Hi');
    expect(r.iss.x[11]).toBe(0);
    expect(r.iss.x[12]).toBe(0);
    expect(r.kq).toEqual([]);
  });

  it.each([1, 2, 3])('random program %i with its data in DRAM, in lock-step', (seed) => {
    // accesses from the base register (s11) go to DRAM, those computed from a register (andi) stay in RAM
    const src = randomProgram32(seed, { n: 40, sub: true, dmemWords: 32 });
    expect(src).toContain('li s11, 64');
    const r = run(words(src.replace('li s11, 64', 'li s11, 0x20000040')));
    expect(r.dev.err).toBe(false);
  });

  it("the chapter's last computer boots from flash, then keys go to the console, DRAM and the screen", () => {
    expect(SYSTEM_COMPUTER.id).toBe(busComputer(words(bootSource(SYSTEM_WORDS)), words(SYSTEM_SOURCE), { dram: true, screen: true, keys: true }).id);
    const keys = [...'ab\n'].map((c) => c.charCodeAt(0));
    const r = run(words(bootSource(SYSTEM_WORDS)), keys, 4000, words(SYSTEM_SOURCE), false);
    expect(r.gateConsole).toBe('>ab\nba\n>');
    expect(r.dev.read(0)).toBe(97);
    expect(r.dev.read(1)).toBe(98);
    // a's block: cell 0, its colour in every byte; b's in cell 1 (8 pixels = 2 words to the right)
    expect(r.screen(0)).toBe(0x61616161);
    expect(r.screen(16 * 7 + 1)).toBe(0x61616161);
    expect(r.screen(2)).toBe(0x62626262);
    expect(r.screen(16 * 8)).toBe(0);
  });
});
