// The sandbox's CPU panel beyond one flat CPU: parts inside chips (the instruction cache's ROM),
// fcsr and data memory checked against the golden model, the system CPU's I/O (console, LEDs,
// switches, interrupt line) and the dual-core against the multi-hart model.

import { describe, expect, it } from 'vitest';
import { CpuMonitor, detectCpu, mismatchText } from '../src/editor/cpu';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { detectMulti, MultiMonitor } from '../src/editor/multicpu';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { singleCycleCpu } from '../src/lib/cpu';
import { dualCore } from '../src/lib/multicore';
import { systemCpu } from '../src/lib/system';
import { assemble } from '../src/riscv/asm';
import { CACHE_CPU_PROGRAMS } from '../src/riscv/cprograms';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { ISS } from '../src/riscv/iss';
import { MC_PROGRAMS } from '../src/riscv/mcprograms';
import { MultiISS } from '../src/riscv/multi';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import type { ComponentDef } from '../src/sim/types';

/** A remixed circuit running in an EditorSim, as the sandbox runs it. */
function open(def: ComponentDef): { doc: () => ChipDoc; chips: () => Workspace['chips']; es: EditorSim } {
  const r = remixDef(emptyWorkspace(), def);
  if ('error' in r) throw new Error(r.error);
  const ws = r.ws;
  const es = new EditorSim({ debounceMs: 0 });
  es.update(new UserLibrary(ws).compiled(r.id)!, ws.chips[r.id].pins);
  return { es, doc: () => ws.chips[r.id], chips: () => ws.chips };
}

const words = (src: string) => assemble(src).words;
const golden = (w: number[], opts = {}) => {
  const iss = new ISS(w, opts);
  iss.run(100000);
  return iss;
};

