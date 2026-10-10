// Large memories in the sandbox: RAM / ROM parts of up to 2^16 words compile at once, read live
// from the leaf's state, and a CPU whose data memory is a 64K-word RAM runs in lock-step with the ISS.

import { describe, expect, it } from 'vitest';
import { compileChip } from '../src/editor/compile';
import { CpuMonitor, readMem } from '../src/editor/cpu';
import { UserLibrary } from '../src/editor/library';
import { readRam, romImage } from '../src/editor/memory';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { isError, MAX_RAM_K, MAX_ROM_K, partDef } from '../src/editor/parts';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { bigRam, isRamState, ramLeafState } from '../src/lib/bigmem';
import { singleCycleCpu } from '../src/lib/cpu';
import { ram } from '../src/lib/memory';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { netlistOf } from '../src/sim/types';
import { chip, part, pin, wire } from './editorkit';

const def = (ref: Parameters<typeof partDef>[0]) => {
  const d = partDef(ref, () => undefined);
  if (isError(d)) throw new Error(d.error);
  return d;
};

/** A chip with one RAM part wired to its pins. */
function ramChip(k: number, w: number, init?: number[]): ChipDoc {
  return chip('u_bigram', 'big RAM', {
    pins: [pin('addr', 'in', [0, 2], k), pin('din', 'in', [0, 4], w), pin('we', 'in', [0, 6]), pin('clk', 'in', [0, 8]), pin('dout', 'out', [40, 4], w)],
    parts: [part('mem', { ram: { k, w, ...(init ? { init } : {}) } }, [10, 0])],
    wires: [wire('w1', 'pin:addr', 'mem.addr'), wire('w2', 'pin:din', 'mem.din'), wire('w3', 'pin:we', 'mem.we'), wire('w4', 'pin:clk', 'mem.clk'), wire('w5', 'mem.dout', 'pin:dout')],
  });
}

describe('RAM and ROM parts up to 2^16 words', () => {
  it('sizes: 2^1 … 2^16; past 2^6 the RAM is the large one (with its initial words), ports unchanged', () => {
    expect([MAX_RAM_K, MAX_ROM_K]).toEqual([16, 16]);
    expect(def({ ram: { k: 6, w: 8 } })).toBe(ram(6, 8));
    expect(def({ ram: { k: 7, w: 8 } })).toBe(bigRam(7, 8));
    const d = def({ ram: { k: 16, w: 32, init: [5, 6] } });
    expect(d.id).toMatch(/^ram65536x32_i/);
    expect(d.ports.map((p) => `${p.name}:${p.width}`)).toEqual(['addr:16', 'din:32', 'we:1', 'clk:1', 'dout:32']);
    expect(isError(partDef({ ram: { k: 17, w: 8 } }, () => undefined))).toBe(true);
  });

  it('a 64K × 32 RAM compiles and simulates at once; readRam reads the leaf state', () => {
    const doc = ramChip(16, 32, [0x11, 0x22]);
    let t = performance.now();
    const c = compileChip(doc, (ref) => partDef(ref, () => undefined));
    const compileMs = performance.now() - t;
    expect(c.diags.filter((x) => x.level === 'error')).toEqual([]);
    t = performance.now();
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, doc.pins);
    es.flush();
    const simMs = performance.now() - t;
    expect(compileMs + simMs).toBeLessThan(1000);
    const sim = es.sim!;
    expect(sim.design.leaves).toHaveLength(1);
    expect(isRamState(ramLeafState(sim, sim.design.root.children!.get('mem')))).toBe(true);
    const words = readRam(sim, 'mem')!;
    expect(words).toHaveLength(65536);
    expect(words.slice(0, 3)).toEqual([0x11, 0x22, 0]);
    // a write through the pins shows in readRam
    sim.setInput('addr', 0xfedc); sim.setInput('din', 0xcafef00d); sim.setInput('we', 1); sim.setInput('clk', 0); sim.settle();
    sim.setInput('clk', 1); sim.settle();
    expect(readRam(sim, 'mem')![0xfedc]).toBe(0xcafef00d);
  });

  it('a 64K-word ROM: a program at the far end builds and reads back', () => {
    const src = `${'nop\n'.repeat(60000)}li a0, 5\nhalt: j halt\n`;
    const r = { k: 16, w: 32 as const, addr: 'rv32' as const, lang: 'asm' as const, src };
    const img = romImage(r);
    expect(img.error).toBeNull();
    const t = performance.now();
    const d = def({ rom: r });
    expect(performance.now() - t).toBeLessThan(1000);
    expect(d.behavior!.eval([4 * 60000], undefined)[0]).toBe(assemble('li a0, 5').words[0]);
    expect(d.behavior!.eval([4 * 65535], undefined)[0]).toBe(0x13);
    expect(netlistOf(d)!.instances.filter((i) => i.name.startsWith('bank'))).toHaveLength(16);
    // too long for the ROM: located on its line
    expect(romImage({ ...r, k: 15 }).error).toMatch(/do not fit in 2\^15/);
  });
});

