// FastISS against the golden model, in lock step: after every step the PC, registers, cycle count,
// trap CSRs and halt flag agree, and the data memory agrees whenever either stored. Programs: the
// official riscv-tests (system env p and bare), seeded random programs of every option set the
// golden model is fuzzed with (system ones with timer interrupts and external irq pulses).

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { ISS, mExec, type IssOptions } from '../src/riscv/iss';
import { FastISS, mulhu } from '../src/riscv/fastiss';
import { randomProgram32, type Rand32Options } from '../src/riscv/randprog32';
import { images, loadable } from './verify/images';

function lockStep(words: number[], opts: IssOptions, maxSteps: number, irqAt?: (step: number) => boolean | undefined): { steps: number; diff: string } {
  const g = new ISS(words, opts), f = new FastISS(words, opts);
  for (let s = 0; s < maxSteps; s++) {
    const irq = irqAt?.(s);
    if (irq !== undefined) g.irq = f.irq = irq;
    const pc = g.pc, info = g.step();
    f.step();
    const where = `step ${s} pc 0x${pc.toString(16)} ${info.text}`;
    if (f.pc !== g.pc) return { steps: s, diff: `${where}: pc 0x${f.pc.toString(16)} ≠ 0x${g.pc.toString(16)}` };
    for (let r = 0; r < 32; r++) if (f.x[r] !== g.x[r]) return { steps: s, diff: `${where}: x${r} 0x${f.x[r].toString(16)} ≠ 0x${g.x[r].toString(16)}` };
    for (const k of ['mtime', 'mepc', 'mcause', 'mtval', 'mie', 'mpie', 'mtie', 'meie', 'mtvec', 'mscratch', 'mtimecmp', 'leds', 'retired', 'steps', 'halted', 'console'] as const) {
      if (f[k] !== g[k]) return { steps: s, diff: `${where}: ${k} ${String(f[k])} ≠ ${String(g[k])}` };
    }
    if (info.store || info.trap) {
      for (let i = 0; i < g.dmem.length; i++) if (f.dmem[i] !== g.dmem[i]) return { steps: s, diff: `${where}: dmem[${i}] 0x${f.dmem[i].toString(16)} ≠ 0x${g.dmem[i].toString(16)}` };
    }
    if (g.halted) return { steps: s + 1, diff: '' };
  }
  return { steps: maxSteps, diff: '' };
}

describe('FastISS', () => {
  it('mulhu and the M results equal the golden model on edge and random operands', () => {
    const edge = [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 0x12345678, 0xdeadbeef, 0x10000, 0xffff];
    let seed = 1;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
    const ops: [number, number][] = [];
    for (const a of edge) for (const b of edge) ops.push([a, b]);
    for (let i = 0; i < 2000; i++) ops.push([rnd(), rnd()]);
    for (const [a, b] of ops) expect(mulhu(a, b)).toBe(mExec(3, a, b));
    // the other M results through a program: mul, mulh, mulhsu, mulhu, div, divu, rem, remu of t0, t1
    const src = ops.slice(0, 200).map(([a, b]) => `li t0, ${a | 0}\n li t1, ${b | 0}\n` + ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'].map((o, k) => ` ${o} a${k}, t0, t1`).join('\n')).join('\n') + '\nend: j end';
    const prog = assemble(src);
    expect(prog.errors).toEqual([]);
    const r = lockStep(prog.words, { m: true, imemWords: 1 << 13, system: true }, 100_000);
    expect(r.diff).toBe('');
  });

  for (const env of ['p', 'bare'] as const) {
    it(`runs every riscv-tests ${env} image in lock step with the golden model`, () => {
      const bad: string[] = [];
      for (const img of images(env)) {
        if (img.suite === 'rv32uf') continue; // no F
        const l = loadable(img);
        const r = lockStep(l.words, { system: env === 'p', m: true, imemWords: 2 ** l.imemK, dmemWords: 2 ** l.dmemK }, 20_000);
        if (r.diff) bad.push(`${img.name}: ${r.diff}`);
      }
      expect(bad).toEqual([]);
    });
  }

  const sets: [string, Rand32Options, IssOptions][] = [
    ['RV32I', {}, {}],
    ['RV32I + sub-word', { sub: true }, {}],
    ['RV32IM', { sub: true, m: true }, { m: true }],
    ['RV32I + atomics / hart id', { mp: true }, { hartid: 3 }],
    ['system RV32IM', { sub: true, m: true, system: true }, { system: true, m: true }],
    ['system RV32I (M illegal)', { sub: true, system: true }, { system: true }],
  ];
  for (const [name, ro, io] of sets) {
    it(`runs random ${name} programs in lock step with the golden model`, () => {
      const bad: string[] = [];
      for (let seed = 1; seed <= 150; seed++) {
        const prog = assemble(randomProgram32(seed, { n: 80, ...ro }));
        if (prog.errors.length) throw new Error(`seed ${seed}: ${prog.errors[0].message}`);
        const irqAt = io.system ? (s: number) => (s % 97 === 40 ? true : s % 97 === 44 ? false : undefined) : undefined;
        const r = lockStep(prog.words, { ...io, imemWords: 1 << 11, dmemWords: 32 }, 50_000, irqAt);
        if (r.diff) bad.push(`seed ${seed}: ${r.diff}`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('run(n) in one call equals n single steps', () => {
    const prog = assemble(randomProgram32(7, { n: 120, sub: true, m: true, system: true }));
    const a = new FastISS(prog.words, { system: true, m: true, imemWords: 1 << 11 });
    const b = new FastISS(prog.words, { system: true, m: true, imemWords: 1 << 11 });
    a.run(3000);
    for (let i = 0; i < 3000 && !b.halted; i++) b.step();
    expect([...a.x]).toEqual([...b.x]);
    expect([a.pc, a.mtime, a.retired, a.steps]).toEqual([b.pc, b.mtime, b.retired, b.steps]);
    expect([...a.dmem]).toEqual([...b.dmem]);
  });
});