describe('CPUs whose parts sit inside chips; more of the state checked', { timeout: 120000 }, () => {
  it('instruction cache: the ROM is found inside the cache chip and the program runs to halt', () => {
    const w = words(CACHE_CPU_PROGRAMS[0].source);
    const c = open(singleCycleCpu(w, { icache: true, adder: 'ks' }));
    expect(detectCpu(c.doc())).toBeNull(); // without the workspace's chips there is nothing to follow
    expect(detectCpu(c.doc(), c.chips())).toMatchObject({ rom: 'imem.rom', pc: { pin: 'pcOut' }, regs: 'rf', dmem: 'dm', retire: { pin: 'retire' } });
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    expect(m.checking).toBe(true);
    expect(m.prog!.words.slice(0, w.length)).toEqual(w);
    while (!m.done && c.es.cycles < 20000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    const g = golden(w);
    expect(m.read()!.x).toEqual([...g.x].map((v) => v >>> 0));
    expect(c.es.cycles).toBeGreaterThan(g.steps); // fetch misses stall
  });

  it('instruction cache and a write-back data cache: memory as the program sees it', () => {
    const w = words(CACHE_CPU_PROGRAMS[0].source);
    const c = open(singleCycleCpu(w, { dmemK: 6, dcache: 'wb', icache: true }));
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    while (!m.done && c.es.cycles < 30000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    expect(m.read()!.dmem).toEqual([...golden(w, { dmemWords: 64 }).dmem]);
  });

  it('FPU: the f registers and fcsr follow the model', () => {
    const w = words(F_PROGRAMS.find((p) => p.id === 'flags')!.source);
    const c = open(singleCycleCpu(w, { fpu: true }));
    expect(detectCpu(c.doc(), c.chips())).toMatchObject({ fregs: 'frf', fcsr: 'fcsr' });
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    while (!m.done && c.es.cycles < 20000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    expect(m.iss!.fflags).not.toBe(0);
    expect(m.read()!.fcsr).toBe((m.iss!.frm << 5) | m.iss!.fflags);
  });

  it('an fcsr that differs from the model is reported', () => {
    const w = words(F_PROGRAMS.find((p) => p.id === 'flags')!.source);
    const c = open(singleCycleCpu(w, { fpu: true }));
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    m.stepInstr();
    m.iss!.frm = 3;
    m.stepInstr();
    expect(m.mismatch).toMatchObject({ what: 'fcsr', expected: 3 << 5 });
  });

  it('a data memory that differs from the model is reported after the next store', () => {
    const w = words(PROGRAMS.find((p) => p.id === 'fib')!.source);
    const c = open(singleCycleCpu(w));
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    m.stepInstr();
    m.iss!.dmem[31] = 0xdead; // the model's memory goes its own way
    while (!m.done && c.es.cycles < 2000) m.runToHalt(Infinity);
    expect(m.mismatch).toMatchObject({ what: 'mem', name: 'memory [0x7c]', expected: 0xdead, got: 0 });
    expect(mismatchText(m.mismatch!)).toMatch(/^memory \[0x7c\] after “.+”, cycle \d+: expected 0x0000dead, got 0x00000000$/);
  });
});

describe('system CPU: console, LEDs, switches and the interrupt line against the model', { timeout: 120000 }, () => {
  const sys = (id: string) => open(systemCpu(words(SYSTEM_PROGRAMS.find((p) => p.id === id)!.source)));
  const pin = (c: ReturnType<typeof open>, name: string) => c.doc().pins.find((p) => p.name === name)!;

  it('the console prints what the model prints', () => {
    const c = sys('hello');
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    expect(m.desc!.iss.system).toBe(true);
    while (!m.done && c.es.cycles < 20000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    expect(m.console.length).toBeGreaterThan(3);
    expect(m.console).toBe(m.iss!.console);
  });

  it('switches in, LEDs out', () => {
    const c = sys('leds');
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    c.es.setInput(pin(c, 'switches'), 0xa5);
    c.es.runCycles(30);
    expect(m.mismatch).toBeNull();
    expect(m.leds).toBe(0xa5);
    c.es.setInput(pin(c, 'switches'), 0x3c);
    c.es.runCycles(30);
    expect(m.mismatch).toBeNull();
    expect(m.leds).toBe(0x3c);
    expect(m.iss!.leds).toBe(0x3c);
  });

  it('an interrupt request for one cycle runs the handler in both', () => {
    const c = sys('irq');
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    c.es.runCycles(20);
    c.es.setInput(pin(c, 'irq'), 1);
    c.es.runCycles(1);
    c.es.setInput(pin(c, 'irq'), 0);
    c.es.runCycles(30);
    expect(m.mismatch).toBeNull();
    expect(m.leds).toBe(0xff);
    expect(m.read()!.x![9]).toBe(1); // s1: one press
  });

  it('a console the model did not print is reported', () => {
    const c = sys('hello');
    const m = new CpuMonitor(c.es, c.doc, c.chips);
    m.stepInstr();
    m.console = 'X';
    while (!m.done && c.es.cycles < 20000) m.runToHalt(Infinity);
    expect(m.mismatch?.what).toBe('console');
    expect(mismatchText(m.mismatch!)).toMatch(/^console: expected ".*", got "X.*" \(after “.+”, cycle \d+\)$/);
  });
});

describe('dual-core: two cores against the multi-hart model', { timeout: 120000 }, () => {
  for (const p of MC_PROGRAMS) {
    it(`${p.id}: runs to halt with no mismatch`, () => {
      const w = words(p.source);
      const c = open(dualCore(w));
      expect(detectCpu(c.doc(), c.chips())).toBeNull();
      const d = detectMulti(c.doc(), c.chips())!;
      expect(d.cores.map((k) => k.part)).toEqual(['core0', 'core1']);
      expect(d).toMatchObject({ dmem: 'dm', cores: [{ rom: 'core0.imem', regs: 'core0.rf', pc: { part: 'core0', port: 'pcOut' }, retire: { part: 'core0', port: 'retire' } }, {}] });
      const m = new MultiMonitor(c.es, c.doc, c.chips);
      expect(m.checking).toBe(true);
      while (!m.done && c.es.cycles < 5000) m.runToHalt(Infinity);
      expect(m.mismatch).toBeNull();
      expect(m.m!.halted).toBe(true);
      const g = new MultiISS(w);
      while (!g.halted && g.cycles < 5000) g.step();
      expect(m.readMem()).toEqual([...g.dmem]);
      m.read().forEach((r, i) => expect(r.x).toEqual([...g.harts[i].x].map((v) => v >>> 0)));
      expect(m.log.some((e) => e.hart === 1)).toBe(true);
    });
  }

  it('a core that loses arbitration in the model but not in the hardware is reported', () => {
    const c = open(dualCore(words(MC_PROGRAMS[0].source)));
    const m = new MultiMonitor(c.es, c.doc, c.chips);
    m.m!.priority = 1; // the model's arbiter starts on the other core
    while (!m.done && c.es.cycles < 5000) m.runToHalt(Infinity);
    expect(m.mismatch).not.toBeNull();
    expect(mismatchText(m.mismatch!)).toMatch(/^core \d: /);
  });
});