/** The single-cycle CPU opened in the sandbox, its data memory replaced by a chip around a 64K × 32 RAM. */
function cpuWithBigDmem(words: number[]): { ws: Workspace; id: string; es: EditorSim; lib: UserLibrary } {
  const r = remixDef(emptyWorkspace(), singleCycleCpu(words));
  if ('error' in r) throw new Error(r.error);
  const dm = chip('u_bigdm', 'Big data memory', {
    pins: [pin('addr', 'in', [0, 2], 32), pin('wd', 'in', [0, 6], 32), pin('we', 'in', [0, 8]), pin('clk', 'in', [0, 10]), pin('rd', 'out', [40, 4], 32)],
    parts: [part('sa', { split: [2, 16, 14] }, [6, 1]), part('ram', { ram: { k: 16, w: 32 } }, [14, 0])],
    wires: [
      wire('a', 'pin:addr', 'sa.in'), wire('i', 'sa.o1', 'ram.addr'), wire('d', 'pin:wd', 'ram.din'),
      wire('e', 'pin:we', 'ram.we'), wire('c', 'pin:clk', 'ram.clk'), wire('q', 'ram.dout', 'pin:rd'),
    ],
  });
  const cpu = r.ws.chips[r.id];
  expect(cpu.parts.find((p) => p.id === 'dm')).toBeDefined();
  const doc: ChipDoc = { ...cpu, parts: cpu.parts.map((p) => (p.id === 'dm' ? { ...p, ref: { chip: dm.id } } : p)) };
  const ws: Workspace = { ...r.ws, chips: { ...r.ws.chips, [dm.id]: dm, [r.id]: doc } };
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  const c = lib.compiled(r.id)!;
  expect(c.diags.filter((x) => x.level === 'error')).toEqual([]);
  es.update(c, doc.pins);
  es.flush();
  return { ws, id: r.id, es, lib };
}

// Stores far apart (word 0, 0x1000, the last word 0xFFFF, a table at 0x8000), loads that read them
// back, and a wrap-around at 256 KiB, as both the hardware and the ISS (65 536 words) wrap.
const FAR = `
        li   t0, 0x3fffc        # the last word
        li   t1, 0x12345678
        sw   t1, 0(t0)
        li   t2, 0x4000
        li   t3, 77
        sw   t3, 0(t2)
        li   s0, 0x20000        # a table of 8 squares at word 0x8000
        li   s1, 0
fill:   add  a2, s1, s1
        sw   a2, 0(s0)
        addi s0, s0, 4
        addi s1, s1, 1
        li   a3, 8
        blt  s1, a3, fill
        li   s0, 0x20000
        li   a0, 0
        li   s1, 0
sum:    lw   a4, 0(s0)
        add  a0, a0, a4
        addi s0, s0, 4
        addi s1, s1, 1
        blt  s1, a3, sum
        lw   a5, 0(t0)
        li   t4, 0x40008        # wraps to word 2
        sw   a0, 0(t4)
        lw   a6, 8(zero)
halt:   j    halt
`;

describe('a CPU with a 64K-word data memory, in lock-step with the ISS', { timeout: 120000 }, () => {
  for (const [name, src] of [['far stores and a wrap-around', FAR], ['bubble sort', PROGRAMS.find((p) => p.id === 'sort')!.source]] as const) {
    it(`${name}: runs to halt with no mismatch; the memory as the ISS ends`, () => {
      const words = assemble(src).words;
      const c = cpuWithBigDmem(words);
      const m = new CpuMonitor(c.es, () => c.ws.chips[c.id], () => c.ws.chips);
      expect(m.desc?.dmem).toBe('dm');
      expect(m.checking).toBe(true);
      while (!m.done && c.es.cycles < 3000) m.runToHalt(Infinity);
      expect(m.mismatch).toBeNull();
      expect(m.iss!.halted).toBe(true);
      const g = new ISS(words, { dmemWords: 65536 });
      g.run(100000);
      const mem = readMem(c.es.sim!, 'dm')!;
      expect(mem).toHaveLength(65536);
      expect(mem).toEqual([...g.dmem].map((v) => v >>> 0));
      if (name.startsWith('far')) {
        expect([mem[0xffff], mem[0x1000], mem[2], mem[0x8007]]).toEqual([0x12345678, 77, 56, 14]);
        expect(m.read()!.x![16]).toBe(56); // a6: read back through the wrap
      }
    });
  }
});
