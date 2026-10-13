// Our 6502's register-transfer model (the design the transistors implement) against the ISS and
// SingleStepTests: every bus cycle, then the registers once the instruction's overlap has finished.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPCODES } from '../src/m6502/isa';
import { assemble, toImage } from '../src/m6502/asm';
import { Cpu6502, Ram64 } from '../src/m6502/iss';
import { PROGRAMS } from '../src/m6502/programs';
import { Rtl6502 } from '../src/m6502/rtl';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
type State = [pc: number, s: number, a: number, x: number, y: number, p: number, ram: number[]];
type Case = [initial: State, final: State, cycles: number[]];

/** One SingleStepTests case on the RTL model; the first difference, or null. */
export function rtlCase(ram: Ram64, [init, fin, cycles]: Case): string | null {
  for (let i = 0; i < init[6].length; i += 2) ram.mem[init[6][i]] = init[6][i + 1];
  const cpu = new Rtl6502(ram);
  cpu.boundary({ pc: init[0], s: init[1], a: init[2], x: init[3], y: init[4], p: init[5] });
  let err: string | null = null;
  const n = cycles.length / 3;
  const h = (v: number) => v.toString(16);
  for (let i = 0; i < n && !err; i++) {
    cpu.cycle();
    const [addr, data, w] = [cycles[3 * i], cycles[3 * i + 1], cycles[3 * i + 2]];
    if (cpu.addr !== addr || cpu.data !== data || cpu.write !== (w === 1))
      err = `cycle ${i}: got ${h(cpu.addr)} ${h(cpu.data)} ${cpu.write ? 'w' : 'r'}, want ${h(addr)} ${h(data)} ${w ? 'w' : 'r'}`;
    if (!err && cpu.sync !== (i === 0 ? 1 : 0)) err = `cycle ${i}: sync ${cpu.sync}`;
  }
  if (!err) {
    // the next fetch finishes the instruction; an ALU result lands a cycle later
    cpu.cycle();
    if (cpu.sync !== 1) err = `no fetch after ${n} cycles (t = ${cpu.t})`;
    else if (cpu.addr !== fin[0]) err = `next fetch at ${h(cpu.addr)}, want pc ${h(fin[0])}`;
    cpu.cycle();
  }
  if (!err) {
    const got = [cpu.s, cpu.a, cpu.x, cpu.y, cpu.p];
    const names = ['s', 'a', 'x', 'y', 'p'];
    for (let k = 0; k < 5 && !err; k++) if (got[k] !== fin[k + 1]) err = `${names[k]} = ${h(got[k])}, want ${h(fin[k + 1] as number)}`;
    for (let i = 0; i < fin[6].length && !err; i += 2)
      if (ram.mem[fin[6][i]] !== fin[6][i + 1]) err = `ram[${h(fin[6][i])}] = ${ram.mem[fin[6][i]]}, want ${fin[6][i + 1]}`;
  }
  ram.mem.fill(0);
  return err;
}

describe('RTL model: SingleStepTests sample', () => {
  const sample = JSON.parse(readFileSync(here('./m6502/singlestep-sample.json'), 'utf8')) as Record<string, Case[]>;
  const ram = new Ram64();
  for (const o of OPCODES) {
    if (!o) continue;
    const key = o.op.toString(16).padStart(2, '0');
    it(`${key} ${o.mnemonic} ${o.mode}`, () => {
      const bad = sample[key].map((c, i) => [i, rtlCase(ram, c)] as const).filter(([, e]) => e);
      expect(bad.slice(0, 3).map(([i, e]) => `#${i}: ${e}`)).toEqual([]);
    });
  }
});

const CACHE = here('./m6502/.cache/');
interface RawState { pc: number; s: number; a: number; x: number; y: number; p: number; ram: [number, number][] }
interface RawCase { initial: RawState; final: RawState; cycles: [number, number, string][] }
const state = (s: RawState): State => [s.pc, s.s, s.a, s.x, s.y, s.p, s.ram.flat()];

describe.skipIf(!existsSync(CACHE + 'a9.json'))('RTL model: full SingleStepTests (cached)', () => {
  const ram = new Ram64();
  for (const o of OPCODES) {
    if (!o) continue;
    const key = o.op.toString(16).padStart(2, '0');
    it(`${key} ${o.mnemonic} ${o.mode}`, () => {
      const cases = JSON.parse(readFileSync(CACHE + `${key}.json`, 'utf8')) as RawCase[];
      const bad: string[] = [];
      for (const [i, t] of cases.entries()) {
        const e = rtlCase(ram, [state(t.initial), state(t.final), t.cycles.flatMap(([a, d, k]) => [a, d, k === 'write' ? 1 : 0])]);
        if (e && bad.push(`#${i}: ${e}`) >= 3) break;
      }
      expect(bad).toEqual([]);
    });
  }
});

/** The RTL model and the ISS from reset, every cycle, with interrupt lines driven by `lines(cycle)`. */
function lockstep(image: Uint8Array, cycles: number, lines: (c: number) => { irq: boolean; nmi: boolean }): string | null {
  const ra = new Ram64(), rb = new Ram64();
  ra.mem.set(image); rb.mem.set(image);
  const iss = new Cpu6502(ra), rtl = new Rtl6502(rb);
  iss.reset(); rtl.reset();
  const h = (v: number) => v.toString(16);
  for (let c = 0; c < cycles; c++) {
    const l = lines(c);
    iss.irq = rtl.irq = l.irq; iss.nmi = rtl.nmi = l.nmi;
    iss.tick(); rtl.cycle();
    if (iss.busAddr !== rtl.addr || iss.busData !== rtl.data || iss.busWrite !== rtl.write || iss.busSync !== rtl.sync)
      return `cycle ${c}: iss ${h(iss.busAddr)} ${h(iss.busData)} ${iss.busWrite ? 'w' : 'r'} s${iss.busSync}, ` +
        `rtl ${h(rtl.addr)} ${h(rtl.data)} ${rtl.write ? 'w' : 'r'} s${rtl.sync} (ir ${h(iss.ir)} t ${rtl.t})`;
  }
  return null;
}

/** Deterministic pseudo-random lines: pulses of IRQ (held until acknowledged by the program) and NMI edges. */
function randomLines(seed: number, irqRate: number, nmiRate: number) {
  let x = seed, irq = false, nmi = false;
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  return () => {
    if (rnd() < irqRate) irq = !irq;
    if (rnd() < nmiRate) nmi = !nmi;
    return { irq, nmi };
  };
}

describe('RTL model: lock-step with the ISS from reset', () => {
  for (const p of PROGRAMS) {
    it(p.name, () => {
      const img = toImage(assemble(p.source));
      expect(lockstep(img, 20000, () => ({ irq: false, nmi: false }))).toBeNull();
    });
    it(`${p.name} with random IRQ / NMI`, () => {
      const img = toImage(assemble(p.source));
      for (let seed = 1; seed <= 20; seed++) expect(lockstep(img, 5000, randomLines(seed, 0.02, 0.01)), `seed ${seed}`).toBeNull();
    });
  }
});
